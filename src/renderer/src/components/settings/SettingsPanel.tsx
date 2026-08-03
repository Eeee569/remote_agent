/**
 * The Claude Code configuration surface: left section nav + scrollable
 * content area. Project-scope sections (project settings, MCP servers,
 * Codex wizard) hide when opened in user-only mode (projectId ===
 * '__settings__' or empty repoPath).
 */
import { useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { SettingsTarget } from '@shared/domain'
import SettingsFormEditor from './SettingsFormEditor'
import McpServersEditor from './McpServersEditor'
import AgentsEditor from './AgentsEditor'
import ClaudeMdEditor from './ClaudeMdEditor'
import AddCodexWizard from './AddCodexWizard'
import { InstallPanelContent } from './InstallPanel'

type SectionId = 'user' | 'project' | 'mcp' | 'agents' | 'claudemd' | 'install'

interface SectionSpec {
  id: SectionId
  label: string
  title: string
  subtitle: string
  projectOnly?: boolean
}

const SECTIONS: readonly SectionSpec[] = [
  {
    id: 'user',
    label: 'User settings',
    title: 'User settings',
    subtitle: 'Apply to every project on this host (~/.claude/settings.json)'
  },
  {
    id: 'project',
    label: 'Project settings',
    title: 'Project settings',
    subtitle: 'Checked-in settings.json plus your personal settings.local.json',
    projectOnly: true
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    title: 'MCP servers',
    subtitle: 'Model Context Protocol servers available to Claude Code in this project (.mcp.json)',
    projectOnly: true
  },
  {
    id: 'agents',
    label: 'Agents',
    title: 'Agents',
    subtitle: 'Custom sub-agents Claude Code can delegate work to'
  },
  {
    id: 'claudemd',
    label: 'CLAUDE.md',
    title: 'CLAUDE.md',
    subtitle: 'Instructions loaded into every Claude Code session'
  }
]

const INSTALL_SECTION: SectionSpec = {
  id: 'install',
  label: 'Install / tools',
  title: 'Install / tools',
  subtitle: 'Remote tooling status for this host'
}

function NavItem(props: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div
      style={{
        padding: '7px 12px',
        borderRadius: 'var(--ra-radius)',
        cursor: 'pointer',
        fontSize: 12.5,
        color: props.active ? 'var(--ra-text)' : 'var(--ra-text-dim)',
        background: props.active ? 'var(--ra-bg-active)' : 'transparent',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}
      onMouseEnter={(e) => {
        if (!props.active) e.currentTarget.style.background = 'var(--ra-bg-hover)'
      }}
      onMouseLeave={(e) => {
        if (!props.active) e.currentTarget.style.background = 'transparent'
      }}
      onClick={props.onClick}
    >
      {props.label}
    </div>
  )
}

function ScopeToggle(props: {
  value: 'user' | 'project'
  onChange: (v: 'user' | 'project') => void
  projectDisabled: boolean
  userLabel: string
  projectLabel: string
}): React.JSX.Element {
  const btn = (v: 'user' | 'project', label: string, disabled: boolean): React.JSX.Element => (
    <button
      className='ra-btn'
      disabled={disabled}
      style={
        props.value === v
          ? { background: 'var(--ra-bg-active)', borderColor: 'var(--ra-accent)' }
          : undefined
      }
      onClick={() => props.onChange(v)}
    >
      {label}
    </button>
  )
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
      {btn('user', props.userLabel, false)}
      {btn('project', props.projectLabel, props.projectDisabled)}
    </div>
  )
}

const SettingsPanel: React.FC<
  IDockviewPanelProps<{ hostId: string; projectId: string; repoPath: string }>
