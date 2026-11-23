# Remote Agent for iPhone

The phone-sized client for the same servers the desktop app talks to: connect to a host
over SSH, see every project and session on it, and attach to an agent's tmux session
with a real terminal. State lives on the server (`~/.remote-agent/`), so a session started
on the desktop is there on the phone and the other way round.

What it does:

- **Hosts** — password, a pasted OpenSSH private key (ed25519 recommended), or a key
  generated on the phone and kept in its Keychain. After a password sign-in, one tap
  installs the phone's key into the host's `authorized_keys`. Host keys are pinned on
  first connect.
- **Projects and sessions** — list, add a project, start a session (Claude Code, Codex,
  or a shell; in a new git worktree or a directory), kill a session.
- **Terminal** — xterm.js attached to the session's tmux, plus its companion shell. A key
  bar supplies what the iOS keyboard lacks (esc, tab, shift-tab, a sticky ctrl, ^C, arrows),
  dragging scrolls tmux history, and "Select & copy text" turns the pane into selectable
  text. Copies made on the server (OSC 52) land on the phone's clipboard.
- **Compose box** — under the terminal is an ordinary text field. Type or dictate
  into it, then press return or **Send**: the text is pasted into the terminal in one
  piece, followed by Enter. Dictation, autocorrect and swipe typing all work there,
  and nothing is sent while you are still writing. With the box empty, Send is just
  Enter. The key bar (esc, arrows, ^C…) always goes straight to the terminal. The
  **keys** button switches to typing directly into the terminal, for programs that
  want single keystrokes; dictation is unreliable in that mode.
- **Scrolling** — drag to scroll, flick to glide (the harder the flick, the further),
  touch to stop. **pg↑ / pg↓** in the key bar move one screen.
- **Files** — browse the session's directory, read text files, and edit them: tap a
  file, then **Edit**, then **Save**. A save replaces the file atomically and keeps
  its permissions, line endings and encoding. If the file changed on the server
  after you opened it (the agent edited it, say) you are asked before overwriting.
  An edit in progress survives a look at the terminal tab. Files over 400 KB,
  non-UTF-8 files and files you cannot write stay read-only.
- **Reconnects on its own** — iOS cuts an app's connections shortly after it leaves the
  foreground. Coming back re-establishes SSH and re-attaches; the agents never noticed,
  because they run in tmux on the server.

Not on the phone: the dock/tiling workspace, the Monaco editor (the phone has a plain
text editor), file upload, creating/renaming/deleting files, and the Claude Code
settings editors. Use the desktop app for those.

## Install on your iPhone (free Apple ID, no developer account)

You need a Mac with Xcode, the iPhone, and a cable. iOS 16 or newer.

1. **Get this repository onto the Mac** — `git clone` it, or copy the folder over.
2. **Install Xcode** from the Mac App Store (free, large). Open it once and let it install
   the iOS platform when it offers to.
3. **Generate and open the project.** In Terminal:

   ```sh
   cd remote_agent/ios
   ./setup.sh
   ```

   This installs [XcodeGen](https://github.com/yonaskolb/XcodeGen) if it is missing (via
   Homebrew when you have it, otherwise a download into `ios/.tools/`), writes
   `RemoteAgent.xcodeproj`, and opens it in Xcode. Xcode then fetches the Swift packages
   (the SSH library) — give it a few minutes the first time.
4. **Add your Apple ID to Xcode.** Xcode ▸ Settings ▸ Accounts ▸ **+** ▸ Apple Account, and
   sign in. Any Apple ID works; this creates a free "Personal Team".
5. **Choose the team.** Click the blue **RemoteAgent** project at the top of the left
   sidebar ▸ target **RemoteAgent** ▸ **Signing & Capabilities** ▸ keep "Automatically
   manage signing" ticked ▸ **Team**: *Your Name (Personal Team)*.
   If Xcode says the bundle identifier is unavailable, change **Bundle Identifier** on the
   same screen to anything unique, e.g. `com.yourname.remoteagent`.
6. **Plug in the iPhone**, unlock it, and tap **Trust** when it asks about the computer.
7. **Turn on Developer Mode on the iPhone**: Settings ▸ Privacy & Security ▸ Developer
   Mode ▸ on, then restart when prompted. (The switch only appears once the phone has
   been connected to Xcode.)
8. **Run.** In Xcode's toolbar pick your iPhone as the destination (not a simulator) and
   press ▶ (⌘R). The first time, Xcode may spend a while "preparing" the phone.
9. **Trust yourself as a developer.** The first launch is blocked with "Untrusted
   Developer". On the iPhone: Settings ▸ General ▸ VPN & Device Management ▸ your Apple
   ID under "Developer App" ▸ **Trust**. Then open the app (or press ▶ again).
10. In the app, **Add host**. If the server is on your home network, iOS asks for
    permission to find devices on the local network — allow it, then tap **Retry**.

**The 7-day limit.** Apps signed with a free Apple ID stop opening after 7 days. Plug the
phone in and press ▶ in Xcode again to renew; your hosts and keys are kept (they are in
the Keychain). A paid developer account stretches this to a year.

To reach a server from outside your network you need what any SSH client needs: a
VPN/overlay network such as Tailscale or WireGuard on both ends, or a forwarded port.

## How it is built

```
ios/web/             the UI: React + xterm.js, TypeScript   ─┐ built into one file
ios/RemoteAgent/web/index.html   (committed build output)   ◀┘ npm run build:ios-web
ios/RemoteAgent/     the app: a WKWebView showing that page, the Keychain, clipboard
ios/RemoteAgentCore/ Swift package: SSH (Citadel/SwiftNIO SSH), exec, PTY channels
ios/dev/             runs the UI against the same Swift core on Linux, for development
```

The page talks to the Swift core over a small JSON protocol (see the header of
`RemoteAgentCore/Sources/RemoteAgentCore/Bridge.swift`). Everything above the socket —
the helper protocol, project/session state, tmux attach commands — is shared with or
ported from the desktop app (`ios/web/src/remote.ts` mirrors `src/main/services/`), which
is what keeps the two clients compatible.

The built page is committed so that the Mac needs nothing but Xcode. **After changing
anything under `ios/web/`, `src/shared/`, or `server-helper/`, rebuild it:**

```sh
npm run typecheck:ios
npm run build:ios-web
```

### Developing without a phone

`RemoteAgentCore` has no UIKit in it and builds on Linux, so the whole stack except the
WKWebView wrapper can be run and tested on a dev machine:

```sh
docker build -t ra-test-sshd -f ios/dev/Dockerfile.sshd ios/dev      # throwaway SSH host
docker run -d --rm --name ra-test-sshd -p 127.0.0.1:2299:22 ra-test-sshd   # dev / devpass
npm run build:ios-web
npm run dev:ios                     # http://localhost:5199 — use a phone-sized window
```

`dev:ios` starts the Swift bridge in a `swift:6.1` container (set `RA_BRIDGE_CMD` to run
a local build instead) and serves the page with an HTTP transport in place of WKWebView's
message channel.

Notes on the server helper: the phone installs `~/.remote-agent/bin/helper` only when it
is missing. An existing helper is left as it is, even if it differs from the copy bundled
in the app — the desktop app keeps the helper in step with its own bundle, and two
clients of different ages would otherwise replace each other's copy on every connect.
