# Runbook: your own machines

One person, several machines, one terminal. Start with the first section and stop
when you have what you need; each step works on its own.

## 1. One machine (nothing to set up)

```sh
dovo            # the runtime on this machine
dovo --demo     # or try it with no runtime at all
```

## 2. Another machine, over ssh

On the other machine, run the Dovo runtime as usual. From your machine:

```sh
dovo add build http://127.0.0.1:8787 --token <its owner token> --ssh me@build-box
dovo --all          # this machine and "build", as one workspace
```

`--ssh` makes the terminal open and keep an `ssh -L` tunnel for you (it reconnects
and closes with the terminal). The URL is the runtime's address _as seen from that
machine_. It needs key-based ssh (no password prompt).

Keys on the task list: `s` opens a shell in the project's folder on its machine,
`o` opens a web service the project is running, `m` shows health.

## 3. A worker that other agents can call (A2A)

On the machine that should accept delegated work:

```sh
dovo serve --a2a 8791
dovo a2a-token          # the access token callers must send
```

Optional, in `~/.config/dovo-terminal/config.json`:

```json
{
  "a2aAllow": { "projects": ["my-project"], "providers": ["codex"] },
  "a2aPublicUrl": "https://worker.example.com"
}
```

`a2aAllow` limits what a caller may run. `a2aPublicUrl` is the address other
machines use, if it differs from the listen address (behind a proxy or mesh).
Replace the token with `dovo a2a-token --rotate`.

## 4. An orchestrator

On the machine that should split goals up:

```sh
dovo add alpha http://127.0.0.1:18791 --agent --token <alpha's a2a token> --ssh me@alpha
dovo add beta  http://127.0.0.1:18791 --agent --token <beta's a2a token>  --ssh me@beta
dovo orchestrate 8792 --planner <a Dovo profile that can plan>     # an agent writes the plan
# or, with one worker and no planner:
dovo orchestrate 8792 --worker alpha
```

Then add the orchestrator as a worker from your terminal, the same way
(`dovo add orch http://… --agent --token …`), and give it a goal as a task.
A step that needs an answer is reported as "needs input"; answer it on that
worker. The orchestrator never answers one for you.

## 5. Keeping it healthy

```sh
dovo doctor                          # checks every machine; exit 1 on a failure
dovo prune --older 30d               # lists archived tasks to delete
dovo prune --older 30d --yes         # deletes them (permanent)
```

In the terminal, `m` shows the same report. To run it on a schedule, see
[unattended.md](unattended.md).