> = (props) => {
  const { hostId, projectId, repoPath } = props.params
  const userOnly = projectId === '__settings__' || repoPath === ''
  const [section, setSection] = useState<SectionId>('user')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const [agentsScope, setAgentsScope] = useState<'user' | 'project'>(userOnly ? 'user' : 'project')
  const [mdScope, setMdScope] = useState<'user' | 'project'>(userOnly ? 'user' : 'project')

  const target = (
    scope: 'user' | 'project',
    file: SettingsTarget['file']
  ): SettingsTarget => ({
    hostId,
    scope,
    projectPath: scope === 'project' ? repoPath : undefined,
    file
  })

  const visibleSections = SECTIONS.filter((s) => !(s.projectOnly === true && userOnly))
  const active =
    section === 'install'
      ? INSTALL_SECTION
      : (visibleSections.find((s) => s.id === section) ?? visibleSections[0])

  let body: React.JSX.Element
  switch (active.id) {
    case 'user':
      body = <SettingsFormEditor target={target('user', 'settings')} />
      break
    case 'project':
      body = (
        <div>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              settings.json <span style={{ color: 'var(--ra-text-faint)', fontWeight: 400 }}>— shared, checked in</span>
            </div>
            <SettingsFormEditor target={target('project', 'settings')} />
          </div>
          <div
            style={{
              border: '1px solid var(--ra-border)',
              borderRadius: 8,
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 12px',
                background: 'var(--ra-bg-raised)',
                cursor: 'pointer',
                userSelect: 'none'
              }}
              onClick={() => setLocalOpen((v) => !v)}
            >
              <span style={{ color: 'var(--ra-text-faint)', fontSize: 11 }}>
                {localOpen ? '▾' : '▸'}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>settings.local.json</span>
              <span style={{ color: 'var(--ra-text-faint)', fontSize: 12 }}>
                — personal, gitignored
              </span>
            </div>
            {localOpen && (
              <div style={{ padding: '12px 12px 4px' }}>
                <SettingsFormEditor target={target('project', 'settingsLocal')} />
              </div>
            )}
          </div>
        </div>
      )
      break
    case 'mcp':
      body = <McpServersEditor hostId={hostId} repoPath={repoPath} />
      break
    case 'agents':
      body = (
        <div>
          <ScopeToggle
            value={userOnly ? 'user' : agentsScope}
            onChange={setAgentsScope}
            projectDisabled={userOnly}
            userLabel='User agents (~/.claude/agents)'
            projectLabel='Project agents (.claude/agents)'
          />
          <AgentsEditor
            key={userOnly ? 'user' : agentsScope}
            hostId={hostId}
            scope={userOnly ? 'user' : agentsScope}
            projectPath={!userOnly && agentsScope === 'project' ? repoPath : undefined}
          />
        </div>
      )
      break
    case 'claudemd':
      body = (
        <div>
          <ScopeToggle
            value={userOnly ? 'user' : mdScope}
            onChange={setMdScope}
            projectDisabled={userOnly}
            userLabel='User (~/.claude/CLAUDE.md)'
            projectLabel='Project (CLAUDE.md)'
          />
          <ClaudeMdEditor
            key={userOnly ? 'user' : mdScope}
            target={target(userOnly ? 'user' : mdScope, 'claudeMd')}
          />
        </div>
      )
      break
    case 'install':
      body = <InstallPanelContent hostId={hostId} />
      break
  }

  return (
    <div style={{ height: '100%', display: 'flex', minHeight: 0 }}>
      <div
        style={{
          width: 190,
          flexShrink: 0,
          background: 'var(--ra-bg-raised)',
          borderRight: '1px solid var(--ra-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: 8,
          overflowY: 'auto'
        }}
      >
        {visibleSections.map((s) => (
          <NavItem key={s.id} label={s.label} active={active.id === s.id} onClick={() => setSection(s.id)} />
        ))}
        {!userOnly && (
          <NavItem label='Codex sub-agent' active={false} onClick={() => setWizardOpen(true)} />
        )}
        <div style={{ flex: 1 }} />
        <NavItem
          label={INSTALL_SECTION.label}
          active={active.id === 'install'}
          onClick={() => setSection('install')}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 20 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 14 }}>{active.title}</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--ra-text-dim)' }}>
          {active.subtitle}
        </p>
        {body}
      </div>

      {wizardOpen && !userOnly && (
        <AddCodexWizard hostId={hostId} repoPath={repoPath} onClose={() => setWizardOpen(false)} />
      )}
    </div>
  )
}

export default SettingsPanel
