# dsh-sidecar

Fire focused subagents in the background with unique names and separate spaces,
then review each result — task, answer and evidence trail, plus the full
transcript on demand — on your own schedule. **Separate plugin**: no shared state with `dsh-autocontinue`
(continuation/restarts) or the `dsh-update` updater.

## Commands and tools

```sh
/sidecar <task>                              # auto name (sidecar-1, -2, ...), parent cwd
/sidecar --name alpha <task>                 # unique name, pinned as the child session title
/sidecar --cwd /tmp/alpha-space <task>       # separate working directory
/sidecar --worktree --name wt-fix <task>     # isolated git worktree + branch sidecar/wt-fix
/sidecar list                                # running sidecars: name, id, age, cwd
/sidecar result <id>                         # read and consume a stored result now
/sidecar log <id>                            # full child transcript on demand
/sidecar cancel <id>                         # interrupt one
```

Multiple sidecars run concurrently up to the subagents service cap
(`maxActiveSubagents`, default 8). Each gets a unique name (requested names are
suffixed `-2`, `-3`, ... if taken), a distinct child session id, and its title
pinned to the name so the GUI list is unambiguous. They share the parent cwd by
default; use `--cwd` for a separate workspace or `--worktree` for a real
filesystem/branch isolation. Worktrees start from `HEAD` — uncommitted parent
changes are intentionally not visible there.

Model-facing tools (used when the parent chooses to review):

- `sidecar_result` — `{ id }` returns the stored review body and removes it
  from the queue.
- `sidecar_list` — lists stored results waiting for review.

## Delivery: notice, not a queued user message

The child is spawned through `ctx.subagents.startActivation()` with
`delivery: 'caller'`; its prompt forbids `send_message` and further delegation.

When it finishes, the plugin:

1. stores the full result at
   `~/.dsh/sidecar/results/<parent>/<child>.json`;
2. calls `agent.inject(notice)` — a **next-step notice with no wake**. This is
   not `followup`: it does not create a queued user message and does not start a
   turn. A running parent sees it at its next step; an idle parent sees it when
   it next runs. The notice says only that the result is stored and that
   `sidecar_result` will return it;
3. never injects the full result into the transcript. The parent reviews by
   calling `sidecar_result` (or the user runs `/sidecar result <id>`), which
   returns the result as a **tool result** and consumes the file.

The stored review is deliberately compact:

- the **complete task** the sidecar was given (so the parent knows what the
  result is for),
- the **final answer**,
- a **compact evidence trail**: every tool call and its result, in order
  (capped at 8 KB), and
- the **child session id** with a pointer to `sidecar_log`.

The child's complete session log — including workspace instructions, reasoning
and every step — stays on disk. `sidecar_log` (or `/sidecar log <id>`) returns
it on demand. Pushing the full raw log into the parent by default would bury the
useful task/answer under pages of workspace boilerplate, so it is opt-in.

If the parent closes before ever seeing the notice, the file persists; the next
time that parent agent is created (session reopened or resumed) the notice is
injected again. `sidecar_list` is the discovery path if the notice was already
consumed or missed.

## Install

```sh
dsh plugin --profile web add github:kenjoe41/dsh-sidecar
# or pin a release
dsh plugin --profile web add github:kenjoe41/dsh-sidecar#v0.4.0
```

For a local checkout, link it instead; a linked install needs
`node_modules/@deepseek-ai/{dsh-llm,dsh-tools}` shims so the profile's peers
resolve. Reload or restart the profile after installing.
