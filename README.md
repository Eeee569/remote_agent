# Remote Agent

A Mac-compatible desktop GUI for running AI coding agents — **Claude Code**, **OpenAI Codex**, or a plain shell — inside **tmux sessions on remote servers** over SSH.

The GUI is only a viewer/controller: agents run in tmux on the server, and all project/session/layout state persists server-side under `~/.remote-agent/`. Quit the app, drop your Wi-Fi, reboot the laptop — reconnect and everything is exactly where you left it, still running.

## Features

- **Hosts over SSH** — key-file (with passphrase, stored encrypted via macOS Keychain-backed `safeStorage`) or `ssh-agent` auth, TOFU host-key pinning, automatic reconnect with backoff.
- **Projects as tabs** — a project is any directory on the server. It does not have to be a git repository: one that is not (or does not exist yet) is created and `git init`ed as you add it, with its current contents put into an initial commit — sessions are git worktrees, and `git worktree add` needs a commit to branch from. The Add project dialog says which of those will happen before you confirm.
- **Sessions as git worktrees** — each session runs in its own tmux session, in a fresh `git worktree` (branch of your choice) or any directory. Pick the agent per session: Claude Code, Codex CLI, or a shell.
- **Per-session workspace** — agent terminal (xterm.js attached to tmux) + a plain shell in the same directory (its own `<session>-shell` tmux session) + lazy file tree with git status badges + Monaco file viewer (syntax highlighting; Markdown preview/source toggle; opt-in editing with save over SFTP). Panels are dockable, splittable, floatable (dockview); the layout is saved on the server and restored on any client.
- **Terminal clipboard, both directions** — ⌘C copies the terminal's selection (Ctrl+Shift+C elsewhere; plain Ctrl+C always stays SIGINT), ⌘V pastes as a bracketed paste so a multi-line paste reaches an agent as one block instead of a submit per line, and right-click gives Copy / Paste / Select all. Copies made **on the server** land on your local clipboard too: tmux is configured to forward them over the SSH connection as OSC 52 (`set-clipboard on` plus `allow-passthrough` for agent CLIs, which wrap the sequence to punch out of tmux), and the app decodes it into the macOS clipboard. So selecting with the mouse in a tmux pane, or an agent's own "copy", is pasteable in any local app. The reverse — the host *reading* your clipboard — is deliberately not implemented. tmux owns the mouse, so hold ⌥ while dragging if the program in the pane grabs it.
- **Panels belong to their session** — every panel carries its session's accent stripe; closing a session's terminal closes its shell, files, and viewer with it, and killing a session takes all of them away. Closed sessions stay listed in the session bar (tmux keeps running) and reopen with one click.
- **One screen, many sessions** — the session bar switches the workspace between **Focus** (one session on screen; the chips act as tabs to switch between them) and the tiling modes **Columns**, **Rows**, and **Grid**, where every session gets its own bordered tile with the tab strip shrunk down so the tiles keep the space. Inside a tile, a session's panels can stay tabbed or be split apart (⊞ Split / ⊟ Tabs) so you can watch the agent, files, and viewer of several sessions at once.
- **Project Grid** — the title-bar **Project Grid** button opens a host-wide overview: every running session in every project, in one dockview whose tiles you can resize by dragging their edges, rearrange by dragging their tabs, and re-flow with the **Columns / Rows / Grid** buttons. Each tile keeps its project's accent colour so you can tell them apart, and clicking a tile's header jumps straight into that project's workspace. The arrangement is remembered per host (also across app restarts): reopening the grid puts every tile back where you left it, killed sessions and removed projects simply lose their tile, and new sessions are added at the end without moving the rest. Only the Columns / Rows / Grid buttons re-flow everything.
- **Nothing is lost by closing** — each chip's ▾ menu (or a right-click on the chip) lists that session's four panels and reopens any you closed, alongside Close and Kill session; the chip shows how many panels are missing.
- **File management** — right-click in the tree for new file/folder, rename, move, delete, and copy path; drag entries onto a folder to move them. Files open editable in Monaco and **autosave** over SFTP — a moment after you stop typing, when the editor loses focus, and when the tab or panel closes (files too large to read whole stay read-only). If the file changed on the server since you opened it, the autosave stands down and offers Reload / Overwrite rather than clobbering an agent's edit. PDFs (up to 64 MiB) open read-only in Chromium's built-in viewer, with paging, zoom, search, and print.
- **Files from your computer** — drag files or folders from Finder onto the tree (onto a folder to put them inside it, onto a file to put them beside it), or copy them in Finder and press ⌘V in the tree / pick **Paste from computer** in its context menu; a copied image (e.g. a screenshot) pastes as a PNG. In a terminal, dropping or ⌘V-pasting files uploads them to `~/.remote-agent/uploads/<timestamp>/` on the host and types their escaped paths at the prompt, so Claude Code picks them up as attachments (plain text on the clipboard still pastes as text). Uploads never overwrite — a clash becomes `name (1).ext` — symlinks inside folders are skipped, and one upload is capped at 5,000 files / 2 GiB.
- **Semi-live tree** — while the window is visible, every expanded directory is re-listed and git status re-read every few seconds, in one batched helper call that only touches the UI when something actually changed.
- **Claude Code settings UI** — edit `~/.claude/settings.json`, project `.claude/settings.json` + `settings.local.json`, `.mcp.json` MCP servers, `.claude/agents/*.md` sub-agents, and `CLAUDE.md` — as forms or raw JSON with schema validation.
- **Codex as a sub-agent of Claude Code** — a one-click wizard (with diff preview) registers Codex CLI as an MCP server (`codex mcp-server`) and writes a `codex-worker` agent definition, so Claude Code orchestrates and delegates implementation work to Codex.
- **Server bootstrap** — on first connect the app uploads a single-file python3 helper (`~/.remote-agent/bin/helper`), and can install Claude Code / Codex CLI for you (with consent).

