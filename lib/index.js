/**
 * dsh-sidecar — fire focused subagents in the background and let the parent
 * review their results on its own schedule.
 *
 * Delivery deliberately avoids the inbox queue: completion is an
 * `agent.inject()` notice (next-step, no wake), so it never starts a turn and
 * never looks like a user message. The full result stays on disk and is read
 * through `sidecar_result` (task + answer + evidence) or `sidecar_log`
 * (complete transcript) when the parent decides to review.
 *
 * Each sidecar gets a unique name, its own child session (title pinned to the
 * name) and its own space — parent cwd, `--cwd <dir>`, or an isolated git
 * worktree (`--worktree`).
 *
 * Separate from dsh-autocontinue and the dsh updater.
 *
 * @module dsh-sidecar
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'sidecar'

export const inject = ['agents', 'commands', 'tools']

const DEBUG_FILE = '/tmp/dsh-sidecar.log'

function renderThrown(value) {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message
  return String(value)
}

function shorten(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function outputText(result) {
  const blocks = result?.output
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Flatten one message's text blocks. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Render a child session log as a readable transcript for `sidecar_log`. */
function formatFullTranscript(events) {
  const lines = []
  let total = 0
  const cap = 60000
  const push = (line) => {
    if (total + line.length > cap) return false
    lines.push(line)
    total += line.length + 1
    return true
  }
  const trim = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`)
  for (const event of events) {
    if (total > cap) break
    if (event.type === 'user/message') {
      const text = messageText(event.data)
      if (text !== '') push(`[user]\n${trim(text, 4000)}`)
    } else if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          push(`[assistant]\n${trim(block.text, 4000)}`)
        } else if (block?.type === 'tool-call') {
          push(`[tool call] ${block.name ?? '?'}\n${trim(String(block.arguments ?? ''), 3000)}`)
        } else if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
          push(`[thinking]\n${trim(block.text, 1200)}`)
        }
      }
    } else if (event.type === 'tool/result') {
      const text = messageText(event.data?.message)
      if (text !== '') push(`[tool result]${event.data?.message?.isError === true ? ' (error)' : ''}\n${trim(text, 4000)}`)
    }
  }
  if (total > cap) lines.push('… (transcript truncated; the child session has the complete log)')
  return lines.join('\n\n')
}

/** One-line summary of a tool call's arguments. */
function summarizeArgs(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText)
    if (typeof parsed?.command === 'string') return shorten(parsed.command, 160)
    if (typeof parsed?.description === 'string') return shorten(parsed.description, 160)
    return shorten(JSON.stringify(parsed), 160)
  } catch {
    return shorten(String(argumentsText ?? ''), 160)
  }
}

/** The compact evidence trail: each tool call and its result, in order. */
function formatEvidence(events) {
  const calls = []
  const byId = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      const call = { id: data.callId, name: data.name ?? 'tool', args: summarizeArgs(data.arguments), result: undefined, error: false }
      calls.push(call)
      if (call.id !== undefined) byId.set(call.id, call)
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const call = message?.toolCallId !== undefined ? byId.get(message.toolCallId) : undefined
      if (call === undefined) continue
      const text = messageText(message)
      call.result = text !== '' ? shorten(text, 400) : '(no output)'
      call.error = message?.isError === true
    }
  }
  if (calls.length === 0) return '(no tool calls recorded)'
  const lines = []
  let total = 0
  for (const call of calls) {
    const line = call.result === undefined
      ? `- ${call.name}(${call.args}) — no result recorded`
      : `- ${call.name}(${call.args}) → ${call.error ? 'ERROR: ' : ''}${call.result}`
    if (total + line.length > 8000) {
      lines.push('… (evidence truncated; call sidecar_log for the full transcript)')
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n')
}

/** The stored review body; read only when the parent calls sidecar_result. */
function reviewText(name, childId, cwd, label, task, result, evidence) {
  const output = outputText(result)
  const normal = result?.stopReason === undefined || result.stopReason === 'completed'
  const lines = [
    `[sidecar ${name}] ${label}`,
    '',
    'Task given to the sidecar:',
    task.trim() !== '' ? task : label,
    '',
    `Working directory: ${cwd}`,
    '',
    normal
      ? 'The sidecar finished normally. Review this thoroughly before acting on it.'
      : `The sidecar stopped with reason "${String(result?.stopReason)}". Review what it did before relying on it.`,
    '',
    'Answer:',
    output !== '' ? output : '(no closing message)',
    '',
    'Evidence trail:',
    evidence !== '' ? evidence : '(no tool calls recorded)',
    '',
    `Child session: ${childId} — call sidecar_log with this id for the full transcript.`
  ]
  if (result?.structured !== undefined) lines.push('', `Structured result: ${JSON.stringify(result.structured)}`)
  if (result?.diagnostic !== undefined) lines.push('', String(result.diagnostic))
  lines.push('', 'Verification checklist: confirm its claims, check any files or commands it reports, and decide what to accept, amend, or discard.')
  return lines.join('\n')
}

export function apply(ctx) {
  const sidecars = new Map()
  const usedNames = new Set()
  let sidecarCounter = 0

  const debug = (text) => {
    try {
      appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${text}\n`)
    } catch {
      /* a debug sink must never break the feature */
    }
  }

  const log = (level, text) => {
    const logger = ctx.logger
    if (logger?.[level] !== undefined) logger[level](`sidecar: ${text}`)
    debug(`${level}: ${text}`)
  }

  const resultsRoot = () => join(homedir(), '.dsh', 'sidecar', 'results')

  function noticeMessage(text) {
    return createUserMessage({
      content: [{ type: 'text', text: `[sidecar] ${text}` }],
      source: { kind: 'sidecar', form: 'notice', summary: boundContextSummary(text) }
    })
  }

  /** Unique for the life of this process; auto names count up. */
  function allocateName(requested) {
    const raw = typeof requested === 'string' ? requested.trim() : ''
    if (raw !== '') {
      let candidate = raw
      let suffix = 2
      while (usedNames.has(candidate)) candidate = `${raw}-${suffix++}`
      usedNames.add(candidate)
      return candidate
    }
    let candidate
    do {
      candidate = `sidecar-${++sidecarCounter}`
    } while (usedNames.has(candidate))
    usedNames.add(candidate)
    return candidate
  }

  /** Parse leading `--name/-n`, `--cwd/-C`, `--worktree` options. */
  function parseSidecarInput(raw) {
    let rest = raw.trim()
    let requestedName
    let cwd
    let worktree = false
    for (;;) {
      const match = /^(--name|-n|--cwd|-C|--worktree)(?:=(\S+))?\s*/.exec(rest)
      if (match === null) break
      rest = rest.slice(match[0].length)
      if (match[1] === '--worktree') {
        if (match[2] !== undefined) return { error: '--worktree takes no value' }
        worktree = true
        continue
      }
      let value = match[2]
      if (value === undefined) {
        const arg = /^(\S+)\s*/.exec(rest)
        if (arg === null) return { error: `${match[1]} needs a value` }
        value = arg[1]
        rest = rest.slice(arg[0].length)
      }
      if (match[1] === '--name' || match[1] === '-n') requestedName = value
      else cwd = value
    }
    return { name: requestedName, cwd, worktree, task: rest.trim() }
  }

  /** Resolve the child's working space: parent cwd, an explicit dir, or a git worktree. */
  function prepareSpace(parent, name, cwd, worktree) {
    const parentCwd = parent.session?.header?.cwd ?? process.cwd()
    if (worktree) {
      const repo = execFileSync('git', ['-C', parentCwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      if (repo === '') throw new Error(`not inside a git repository: ${parentCwd}`)
      const safe = name.replace(/[^A-Za-z0-9._-]/g, '-')
      const path = join(homedir(), '.dsh', 'sidecar', 'worktrees', safe)
      mkdirSync(dirname(path), { recursive: true })
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', `sidecar/${safe}`, path, 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
      return path
    }
    if (typeof cwd === 'string' && cwd !== '') {
      const resolved = resolve(parentCwd, cwd)
      mkdirSync(resolved, { recursive: true })
      return resolved
    }
    return parentCwd
  }

  function storeResult(parentId, name, cwd, childId, label, text, kind = 'normal') {
    try {
      const dir = join(resultsRoot(), parentId)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${childId}.json`)
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ parentId, sidecarName: name, cwd, childId, label, text, kind, createdAt: Date.now(), notified: false }, null, 2)}\n`)
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      log('warn', `could not persist result ${childId}: ${renderThrown(error)}`)
    }
  }

  /** Read the child's persisted session log and header. */
  async function readChildSession(childId) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    let handle
    try {
      handle = await persistence.open(childId, 'read')
      const header = handle.header
      const { events } = await handle.read(0)
      return { header, events }
    } catch (error) {
      log('warn', `could not read the child session ${childId}: ${renderThrown(error)}`)
      return undefined
    } finally {
      try {
        await handle?.close()
      } catch {
        /* the events are already in hand */
      }
    }
  }

  /** One notice per stored result, and only one; the result itself stays until read. */
  function notifyStored(agent) {
    const dir = join(resultsRoot(), agent.id)
    let files
    try {
      files = readdirSync(dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const path = join(dir, file)
      try {
        const entry = JSON.parse(readFileSync(path, 'utf8'))
        if (entry?.childId === undefined || typeof entry.text !== 'string') continue
        if (entry.notified === true) continue
        agent.inject(noticeMessage(`sidecar ${entry.sidecarName ?? entry.childId} (${entry.childId}) ${entry.kind === 'failed' ? 'failed' : 'finished'}; its result is stored. When you choose to review it, call the sidecar_result tool with id "${entry.childId}".`))
        entry.notified = true
        writeFileSync(`${path}.tmp`, `${JSON.stringify(entry, null, 2)}\n`)
        renameSync(`${path}.tmp`, path)
        log('info', `notified "${agent.id}" about stored result ${entry.childId}`)
      } catch (error) {
        log('warn', `could not notify "${agent.id}" about a stored result: ${renderThrown(error)}`)
      }
    }
  }

  /** Read and consume one stored result for an agent. */
  function takeResult(agentId, childId) {
    const file = join(resultsRoot(), agentId, `${childId}.json`)
    let entry
    try {
      entry = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new Error(`no stored sidecar result for id "${childId}"`)
    }
    try {
      unlinkSync(file)
    } catch {
      /* the content is already in hand */
    }
    return entry
  }

  async function startSidecar(parent, task, sidecarName, cwd, worktree) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return { kind: 'error', text: 'sidecars need the subagents service, which this profile does not mount' }
    let provider
    try {
      provider = subagents.getProvider?.('spawn') ?? subagents.getProvider?.('fork')
    } catch {
      provider = undefined
    }
    if (provider === undefined) return { kind: 'error', text: 'no spawn/fork subagent provider is registered' }
    let space
    try {
      space = prepareSpace(parent, sidecarName, cwd, worktree)
    } catch (error) {
      return { kind: 'error', text: `could not prepare the sidecar space: ${renderThrown(error)}` }
    }
    const label = `${sidecarName}: ${shorten(task, 60)}`
    const prompt = [
      `You are sidecar "${sidecarName}": a focused helper. A main agent delegated this task and must not be interrupted.`,
      '',
      `Task: ${task}`,
      '',
      'Rules:',
      '- Work autonomously; the main agent is not watching and cannot answer questions.',
      '- Do NOT call send_message or any agent-messaging or delegation tool, and do not spawn subagents.',
      '- Your final assistant message is the complete result; the supervisor stores it for the main agent to review.',
      '- Verify your work, and be concise but self-contained: the main agent sees only your final answer.'
    ].join('\n')
    let activation
    try {
      activation = await subagents.startActivation({
        provider: provider.name,
        label: `sidecar ${sidecarName}`,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          cwd: space
        },
        signal: new AbortController().signal,
        delivery: 'caller'
      })
    } catch (error) {
      log('warn', `could not start: ${renderThrown(error)}`)
      return { kind: 'error', text: `sidecar could not start: ${renderThrown(error)}` }
    }
    const childId = activation.childId
    try {
      const child = ctx.agents.get(childId)
      const titles = ctx.get('sessionTitle')
      if (child !== undefined && typeof titles?.rename === 'function') titles.rename(child.session, sidecarName)
    } catch (error) {
      log('warn', `could not title sidecar ${childId}: ${renderThrown(error)}`)
    }
    sidecars.set(childId, { name: sidecarName, label, cwd: space, startedAt: Date.now() })
    void (async () => {
      try {
        const result = await activation.result
        const child = await readChildSession(childId)
        const evidence = child === undefined ? '' : formatEvidence(child.events)
        const text = reviewText(sidecarName, childId, space, label, task, result, evidence)
        sidecars.delete(childId)
        storeResult(parent.id, sidecarName, space, childId, label, text)
        if (ctx.agents.get(parent.id) === parent) notifyStored(parent)
        log('info', `sidecar "${sidecarName}" (${childId}) finished; result stored`)
      } catch (error) {
        const child = await readChildSession(childId)
        const evidence = child === undefined ? '' : formatEvidence(child.events)
        const text = reviewText(sidecarName, childId, space, label, task, { stopReason: 'failed', diagnostic: renderThrown(error) }, evidence)
        sidecars.delete(childId)
        storeResult(parent.id, sidecarName, space, childId, label, text, 'failed')
        if (ctx.agents.get(parent.id) === parent) notifyStored(parent)
        log('warn', `sidecar "${sidecarName}" (${childId}) failed: ${renderThrown(error)}`)
      }
    })()
    const branch = sidecarName.replace(/[^A-Za-z0-9._-]/g, '-')
    return {
      kind: 'success',
      text: `sidecar ${sidecarName} started: ${childId}\nspace: ${space}${worktree ? ` (git worktree, branch sidecar/${branch})` : ''}\nIt runs in the background. Completion is a notice (no queued turn); the result stays stored until you review it with sidecar_result or /sidecar result ${childId}.`
    }
  }

  async function handleSidecarCommand(invocation) {
    const raw = String(invocation.rawInput ?? '').trim()
    if (raw === '' || raw === 'list' || raw === 'status') {
      if (sidecars.size === 0) return { kind: 'success', text: 'no sidecars running' }
      const now = Date.now()
      return {
        kind: 'success',
        text: ['sidecars:', ...[...sidecars.entries()].map(([id, entry]) => `- ${entry.name}  ${id}  ${Math.round((now - entry.startedAt) / 1000)}s  ${entry.cwd}`)].join('\n')
      }
    }
    const result = /^result\s+(\S+)$/i.exec(raw)
    if (result !== null) {
      try {
        return { kind: 'success', text: takeResult(invocation.agent.id, result[1]).text }
      } catch (error) {
        return { kind: 'error', text: renderThrown(error) }
      }
    }
    const logMatch = /^log\s+(\S+)$/i.exec(raw)
    if (logMatch !== null) {
      const child = await readChildSession(logMatch[1])
      if (child === undefined) return { kind: 'error', text: `no session log for sidecar "${logMatch[1]}"` }
      if (child.header.parentSession !== invocation.agent.id) return { kind: 'error', text: `"${logMatch[1]}" is not a sidecar of this agent` }
      return { kind: 'success', text: formatFullTranscript(child.events) }
    }
    const cancel = /^cancel\s+(\S+)$/i.exec(raw)
    if (cancel !== null) {
      const childId = cancel[1]
      if (!sidecars.has(childId)) return { kind: 'error', text: `unknown sidecar "${childId}"` }
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return { kind: 'error', text: 'sidecars need the subagents service' }
      try {
        subagents.interrupt(childId, { kind: 'ancestor', agent: invocation.agent })
        return { kind: 'success', text: `cancel requested for sidecar ${childId}` }
      } catch (error) {
        return { kind: 'error', text: `could not cancel ${childId}: ${renderThrown(error)}` }
      }
    }
    const parsed = parseSidecarInput(raw)
    if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }
    if (parsed.task === '') return { kind: 'error', text: 'usage: /sidecar [--name <name>] [--cwd <dir> | --worktree] <task> | list | result <id> | log <id> | cancel <id>' }
    const sidecarName = allocateName(parsed.name)
    return startSidecar(invocation.agent, parsed.task, sidecarName, parsed.cwd, parsed.worktree)
  }

  ctx.effect(function* () {
    debug(`apply() pid=${process.pid}`)

    const disposeCommand = ctx.commands.register({
      name: 'sidecar',
      description: 'Run a focused task in a background subagent. Supports multiple sidecars, unique names, separate cwds and git worktrees. Completion is a notice; results are stored for review on demand.',
      input: { hint: '[--name <name>] [--cwd <dir> | --worktree] <task> | list | result <id> | log <id> | cancel <id>' },
      handler: handleSidecarCommand
    })

    const disposeResultTool = ctx.tools.register(defineTool({
      name: 'sidecar_result',
      description: 'Read and consume the stored result of a finished sidecar, including the task it was given and its full transcript. Call this when you choose to review a sidecar result; it removes the entry from the sidecar queue.',
      parameters: {
        id: { type: 'string', required: true, description: 'Sidecar child session id from the completion notice.' }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error('sidecar_result needs an agent context')
        return takeResult(agent.id, args.id).text
      }
    }))

    const disposeListTool = ctx.tools.register(defineTool({
      name: 'sidecar_list',
      description: 'List stored sidecar results that are waiting for review in this session.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      execute: async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error('sidecar_list needs an agent context')
        const dir = join(resultsRoot(), agent.id)
        let files
        try {
          files = readdirSync(dir).filter((file) => file.endsWith('.json'))
        } catch {
          return 'No stored sidecar results.'
        }
        if (files.length === 0) return 'No stored sidecar results.'
        return files.map((file) => {
          const entry = JSON.parse(readFileSync(join(dir, file), 'utf8'))
          return `- ${entry.sidecarName ?? entry.childId} (${entry.childId}): ${entry.label}`
        }).join('\n')
      }
    }))

    const disposeLogTool = ctx.tools.register(defineTool({
      name: 'sidecar_log',
      description: 'Return the full transcript of a sidecar child session (task, assistant text and thinking, every tool call and result). Use only when the compact evidence trail in a review is not enough.',
      parameters: {
        id: { type: 'string', required: true, description: 'Sidecar child session id from the review.' }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error('sidecar_log needs an agent context')
        const child = await readChildSession(args.id)
        if (child === undefined) throw new Error(`no session log for sidecar "${args.id}"`)
        if (child.header.parentSession !== agent.id) throw new Error(`"${args.id}" is not a sidecar of this agent`)
        return formatFullTranscript(child.events)
      }
    }))

    ctx.on('agent/created', ({ agent }) => notifyStored(agent))
    for (const agent of ctx.agents.list()) notifyStored(agent)

    yield () => {
      debug('dispose')
      disposeCommand()
      disposeResultTool()
      disposeListTool()
      disposeLogTool()
      sidecars.clear()
    }
  }, 'sidecar lifecycle')
}
