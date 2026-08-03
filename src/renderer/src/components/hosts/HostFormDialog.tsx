import { useState } from 'react'
import type { AuthKind, HostSaveInput, HostTestResult } from '@shared/domain'
import { api } from '@/api'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const FIELD: React.CSSProperties = { marginBottom: 12 }

export default function HostFormDialog(): React.JSX.Element {
  const editingId = useUiStore((s) => s.hostFormEditingId)
  const closeHostForm = useUiStore((s) => s.closeHostForm)
  const addToast = useUiStore((s) => s.addToast)
  const saveHost = useConnectionStore((s) => s.saveHost)
  const editing = useConnectionStore((s) =>
    editingId ? s.hosts.find((h) => h.id === editingId) : undefined
  )

  const [label, setLabel] = useState(editing?.label ?? '')
  const [host, setHost] = useState(editing?.host ?? '')
  const [port, setPort] = useState(String(editing?.port ?? 22))
  const [username, setUsername] = useState(editing?.username ?? '')
  const [authKind, setAuthKind] = useState<AuthKind>(editing?.authKind ?? 'key')
  const [keyPath, setKeyPath] = useState(editing?.keyPath ?? '~/.ssh/id_ed25519')
  const [passphrase, setPassphrase] = useState('')
  const [passTouched, setPassTouched] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HostTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const buildInput = (): HostSaveInput => ({
    id: editing?.id,
    label: label.trim(),
    host: host.trim(),
    port: parseInt(port, 10) || 22,
    username: username.trim(),
    authKind,
    keyPath: authKind === 'key' ? keyPath.trim() : undefined,
    // undefined = keep stored passphrase, null = clear, string = set
    passphrase:
      authKind === 'key' && passTouched ? (passphrase === '' ? null : passphrase) : undefined
  })

  const valid =
    label.trim() !== '' &&
    host.trim() !== '' &&
    username.trim() !== '' &&
    (authKind !== 'key' || keyPath.trim() !== '')

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.hostsTest(buildInput()))
    } catch (err) {
      setTestResult({ ok: false, error: errText(err) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveHost(buildInput())
      addToast('success', `Host "${label.trim()}" saved`)
      closeHostForm()
    } catch {
      // saveHost already surfaced the error via toast; keep the dialog open
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeHostForm()
      }}
    >
      <div className='ra-dialog' style={{ width: 480 }}>
        <h2>{editing ? 'Edit host' : 'Add host'}</h2>

        <div style={FIELD}>
          <label className='ra-label'>Label</label>
          <input
            className='ra-input'
            style={{ width: '100%' }}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='dev box'
            autoFocus
          />
        </div>

        <div style={{ ...FIELD, display: 'flex', gap: 10 }}>
          <div style={{ flex: 3 }}>
            <label className='ra-label'>Host</label>
            <input
              className='ra-input'
              style={{ width: '100%' }}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder='server.example.com'
              spellCheck={false}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className='ra-label'>Port</label>
            <input
              className='ra-input'
              style={{ width: '100%' }}
              type='number'
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </div>

        <div style={FIELD}>
          <label className='ra-label'>Username</label>
          <input
            className='ra-input'
            style={{ width: '100%' }}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder='ubuntu'
            spellCheck={false}
          />
        </div>

        <div style={FIELD}>
          <label className='ra-label'>Authentication</label>
          <select
            className='ra-input'
            style={{ width: '100%' }}
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as AuthKind)}
          >
            <option value='key'>SSH key file</option>
            <option value='agent'>ssh-agent</option>
          </select>
        </div>

        {authKind === 'key' && (
          <>
            <div style={FIELD}>
              <label className='ra-label'>Key path</label>
              <input
                className='ra-input'
                style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div style={FIELD}>
              <label className='ra-label'>Passphrase</label>
              <input
                className='ra-input'
                style={{ width: '100%' }}
                type='password'
                value={passphrase}
                onChange={(e) => {
                  setPassTouched(true)
                  setPassphrase(e.target.value)
                }}
                placeholder={editing?.hasPassphrase ? 'unchanged' : 'none'}
              />
              {editing?.hasPassphrase && passTouched && passphrase === '' && (
                <div style={{ fontSize: 11.5, color: 'var(--ra-yellow)', marginTop: 3 }}>
                  Stored passphrase will be cleared on save
                </div>
              )}
            </div>
          </>
        )}

        {testResult && (
          <div
            style={{
              ...FIELD,
              fontSize: 12,
              padding: '8px 10px',
              borderRadius: 'var(--ra-radius)',
              border: `1px solid ${testResult.ok ? 'var(--ra-green)' : 'var(--ra-red)'}`,
              color: testResult.ok ? 'var(--ra-green)' : 'var(--ra-red)',
              wordBreak: 'break-all'
            }}
          >
            {testResult.ok ? 'Connection OK' : `Connection failed: ${testResult.error ?? 'unknown error'}`}
            {testResult.hostKeyFingerprint && (
              <div style={{ color: 'var(--ra-text-dim)', marginTop: 4, fontFamily: 'var(--ra-mono)' }}>
                {testResult.hostKeyAlgo ? `${testResult.hostKeyAlgo} ` : ''}
                {testResult.hostKeyFingerprint}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className='ra-btn' disabled={!valid || testing} onClick={() => void test()}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div style={{ flex: 1 }} />
          <button className='ra-btn' onClick={closeHostForm}>
            Cancel
          </button>
          <button className='ra-btn primary' disabled={!valid || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
