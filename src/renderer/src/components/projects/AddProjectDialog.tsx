import { useEffect, useState } from 'react'
import { api } from '@/api'
import RemoteDirPicker from '@/components/common/RemoteDirPicker'
import { describeProjectTarget, type ProjectTarget } from '@/components/projects/project-target'
import { useConnectionStore } from '@/stores/connection'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? ''
}

const PROBE_DEBOUNCE_MS = 400

const TONE_COLOR: Record<ProjectTarget['tone'], string> = {
  info: 'var(--ra-text-dim)',
  warn: 'var(--ra-warn, #d9a63f)',
  error: 'var(--ra-error, #e5636e)'
}

/**
 * Looks at the chosen path so the dialog can say what adding it will do — the
 * directory may be created, `git init`ed, and have its contents committed.
 */
function useProjectTarget(hostId: string | null, path: string): ProjectTarget | null {
  const [target, setTarget] = useState<ProjectTarget | null>(null)

  useEffect(() => {
    const trimmed = path.trim()
    if (hostId === null || trimmed === '') {
      setTarget(null)
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [stat, git] = await Promise.all([
            api.fsStat(hostId, trimmed),
            api.gitStatus(hostId, trimmed).catch(() => null)
          ])
          // only a plain directory needs a file count, to tell empty from not
          let entryCount: number | undefined
          if (stat?.isDir === true && git?.isRepo !== true) {
            entryCount = await api
              .fsLsTree(hostId, trimmed)
              .then((e) => e.length)
              .catch(() => undefined)
          }
          if (!cancelled) {
            const known = entryCount !== undefined ? { entryCount } : {}
            setTarget(describeProjectTarget({ stat, git, ...known }))
          }
        } catch {
          // an unreachable host or unreadable path leaves the hint off rather
          // than blocking a path the server may well accept
          if (!cancelled) setTarget(null)
        }
      })()
    }, PROBE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hostId, path])

  return target
}

export default function AddProjectDialog(): React.JSX.Element | null {
  const hostId = useConnectionStore((s) => s.activeHostId)
  const addProject = useProjectsStore((s) => s.addProject)
  const closeAddProject = useUiStore((s) => s.closeAddProject)
  const addToast = useUiStore((s) => s.addToast)

  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [repoPath, setRepoPath] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const target = useProjectTarget(hostId, repoPath)

  if (!hostId) return null

  const valid = name.trim() !== '' && repoPath.trim() !== '' && target?.blocked !== true

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await addProject(hostId, name.trim(), repoPath.trim())
      addToast('success', `Project "${name.trim()}" added`)
      closeAddProject()
    } catch {
      // store already toasted the error; keep the dialog open
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeAddProject()
      }}
    >
      <div className='ra-dialog' style={{ width: 480 }}>
        <h2>Add project</h2>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Directory (on server)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className='ra-input'
              style={{ flex: 1, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
              value={repoPath}
              onChange={(e) => {
                setRepoPath(e.target.value)
                if (!nameTouched) setName(basename(e.target.value))
              }}
              placeholder='/home/user/myproject'
              spellCheck={false}
            />
            <button
              className='ra-btn'
              title='Pick an existing folder, or create a new one on the server'
              onClick={() => setPickerOpen(true)}
            >
              Browse or create…
            </button>
          </div>
          {target && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: TONE_COLOR[target.tone] }}>
              {target.message}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Name</label>
          <input
            className='ra-input'
            style={{ width: '100%' }}
            value={name}
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value)
            }}
            placeholder='my project'
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className='ra-btn' onClick={closeAddProject}>
            Cancel
          </button>
          <button className='ra-btn primary' disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <RemoteDirPicker
          hostId={hostId}
          initialPath={repoPath.trim() || undefined}
          dirsOnly
          allowCreate
          onClose={() => setPickerOpen(false)}
          onPick={(p) => {
            setRepoPath(p)
            if (!nameTouched) setName(basename(p))
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
