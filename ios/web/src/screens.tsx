import { useEffect, useRef, useState } from 'react'
import type { AgentKind, ProjectMeta, SessionMeta, TreeEntry } from '@shared/domain'
import { clipboardWrite } from './native'
import { decodeText, encodeText } from './filetext'
import type { EditableText } from './filetext'
import { MAX_VIEW_BYTES, RemoteError, shellTmuxName } from './remote'
import {
  activeHost,
  deleteHost,
  ensureDeviceKey,
  errText,
  go,
  leaveHost,
  notify,
  openHost,
  refreshOverview,
  retryConnect,
  saveHost,
  setFontSize,
  trustNewHostKey,
  useApp
} from './state'
import type { HostAuth, HostRecord } from './state'
import TerminalView from './Terminal'
import type { TerminalHandle } from './Terminal'
import { confirmAsk, KeyButton, Sheet } from './ui'

function newHostId(): string {
  return 'h_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: 'var(--ra-purple)',
  codex: 'var(--ra-green)',
  shell: 'var(--ra-text-dim)'
}

// =====================================================================
// Hosts
// =====================================================================

export function HostsScreen(): React.JSX.Element {
  const hosts = useApp((s) => s.hosts)
  const deviceKey = useApp((s) => s.deviceKey)

  return (
    <div className='screen'>
      <header className='bar'>
        <div className='bar-title'>Remote Agent</div>
        <button className='btn primary' onClick={() => go({ name: 'hostForm', hostId: null })}>
          Add host
        </button>
      </header>
      <div className='scroll'>
        {hosts.length === 0 && (
          <div className='empty'>
            No hosts yet. Add the server your agents run on — anything you can reach over SSH.
          </div>
        )}
        {hosts.map((h) => (
          <div key={h.id} className='row' onClick={() => openHost(h.id)}>
            <div className='row-main'>
              <div className='row-title'>{h.label || h.host}</div>
              <div className='row-sub mono'>
                {h.username}@{h.host}
                {h.port !== 22 ? `:${h.port}` : ''}
              </div>
            </div>
            <button
              className='btn ghost'
              onClick={(e) => {
                e.stopPropagation()
                go({ name: 'hostForm', hostId: h.id })
              }}
            >
              Edit
            </button>
          </div>
        ))}
        {deviceKey && (
          <div className='card'>
            <div className='card-title'>This iPhone’s SSH key</div>
            <div className='hint'>
              Add this line to <span className='mono'>~/.ssh/authorized_keys</span> on a host to sign
              in without a password.
            </div>
            <div className='keybox mono'>{deviceKey.publicKey}</div>
            <button
              className='btn'
              onClick={() => {
                clipboardWrite(deviceKey.publicKey)
                notify('Public key copied')
              }}
            >
              Copy public key
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function HostFormScreen({ hostId }: { hostId: string | null }): React.JSX.Element {
  const existing = useApp((s) => s.hosts.find((h) => h.id === hostId))
  const deviceKey = useApp((s) => s.deviceKey)
  const [label, setLabel] = useState(existing?.label ?? '')
  const [host, setHost] = useState(existing?.host ?? '')
  const [port, setPort] = useState(String(existing?.port ?? 22))
  const [username, setUsername] = useState(existing?.username ?? '')
  const [kind, setKind] = useState<HostAuth['kind']>(existing?.auth.kind ?? 'password')
  const [password, setPassword] = useState(
    existing?.auth.kind === 'password' ? existing.auth.password : ''
  )
  const [privateKey, setPrivateKey] = useState(
    existing?.auth.kind === 'key' ? existing.auth.privateKey : ''
  )
  const [passphrase, setPassphrase] = useState(
    existing?.auth.kind === 'key' ? (existing.auth.passphrase ?? '') : ''
  )

  useEffect(() => {
    if (kind === 'device') void ensureDeviceKey().catch((err) => notify(errText(err)))
  }, [kind])

  const portNum = Number(port)
  const valid =
    host.trim() !== '' &&
    username.trim() !== '' &&
    Number.isInteger(portNum) &&
    portNum > 0 &&
    portNum < 65536 &&
    (kind !== 'key' || privateKey.trim() !== '')

  const save = async (): Promise<void> => {
    const auth: HostAuth =
      kind === 'password'
        ? { kind, password }
        : kind === 'device'
          ? { kind }
          : { kind, privateKey: privateKey.trim() + '\n', ...(passphrase ? { passphrase } : {}) }
    const sameEndpoint = existing && existing.host === host.trim() && existing.port === portNum
    const record: HostRecord = {
      id: existing?.id ?? newHostId(),
      label: label.trim(),
      host: host.trim(),
      port: portNum,
      username: username.trim(),
      auth,
      // a different machine has a different key; keep the pin only for the same one
      ...(sameEndpoint && existing.hostKey ? { hostKey: existing.hostKey } : {})
    }
    await saveHost(record)
    go({ name: 'hosts' })
  }

  return (
    <div className='screen'>
      <header className='bar'>
        <button className='btn ghost' onClick={() => go({ name: 'hosts' })}>
          Cancel
        </button>
        <div className='bar-title center'>{existing ? 'Edit host' : 'New host'}</div>
        <button className='btn primary' disabled={!valid} onClick={() => void save()}>
          Save
        </button>
      </header>
      <div className='scroll form'>
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder='My server' />
        </label>
        <label>
          Host
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder='hostname or IP address'
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
          />
        </label>
        <div className='two'>
          <label>
            User
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize='none'
              autoCorrect='off'
              spellCheck={false}
            />
          </label>
          <label className='narrow'>
            Port
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode='numeric' />
          </label>
        </div>

        <div className='field-label'>Sign in with</div>
        <div className='segmented'>
          {(
            [
              ['password', 'Password'],
              ['device', 'iPhone key'],
              ['key', 'Pasted key']
            ] as const
          ).map(([k, text]) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {text}
            </button>
          ))}
        </div>

        {kind === 'password' && (
          <label>
            Password
            <input type='password' value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {kind === 'device' && (
          <div className='card'>
            <div className='hint'>
              A key generated on this iPhone and kept in its Keychain. Add the line below to{' '}
              <span className='mono'>~/.ssh/authorized_keys</span> on the host. (Or sign in with the
              password once — the host screen then offers to install it for you.)
            </div>
            <div className='keybox mono'>{deviceKey?.publicKey ?? 'Generating…'}</div>
            <button
              className='btn'
              disabled={!deviceKey}
              onClick={() => {
                if (!deviceKey) return
                clipboardWrite(deviceKey.publicKey)
                notify('Public key copied')
              }}
            >
              Copy public key
            </button>
          </div>
        )}
        {kind === 'key' && (
          <>
            <label>
              Private key (OpenSSH format, ed25519 recommended)
              <textarea
                className='mono'
                rows={6}
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder='-----BEGIN OPENSSH PRIVATE KEY-----'
                autoCapitalize='none'
                autoCorrect='off'
                spellCheck={false}
              />
            </label>
            <label>
              Passphrase (if the key has one)
              <input
                type='password'
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}

        {existing && (
          <button
            className='btn danger block'
            onClick={() => {
              void confirmAsk({
                title: `Remove “${existing.label || existing.host}”?`,
                message: 'Only this app’s entry is removed. Nothing on the server changes.',
                okLabel: 'Remove',
                danger: true
              }).then(async ({ ok }) => {
                if (!ok) return
                await deleteHost(existing.id)
                go({ name: 'hosts' })
              })
            }}
          >
            Remove host
          </button>
        )}
      </div>
    </div>
  )
}

// =====================================================================
// Host: projects + sessions
// =====================================================================

function ConnectionBanner(): React.JSX.Element | null {
  const status = useApp((s) => s.status)
  const error = useApp((s) => s.error)
  if (status === 'connected' && !error) return null
  if (status === 'connected' && error) {
    return (
      <div className='banner warn'>
        <div>{error.message}</div>
        <button className='btn' onClick={() => void refreshOverview()}>
          Retry
        </button>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className='banner bad'>
        <div>{error?.message ?? 'Connection failed.'}</div>
        <div className='banner-actions'>
          {error?.code === 'host-key-mismatch' && (
            <button
              className='btn danger'
              onClick={() => {
                void confirmAsk({
                  title: 'Trust the new host key?',
                  message:
                    'The server is presenting a different key than the one this app saved. That is ' +
                    'expected after a reinstall, and is also what an interception looks like.',
                  okLabel: 'Trust new key',
                  danger: true
                }).then(({ ok }) => {
                  if (ok) void trustNewHostKey()
                })
              }}
            >
              Trust new key
            </button>
          )}
          <button className='btn' onClick={retryConnect}>
            Retry
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className='banner'>
      <div>
        {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        {status === 'reconnecting' && error ? ` (${error.message})` : ''}
      </div>
    </div>
  )
}

export function HostScreen(): React.JSX.Element {
  const host = activeHost()
  const status = useApp((s) => s.status)
  const remote = useApp((s) => s.remote)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const loaded = useApp((s) => s.overviewLoaded)
  const [newSessionFor, setNewSessionFor] = useState<ProjectMeta | null>(null)
  const [addingProject, setAddingProject] = useState(false)
  const [installing, setInstalling] = useState(false)

  // keep the alive dots honest while the list is on screen
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshOverview()
    }, 8000)
    return () => window.clearInterval(timer)
  }, [])

  const installKey = async (): Promise<void> => {
    if (!remote || !host) return
    setInstalling(true)
    try {
      const key = await ensureDeviceKey()
      await remote.installPublicKey(key.publicKey)
      await saveHost({ ...host, auth: { kind: 'device' } })
      notify('Key installed — this host now signs in with the iPhone key')
    } catch (err) {
      notify(errText(err))
    } finally {
      setInstalling(false)
    }
  }

  const removeProject = (p: ProjectMeta): void => {
    void confirmAsk({
      title: `Remove project “${p.name}”?`,
      message: 'It is removed from the project list only. Files and running sessions stay on the server.',
      okLabel: 'Remove',
      danger: true
    }).then(async ({ ok }) => {
      if (!ok || !remote) return
      try {
        await remote.projectRemove(p.id)
        await refreshOverview()
      } catch (err) {
        notify(errText(err))
      }
    })
  }

  return (
    <div className='screen'>
      <header className='bar'>
        <button className='btn ghost' onClick={leaveHost}>
          ‹ Hosts
        </button>
        <div className='bar-title center'>
          <span className={`dot ${status === 'connected' ? 'ok' : status === 'failed' ? 'bad' : 'wait'}`} />
          {host?.label || host?.host}
        </div>
        <button className='btn ghost' disabled={!remote} onClick={() => void refreshOverview()}>
          Refresh
        </button>
      </header>
      <ConnectionBanner />
      <div className='scroll'>
        {remote && host?.auth.kind === 'password' && (
          <div className='card'>
            <div className='hint'>
              Signed in with a password. Install this iPhone’s key on the host to stop storing the
              password.
            </div>
            <button className='btn' disabled={installing} onClick={() => void installKey()}>
              {installing ? 'Installing…' : 'Install iPhone key on this host'}
            </button>
          </div>
        )}
        {remote && !loaded && <div className='empty'>Loading projects…</div>}
        {remote && loaded && projects.length === 0 && (
          <div className='empty'>
            No projects on this host yet. A project is a directory on the server; sessions run
            inside it.
          </div>
        )}
        {projects.map((p) => (
          <div key={p.id} className='project'>
            <div className='project-head'>
              <div className='row-main'>
                <div className='row-title'>{p.name}</div>
                <div className='row-sub mono'>{p.repoPath}</div>
              </div>
              <button className='btn ghost' onClick={() => removeProject(p)}>
                Remove
              </button>
            </div>
            {(sessions[p.id] ?? []).map((s) => (
              <div
                key={s.id}
                className='row session'
                onClick={() => go({ name: 'session', projectId: p.id, sessionId: s.id })}
              >
                <span className={`dot ${s.alive ? 'ok' : 'bad'}`} />
                <div className='row-main'>
                  <div className='row-title mono'>{s.tmuxName}</div>
                  <div className='row-sub'>
                    {s.worktree ? `branch ${s.worktree.branch}` : s.cwd}
                    {s.alive ? '' : ' · not running'}
                  </div>
                </div>
                <span className='badge' style={{ color: AGENT_COLOR[s.agent], borderColor: AGENT_COLOR[s.agent] }}>
                  {s.agent}
                </span>
                <span className='chev'>›</span>
              </div>
            ))}
            <button className='btn block' disabled={!remote} onClick={() => setNewSessionFor(p)}>
              New session
            </button>
          </div>
        ))}
        {remote && loaded && (
          <button className='btn block' onClick={() => setAddingProject(true)}>
            Add project
          </button>
        )}
      </div>
      {newSessionFor && <NewSessionSheet project={newSessionFor} onClose={() => setNewSessionFor(null)} />}
      {addingProject && <AddProjectSheet onClose={() => setAddingProject(false)} />}
    </div>
  )
}

function NewSessionSheet({
  project,
  onClose
}: {
  project: ProjectMeta
  onClose: () => void
}): React.JSX.Element {
  const remote = useApp((s) => s.remote)
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [mode, setMode] = useState<'worktree' | 'dir'>('worktree')
  const [branch, setBranch] = useState('')
  const [dir, setDir] = useState(project.repoPath)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const valid = mode === 'worktree' ? branch.trim() !== '' : dir.trim() !== ''

  const create = async (): Promise<void> => {
    if (!remote) return
    setBusy(true)
    setError(null)
    try {
      const session = await remote.sessionCreate(
        project,
        mode === 'worktree'
          ? { agent, mode, branch: branch.trim() }
          : { agent, mode, dir: dir.trim() }
      )
      await refreshOverview()
      onClose()
      go({ name: 'session', projectId: project.id, sessionId: session.id })
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={`New session in ${project.name}`} onClose={onClose}>
      <div className='form'>
        <div className='field-label'>Agent</div>
        <div className='segmented'>
          {(['claude', 'codex', 'shell'] as const).map((a) => (
            <button key={a} className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>
              {a === 'claude' ? 'Claude Code' : a === 'codex' ? 'Codex' : 'Shell'}
            </button>
          ))}
        </div>
        <div className='field-label'>Runs in</div>
        <div className='segmented'>
          <button className={mode === 'worktree' ? 'on' : ''} onClick={() => setMode('worktree')}>
            New git worktree
          </button>
          <button className={mode === 'dir' ? 'on' : ''} onClick={() => setMode('dir')}>
            A directory
          </button>
        </div>
        {mode === 'worktree' ? (
          <label>
            Branch
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder='feature/my-change'
              autoCapitalize='none'
              autoCorrect='off'
              spellCheck={false}
            />
          </label>
        ) : (
          <label>
            Directory
            <input
              className='mono'
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              autoCapitalize='none'
              autoCorrect='off'
              spellCheck={false}
            />
          </label>
        )}
        {error && <div className='error'>{error}</div>}
        <button className='btn primary block' disabled={!valid || busy} onClick={() => void create()}>
          {busy ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </Sheet>
  )
}

function AddProjectSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const remote = useApp((s) => s.remote)
  const [path, setPath] = useState('~/')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const derived = path.split('/').filter((p) => p !== '' && p !== '~').pop() ?? ''
  const finalName = name.trim() || derived
  const valid = path.trim() !== '' && path.trim() !== '~/' && path.trim() !== '~' && finalName !== ''

  const add = async (): Promise<void> => {
    if (!remote) return
    setBusy(true)
    setError(null)
    try {
      await remote.projectAdd(finalName, path.trim())
      await refreshOverview()
      onClose()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title='Add project' onClose={onClose}>
      <div className='form'>
        <label>
          Directory on the server
          <input
            className='mono'
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
          />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={derived || 'project'} />
        </label>
        <div className='hint'>
          A directory that is not a git repository yet (or does not exist) is created and
          initialised with a first commit, because sessions are git worktrees.
        </div>
        {error && <div className='error'>{error}</div>}
        <button className='btn primary block' disabled={!valid || busy} onClick={() => void add()}>
          {busy ? 'Adding…' : 'Add project'}
        </button>
      </div>
    </Sheet>
  )
}

// =====================================================================
// Session: agent terminal / shell / files
// =====================================================================

type SessionTab = 'agent' | 'shell' | 'files'

export function SessionScreen({
  projectId,
  sessionId
}: {
  projectId: string
  sessionId: string
}): React.JSX.Element {
  const liveProject = useApp((s) => s.projects.find((p) => p.id === projectId))
  const liveSession = useApp((s) => (s.sessions[projectId] ?? []).find((x) => x.id === sessionId))
  // keep showing the session while a reconnect briefly has no list
  const lastRef = useRef<{ project: ProjectMeta; session: SessionMeta } | null>(null)
  if (liveProject && liveSession) lastRef.current = { project: liveProject, session: liveSession }
  const current = lastRef.current
  const remote = useApp((s) => s.remote)
  const status = useApp((s) => s.status)
  const fontSize = useApp((s) => s.fontSize)
  const [tab, setTab] = useState<SessionTab>('agent')
  const [shellOpened, setShellOpened] = useState(false)
  const [filesOpened, setFilesOpened] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const [ctrl, setCtrl] = useState(false)
  // false: type in the compose box; true: the keyboard types into the terminal
  const [direct, setDirect] = useState(false)
  const [menu, setMenu] = useState(false)
  const [copyText, setCopyText] = useState<string | null>(null)
  const agentRef = useRef<TerminalHandle | null>(null)
  const shellRef = useRef<TerminalHandle | null>(null)

  if (!current) {
    return (
      <div className='screen'>
        <header className='bar'>
          <button className='btn ghost' onClick={() => go({ name: 'host' })}>
            ‹ Back
          </button>
        </header>
        <div className='empty'>This session no longer exists.</div>
      </div>
    )
  }
  const { project, session } = current
  const connId = remote?.connId ?? null
  const active = (): TerminalHandle | null => (tab === 'shell' ? shellRef.current : agentRef.current)
  const activeTmux = tab === 'shell' ? shellTmuxName(session.tmuxName) : session.tmuxName

  const armCtrl = (armed: boolean): void => {
    setCtrl(armed)
    agentRef.current?.setCtrl(armed)
    shellRef.current?.setCtrl(armed)
  }

  const leave = (): void => {
    if (!unsaved) {
      go({ name: 'host' })
      return
    }
    void confirmAsk({
      title: 'Discard unsaved changes?',
      message: 'The file you are editing has changes that are not saved.',
      okLabel: 'Discard',
      danger: true
    }).then(({ ok }) => {
      if (ok) go({ name: 'host' })
    })
  }

  const kill = (): void => {
    setMenu(false)
    void confirmAsk({
      title: `Kill “${session.tmuxName}”?`,
      message: 'The agent inside will stop.',
      okLabel: 'Kill session',
      danger: true,
      ...(session.mode === 'worktree' ? { checkbox: 'Also remove its git worktree' } : {})
    }).then(async ({ ok, checked }) => {
      if (!ok || !remote) return
      try {
        await remote.sessionKill(project, session, checked)
        go({ name: 'host' })
        await refreshOverview()
      } catch (err) {
        notify(errText(err))
      }
    })
  }

  const openCopy = (): void => {
    setMenu(false)
    if (!remote) return
    remote
      .capturePane(activeTmux)
      .then(setCopyText)
      .catch((err) => notify(errText(err)))
  }

  return (
    <div className='screen'>
      <header className='bar compact'>
        <button className='btn ghost' onClick={leave}>
          ‹
        </button>
        <div className='tabs'>
          {(['agent', 'shell', 'files'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'on' : ''}
              onClick={() => {
                if (t === 'shell') setShellOpened(true)
                if (t === 'files') setFilesOpened(true)
                setTab(t)
              }}
            >
              {t === 'agent' ? (session.agent === 'shell' ? 'Terminal' : session.agent) : t}
              {t === 'files' && unsaved ? ' •' : ''}
            </button>
          ))}
        </div>
        <span className={`dot ${status === 'connected' ? 'ok' : 'wait'}`} />
        <button className='btn ghost' onClick={() => setMenu(true)}>
          •••
        </button>
      </header>

      <div className='session-body'>
        <TerminalView
          ref={agentRef}
          connId={connId}
          tmuxName={session.tmuxName}
          cwd={session.cwd}
          fontSize={fontSize}
          visible={tab === 'agent'}
          direct={direct}
          onCtrlUsed={() => armCtrl(false)}
        />
        {shellOpened && (
          <TerminalView
            ref={shellRef}
            connId={connId}
            tmuxName={shellTmuxName(session.tmuxName)}
            cwd={session.cwd}
            fontSize={fontSize}
            visible={tab === 'shell'}
            direct={direct}
            onCtrlUsed={() => armCtrl(false)}
          />
        )}
        {/* stays mounted so an edit in progress survives a look at the agent */}
        {filesOpened && (
          <FilesView root={session.cwd} visible={tab === 'files'} onUnsaved={setUnsaved} />
        )}
      </div>

      {tab !== 'files' && !direct && <ComposeBox onSend={(text) => active()?.submit(text)} />}
      {tab !== 'files' && (
        <div className='keybar'>
          <KeyButton
            label={direct ? 'compose' : 'keys'}
            title='Switch between the compose box and typing straight into the terminal'
            wide
            active={direct}
            onPress={() => {
              const next = !direct
              setDirect(next)
              if (next) window.setTimeout(() => active()?.focus(), 0)
            }}
          />
          <KeyButton label='pg↑' title='Scroll back one screen' onPress={() => active()?.page(-1)} />
          <KeyButton label='pg↓' title='Scroll forward one screen' onPress={() => active()?.page(1)} />
          <KeyButton label='esc' onPress={() => active()?.send('\x1b')} />
          <KeyButton label='tab' onPress={() => active()?.send('\t')} />
          <KeyButton label='⇧tab' title='Shift+Tab' onPress={() => active()?.send('\x1b[Z')} />
          <KeyButton label='ctrl' active={ctrl} onPress={() => armCtrl(!ctrl)} />
          <KeyButton label='^C' onPress={() => active()?.send('\x03')} />
          <KeyButton label='←' onPress={() => active()?.arrow('D')} />
          <KeyButton label='↓' onPress={() => active()?.arrow('B')} />
          <KeyButton label='↑' onPress={() => active()?.arrow('A')} />
          <KeyButton label='→' onPress={() => active()?.arrow('C')} />
          <KeyButton label='⏎' onPress={() => active()?.send('\r')} />
          <KeyButton label='/' onPress={() => active()?.send('/')} />
          <KeyButton label='|' onPress={() => active()?.send('|')} />
          <KeyButton label='~' onPress={() => active()?.send('~')} />
          <KeyButton label='-' onPress={() => active()?.send('-')} />
          <KeyButton label='paste' wide onPress={() => active()?.paste()} />
          <KeyButton
            label='hide ⌨'
            wide
            onPress={() => {
              active()?.blur()
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            }}
          />
        </div>
      )}

      {menu && (
        <Sheet title={session.tmuxName} onClose={() => setMenu(false)}>
          <div className='form'>
            <div className='hint mono'>{session.cwd}</div>
            <div className='field-label'>Text size</div>
            <div className='segmented'>
              <button onClick={() => setFontSize(fontSize - 1)}>A −</button>
              <button disabled>{fontSize} px</button>
              <button onClick={() => setFontSize(fontSize + 1)}>A +</button>
            </div>
            {tab !== 'files' && (
              <button className='btn block' onClick={openCopy}>
                Select &amp; copy text…
              </button>
            )}
            <button className='btn danger block' onClick={kill}>
              Kill session
            </button>
          </div>
        </Sheet>
      )}
      {copyText !== null && (
        <Sheet title='Select & copy' onClose={() => setCopyText(null)}>
          <div className='form'>
            <button
              className='btn block'
              onClick={() => {
                clipboardWrite(copyText)
                notify('Copied')
                setCopyText(null)
              }}
            >
              Copy all
            </button>
            <pre className='copy-text mono'>{copyText}</pre>
          </div>
        </Sheet>
      )}
    </div>
  )
}

/**
 * Where a message is written before it goes to the terminal. It is an ordinary
 * text field, so everything the iOS keyboard does works in it: dictation,
 * autocorrect, swipe typing, moving the cursor, paste. Typing straight into a
 * terminal sends every keystroke to the server as it happens, which is slow
 * and which dictation — it keeps rewriting what it has heard — turns into
 * repeated text.
 *
 * The field is deliberately not controlled by React: writing its value back
 * during dictation would interrupt it.
 */
function ComposeBox({ onSend }: { onSend: (text: string) => void }): React.JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const [empty, setEmpty] = useState(true)
  const sendRef = useRef(onSend)
  sendRef.current = onSend

  const resize = (): void => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 132)}px`
    setEmpty(area.value === '')
  }

  const send = (): void => {
    const area = areaRef.current
    if (!area) return
    const text = area.value
    area.value = ''
    resize()
    sendRef.current(text)
  }

  return (
    <div className='compose'>
      <textarea
        ref={areaRef}
        className='compose-input'
        rows={1}
        placeholder='Message — type or dictate, then send'
        enterKeyHint='send'
        autoCapitalize='sentences'
        onInput={resize}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      <KeyButton label={empty ? '⏎' : 'Send'} title='Send to the terminal' className='compose-send' onPress={send} />
    </div>
  )
}

// =====================================================================
// Files
// =====================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface OpenFile {
  entry: TreeEntry
  /** null while loading */
  doc: (EditableText & { sha: string; size: number; writable: boolean }) | null
}

function FilesView({
  root,
  visible,
  onUnsaved
}: {
  root: string
  visible: boolean
  onUnsaved: (unsaved: boolean) => void
}): React.JSX.Element {
  const remote = useApp((s) => s.remote)
  const [dir, setDir] = useState(root)
  const [hidden, setHidden] = useState(false)
  const [entries, setEntries] = useState<TreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [file, setFile] = useState<OpenFile | null>(null)
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const onUnsavedRef = useRef(onUnsaved)
  onUnsavedRef.current = onUnsaved

  useEffect(() => {
    onUnsavedRef.current(dirty)
  }, [dirty])
  useEffect(() => () => onUnsavedRef.current(false), [])

  useEffect(() => {
    if (!remote) return undefined
    let cancelled = false
    setEntries(null)
    setError(null)
    remote
      .lsTree(dir, hidden)
      .then((list) => {
        if (cancelled) return
        const isDir = (e: TreeEntry): boolean => e.type === 'dir' || e.linkTargetType === 'dir'
        setEntries(
          [...list].sort(
            (a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name)
          )
        )
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err))
      })
    return () => {
      cancelled = true
    }
  }, [remote, dir, hidden, reload])

  const load = (entry: TreeEntry): void => {
    if (!remote) return
    setFile({ entry, doc: null })
    setEditing(false)
    setDirty(false)
    remote
      .readFile(entry.path)
      .then((f) => {
        const decoded = decodeText(f.bytes, f.truncated)
        setFile((cur) =>
          cur?.entry.path === entry.path
            ? { entry, doc: { ...decoded, sha: f.sha, size: f.size, writable: f.writable } }
            : cur
        )
      })
      .catch((err) => {
        setFile((cur) => (cur?.entry.path === entry.path ? null : cur))
        notify(errText(err))
      })
  }

  const open = (entry: TreeEntry): void => {
    if (entry.type === 'dir' || entry.linkTargetType === 'dir') {
      setDir(entry.path)
      return
    }
    load(entry)
  }

  /** Runs `then` straight away, or after the user agrees to lose their edits. */
  const guardUnsaved = (then: () => void): void => {
    if (!dirty) {
      then()
      return
    }
    void confirmAsk({
      title: 'Discard unsaved changes?',
      message: `Your changes to ${file?.entry.name ?? 'this file'} are not saved.`,
      okLabel: 'Discard',
      danger: true
    }).then(({ ok }) => {
      if (ok) then()
    })
  }

  const closeFile = (): void =>
    guardUnsaved(() => {
      setFile(null)
      setEditing(false)
      setDirty(false)
      setReload((n) => n + 1)
    })

  const stopEditing = (): void =>
    guardUnsaved(() => {
      setEditing(false)
      setDirty(false)
    })

  const save = async (force = false): Promise<void> => {
    const area = areaRef.current
    if (!file?.doc || !area || !remote || saving) return
    const { entry, doc } = file
    const text = area.value
    setSaving(true)
    try {
      const res = await remote.writeFile(entry.path, encodeText(text, doc.eol), doc.sha, force)
      setFile({ entry, doc: { ...doc, text, sha: res.sha, size: res.size } })
      // the user may have kept typing while the save was on its way
      setDirty(areaRef.current !== null && areaRef.current.value !== text)
      notify('Saved')
    } catch (err) {
      if (err instanceof RemoteError && err.code === 'conflict') {
        const gone = err.message === 'deleted'
        setSaving(false)
        const { ok } = await confirmAsk({
          title: gone ? 'The file was deleted' : 'The file changed on the server',
          message: gone
            ? `${entry.name} no longer exists on the server. Save your version anyway?`
            : `${entry.name} was modified after you opened it, perhaps by the agent. ` +
              'Saving will replace those changes with your version.',
          okLabel: gone ? 'Save anyway' : 'Overwrite',
          danger: true
        })
        if (ok) await save(true)
        return
      }
      notify(errText(err))
    } finally {
      setSaving(false)
    }
  }

  /** Types into the editor the way the keyboard would, so undo still works. */
  const insert = (text: string): void => {
    const area = areaRef.current
    if (!area) return
    area.focus()
    if (!document.execCommand('insertText', false, text)) {
      area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  const moveCursor = (by: number): void => {
    const area = areaRef.current
    if (!area) return
    const at = by < 0 ? area.selectionStart : area.selectionEnd
    const next = Math.max(0, Math.min(area.value.length, at + by))
    area.setSelectionRange(next, next)
  }
  const history = (command: 'undo' | 'redo'): void => {
    areaRef.current?.focus()
    document.execCommand(command)
  }

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className='files' style={{ display: visible ? 'flex' : 'none' }}>
      {children}
    </div>
  )

  if (file) {
    const { entry, doc } = file
    const blocked =
      doc === null || doc.binary
        ? null
        : (doc.readOnly ?? (doc.writable ? null : 'You do not have permission to change this file.'))
    return shell(
      <>
        <div className='files-head'>
          <button className='btn ghost file-back' onClick={closeFile}>
            ‹ {entry.name}
            {dirty ? ' •' : ''}
          </button>
          <span className='grow' />
          {doc !== null && !editing && (
            <>
              <button className='btn ghost' onClick={() => load(entry)}>
                Reload
              </button>
              {!doc.binary && blocked === null && (
                <button className='btn ghost on' onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </>
          )}
          {doc !== null && editing && (
            <>
              <button className='btn ghost' disabled={saving} onClick={stopEditing}>
                {dirty ? 'Discard' : 'Done'}
              </button>
              <button
                className='btn primary'
                disabled={!dirty || saving || !remote}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
        {doc === null ? (
          <div className='empty'>Loading…</div>
        ) : doc.binary ? (
          <div className='empty'>This does not look like a text file.</div>
        ) : editing ? (
          <>
            {!remote && <div className='hint pad'>Reconnecting… you can save once the host is back.</div>}
            <textarea
              key={entry.path}
              ref={areaRef}
              className='file-edit mono'
              defaultValue={doc.text}
              wrap='off'
              spellCheck={false}
              autoCapitalize='off'
              autoCorrect='off'
              autoComplete='off'
              onInput={(e) => setDirty(e.currentTarget.value !== doc.text)}
            />
            <div className='keybar'>
              <KeyButton label='tab' onPress={() => insert('\t')} />
              <KeyButton label='←' onPress={() => moveCursor(-1)} />
              <KeyButton label='→' onPress={() => moveCursor(1)} />
              <KeyButton label='undo' wide onPress={() => history('undo')} />
              <KeyButton label='redo' wide onPress={() => history('redo')} />
              {['{', '}', '[', ']', '(', ')', '<', '>', '=', '"', "'", ';', '/', '\\', '|', '_', '#', '$'].map(
                (ch) => (
                  <KeyButton key={ch} label={ch} onPress={() => insert(ch)} />
                )
              )}
              <KeyButton label='hide ⌨' wide onPress={() => areaRef.current?.blur()} />
            </div>
          </>
        ) : (
          <>
            {blocked !== null && (
              <div className='hint pad'>
                {doc.size > MAX_VIEW_BYTES
                  ? `Showing the first ${formatSize(MAX_VIEW_BYTES)} of ${formatSize(doc.size)}. `
                  : ''}
                {blocked}
              </div>
            )}
            <pre className='file-text mono'>{doc.text}</pre>
          </>
        )}
      </>
    )
  }

  const atRoot = dir === root || dir === '/'
  const parent = dir.replace(/\/[^/]+\/?$/, '') || '/'
  const shown = dir.startsWith(root) ? '.' + dir.slice(root.length) : dir

  return shell(
    <>
      <div className='files-head'>
        <button className='btn ghost' disabled={atRoot} onClick={() => setDir(parent)}>
          ‹ Up
        </button>
        <span className='row-sub mono grow'>{shown}</span>
        <button className={`btn ghost${hidden ? ' on' : ''}`} onClick={() => setHidden((v) => !v)}>
          {hidden ? 'Hide dotfiles' : 'Show dotfiles'}
        </button>
      </div>
      <div className='scroll'>
        {!remote && <div className='empty'>Reconnecting…</div>}
        {error && <div className='empty'>{error}</div>}
        {remote && !error && entries === null && <div className='empty'>Loading…</div>}
        {entries?.length === 0 && <div className='empty'>Empty directory.</div>}
        {entries?.map((e) => {
          const isDir = e.type === 'dir' || e.linkTargetType === 'dir'
          return (
            <div key={e.path} className='row file' onClick={() => open(e)}>
              <span className='file-icon'>{isDir ? '▸' : '·'}</span>
              <div className='row-main'>
                <div className={`row-title mono${isDir ? ' dir' : ''}`}>{e.name}</div>
              </div>
              {!isDir && <span className='row-sub'>{formatSize(e.size)}</span>}
            </div>
          )
        })}
      </div>
    </>
  )
}
