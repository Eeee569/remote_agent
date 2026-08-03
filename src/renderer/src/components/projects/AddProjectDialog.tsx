import { useState } from 'react'
import RemoteDirPicker from '@/components/common/RemoteDirPicker'
import { useConnectionStore } from '@/stores/connection'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? ''
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

  if (!hostId) return null

  const valid = name.trim() !== '' && repoPath.trim() !== ''

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
          <label className='ra-label'>Repository path (on server)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className='ra-input'
              style={{ flex: 1, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
              value={repoPath}
              onChange={(e) => {
                setRepoPath(e.target.value)
                if (!nameTouched) setName(basename(e.target.value))
              }}
              placeholder='/home/user/myrepo'
              spellCheck={false}
            />
            <button className='ra-btn' onClick={() => setPickerOpen(true)}>
              Browse…
            </button>
          </div>
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