## Server requirements

`sshd`, `tmux`, `git`, `python3` (stdlib only — no packages). Claude Code / Codex CLI are optional and installable from the app's Install panel.

Each attached terminal holds one SSH session channel, and helper calls open one more
at a time, so sshd's `MaxSessions` (default 10) caps how many sessions you can watch at
once. The app queues and retries around the limit, but if you keep many sessions
attached, raise `MaxSessions` in `sshd_config`.

## Development

```sh
npm install
npm run dev          # launch Electron with HMR (Linux/mac)
npm run typecheck    # strict TS across main/preload/renderer
npm run test:helper  # python unittest suite for the server helper
npm run build        # production bundles into out/
```

## Verification scripts

`scripts/` drives the built app with Playwright (`npm run build` first). The end-to-end
scripts need an SSH server you don't mind being restarted — point them at a throwaway
`sshd` on localhost, never a real host.

```sh
node scripts/smoke.mjs                  # launch, screenshot, check the IPC bridge

E2E_KEY=/path/to/client_key \
E2E_REPO=/path/to/a/test/git/repo \
E2E_SSH_PORT=2299 \
  node scripts/e2e-local.mjs            # connect -> worktree session -> tmux -> file viewer

E2E_SSHD_DIR=/path/to/sshd/rundir \     # dir holding sshd.pid, for the forced-drop step
  node scripts/e2e-resilience.mjs       # app quit + SSH kill; asserts no work is lost

node scripts/e2e-codex-wizard.mjs       # writes Codex MCP config, checks `claude mcp list`
```

Screenshots go to `SCREENSHOT_DIR` (default `/tmp/ra-*-shots`). The resilience script kills
the descendant processes of the sshd named by `E2E_SSHD_DIR/sshd.pid` — it never touches the
system sshd, but do not point it at one you rely on.

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
- `server-helper/helper.py` — single-file python3 JSON API: `ls-tree`, `git-status`, `git-init` (creates the directory, then `git init` + first commit; leaves an existing repo alone), `fs-move`/`fs-delete`/`fs-mkdir` (never overwrite, never touch `/` or `$HOME`), tmux `session-*`, `worktree-*`, versioned `read-state`/`write-state` (flock).
- `src/renderer/` — stores (zustand), dock workspace, terminal/file panels, settings editors.
- `src/renderer/src/theme/` — `dark.css` holds every colour as a `--ra-*` token (VS Code "Dark Modern" palette, incl. the `gitDecoration` colours and the terminal's 16 ANSI slots); `tokens.ts` feeds the same values to the xterm and Monaco themes, so re-skinning the app is a one-file change.
- `src/renderer/src/components/dock/session-layout.ts` — panel ids (`term|shell|tree|view:<sessionId>`), per-session accents, and the focus/columns/rows/grid arrangements. Unit tested against a fake dockview api.
- `src/renderer/src/components/terminal/osc52.ts` — decodes the OSC 52 clipboard sequence xterm.js does not implement; the clipboard itself is the OS one, reached through the main process (`clipboard:read`/`clipboard:write`).
