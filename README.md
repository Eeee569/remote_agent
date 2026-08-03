# Remote Agent

A Mac-compatible desktop GUI for running AI coding agents — **Claude Code**, **OpenAI Codex**, or a plain shell — inside **tmux sessions on remote servers** over SSH.

The GUI is only a viewer/controller: agents run in tmux on the server, and all project/session/layout state persists server-side under `~/.remote-agent/`. Quit the app, drop your Wi-Fi, reboot the laptop — reconnect and everything is exactly where you left it, still running.

## Features

- **Hosts over SSH** — key-file (with passphrase, stored encrypted via macOS Keychain-backed `safeStorage`) or `ssh-agent` auth, TOFU host-key pinning, automatic reconnect with backoff.
- **Projects as tabs** — a project is a git repo directory on the server.
- **Sessions as git worktrees** — each session runs in its own tmux session, in a fresh `git worktree` (branch of your choice) or any directory. Pick the agent per session: Claude Code, Codex CLI, or a shell.
- **Per-session workspace** — terminal (xterm.js attached to tmux) + lazy file tree with git status badges + Monaco file viewer (syntax highlighting; Markdown preview/source toggle; opt-in editing with save over SFTP). Panels are dockable, splittable, floatable (dockview); the layout is saved on the server and restored on any client.
- **Claude Code settings UI** — edit `~/.claude/settings.json`, project `.claude/settings.json` + `settings.local.json`, `.mcp.json` MCP servers, `.claude/agents/*.md` sub-agents, and `CLAUDE.md` — as forms or raw JSON with schema validation.
- **Codex as a sub-agent of Claude Code** — a one-click wizard (with diff preview) registers Codex CLI as an MCP server (`codex mcp-server`) and writes a `codex-worker` agent definition, so Claude Code orchestrates and delegates implementation work to Codex.
- **Server bootstrap** — on first connect the app uploads a single-file python3 helper (`~/.remote-agent/bin/helper`), and can install Claude Code / Codex CLI for you (with consent).

## Server requirements

`sshd`, `tmux`, `git`, `python3` (stdlib only — no packages). Claude Code / Codex CLI are optional and installable from the app's Install panel.

## Development

```sh
npm install
npm run dev          # launch Electron with HMR (Linux/mac)
npm run typecheck    # strict TS across main/preload/renderer
npm run test:helper  # python unittest suite for the server helper
npm run build        # production bundles into out/
```

## Packaging (macOS)

```sh
npm run package:mac  # dmg + zip into release/ (build on a Mac)
```

CI: `.github/workflows/build-mac.yml` builds on `macos-latest`; add `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` secrets for signed + notarized artifacts.

## Architecture (short)

```
Electron renderer (React, xterm.js, Monaco, dockview)
        │  typed IPC (zod-validated, src/shared/ipc.ts)
Electron main (ssh2: one multiplexed SSH client per host)
        │  shell channels (tmux attach) · SFTP · exec
Remote server: tmux sessions ─ ~/.remote-agent/{bin/helper, tmux.conf, state/}
```

- `src/shared/` — IPC + domain contracts, helper protocol schemas, Claude Code JSON schemas.
- `src/main/ssh/` — connection manager (keepalive, backoff reconnect, host-key TOFU), terminal/SFTP/exec services.
- `src/main/services/` — helper client, bootstrap/installers, server state (optimistic versioning), settings + Codex wizard.
- `server-helper/helper.py` — single-file python3 JSON API: `ls-tree`, `git-status`, tmux `session-*`, `worktree-*`, versioned `read-state`/`write-state` (flock).
- `src/renderer/` — stores (zustand), dock workspace, terminal/file panels, settings editors.
