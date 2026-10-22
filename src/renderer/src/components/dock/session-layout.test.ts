import { describe, expect, it } from 'vitest'
import type { DockviewApi } from 'dockview'
import type { SessionMeta } from '@shared/domain'
import { shellTmuxName } from '@shared/helper-protocol'
import {
  addSessionPanels,
  applySessionLayout,
  closeSessionPanels,
  collapseSessionPanels,
  expandSessionPanels,
  gridShape,
  isSessionTabbed,
  openPanelCount,
  panelTitle,
  parseSessionPanelId,
  projectAccent,
  resolveFocused,
  sessionAccent,
  sessionPanelIds,
  sessionsForMode,
  tileDirection,
  visibleSessions
} from './session-layout'

// ---------------- a minimal stand-in for the dockview api ----------------

interface AddOptions {
  id: string
  title?: string
  position?: {
    referencePanel?: string
    referenceGroup?: FakeGroup
    direction?: string
  }
}

class FakePanel {
  title: string
  readonly api: {
    group: FakeGroup
    moveTo(o: { group: FakeGroup }): void
    setActive(): void
    setTitle(t: string): void
    setSize(): void
  }

  constructor(
    readonly id: string,
    title: string,
    group: FakeGroup,
    private readonly dock: FakeDock
  ) {
    this.title = title
    this.api = {
      group,
      moveTo: (o) => this.dock.move(this, o.group),
      setActive: () => undefined,
      setTitle: (t) => {
        this.title = t
      },
      setSize: () => undefined
    }
  }
}

class FakeGroup {
  readonly panels: FakePanel[] = []
  readonly api = { setSize: (): void => undefined }
}

class FakeDock {
  readonly groups: FakeGroup[] = []
  readonly width = 1200
  readonly height = 800
  private readonly byId = new Map<string, FakePanel>()

  get panels(): FakePanel[] {
    return [...this.byId.values()]
  }

  getPanel(id: string): FakePanel | undefined {
    return this.byId.get(id)
  }

  addGroup(opts?: { referenceGroup?: FakeGroup; direction?: string }): FakeGroup {
    const group = new FakeGroup()
    const at = opts?.referenceGroup ? this.groups.indexOf(opts.referenceGroup) : -1
    if (at === -1) this.groups.push(group)
    else this.groups.splice(at + 1, 0, group)
    return group
  }

  addPanel(opts: AddOptions): FakePanel {
    const group = this.resolveGroup(opts)
    const panel = new FakePanel(opts.id, opts.title ?? opts.id, group, this)
    group.panels.push(panel)
    this.byId.set(panel.id, panel)
    return panel
  }

  removePanel(panel: FakePanel): void {
    this.byId.delete(panel.id)
    this.detach(panel)
  }

  move(panel: FakePanel, group: FakeGroup): void {
    this.detach(panel)
    panel.api.group = group
    group.panels.push(panel)
  }

  private detach(panel: FakePanel): void {
    const group = panel.api.group
    const at = group.panels.indexOf(panel)
    if (at !== -1) group.panels.splice(at, 1)
    // dockview drops groups as soon as they run empty
    if (group.panels.length === 0) {
      const gi = this.groups.indexOf(group)
      if (gi !== -1) this.groups.splice(gi, 1)
    }
  }

  private resolveGroup(opts: AddOptions): FakeGroup {
    const position = opts.position
    if (position?.referenceGroup) return position.referenceGroup
    if (position?.referencePanel !== undefined) {
      const reference = this.byId.get(position.referencePanel)
      if (!reference) throw new Error(`no such reference panel: ${position.referencePanel}`)
      return position.direction === undefined || position.direction === 'within'
        ? reference.api.group
        : this.addGroup({ referenceGroup: reference.api.group, direction: position.direction })
    }
    return this.addGroup()
  }
}

function dock(): { dv: DockviewApi; fake: FakeDock } {
  const fake = new FakeDock()
  return { dv: fake as unknown as DockviewApi, fake }
}

function session(id: string, tmuxName: string): SessionMeta {
  return {
    id,
    projectId: 'p_1',
    tmuxName,
    agent: 'claude',
    mode: 'worktree',
    cwd: `/home/u/${tmuxName}`,
    createdAt: 0
  }
}

const CTX = { hostId: 'h_1', projectId: 'p_1' }

/** Panel ids per group, in group order — the shape assertions read off this. */
function shape(fake: FakeDock): string[][] {
  return fake.groups.map((g) => g.panels.map((p) => p.id))
}

// ---------------- pure helpers ----------------

describe('panel ids', () => {
  it('round-trips every kind', () => {
    expect(sessionPanelIds('s_1')).toEqual(['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1'])
    expect(parseSessionPanelId('term:s_1')).toEqual({ kind: 'term', sessionId: 's_1' })
    expect(parseSessionPanelId('view:s_1')).toEqual({ kind: 'view', sessionId: 's_1' })
  })

  it('rejects ids that are not session panels', () => {
    expect(parseSessionPanelId('settings')).toBeNull()
    expect(parseSessionPanelId('gone:s_1')).toBeNull()
    expect(parseSessionPanelId('term:')).toBeNull()
    expect(parseSessionPanelId(':s_1')).toBeNull()
  })
})

describe('panelTitle', () => {
  it('names the session on every tab in focus mode', () => {
    expect(panelTitle('term', 'ra-demo', 'focus')).toBe('ra-demo')
    expect(panelTitle('tree', 'ra-demo', 'focus')).toBe('Files — ra-demo')
  })

  it('keeps tabs short when tiled — the group is already one session', () => {
    expect(panelTitle('term', 'ra-demo', 'columns')).toBe('ra-demo')
    expect(panelTitle('shell', 'ra-demo', 'rows')).toBe('Shell')
    expect(panelTitle('tree', 'ra-demo', 'columns')).toBe('Files')
    expect(panelTitle('view', 'ra-demo', 'rows')).toBe('Viewer')
  })
})

describe('tileDirection', () => {
  it('splits sideways for columns and downwards for rows', () => {
    expect(tileDirection('columns')).toBe('right')
    expect(tileDirection('rows')).toBe('below')
  })
})

describe('visibleSessions', () => {
  it('hides only sessions whose terminal was closed', () => {
    const a = session('s_1', 'ra-a')
    const b = session('s_2', 'ra-b')
    expect(visibleSessions([a, b], new Set(['term:s_1']))).toEqual([b])
    // an auxiliary panel being closed does not hide the session
    expect(visibleSessions([a, b], new Set(['tree:s_1']))).toEqual([a, b])
  })
})

describe('resolveFocused', () => {
  const list = [session('s_1', 'ra-a'), session('s_2', 'ra-b')]

  it('keeps the requested session while it is around and open', () => {
    expect(resolveFocused(list, 's_2', new Set())).toBe('s_2')
  })

  it('falls back to the first open session', () => {
    expect(resolveFocused(list, 'gone', new Set())).toBe('s_1')
    expect(resolveFocused(list, 's_1', new Set(['term:s_1']))).toBe('s_2')
    expect(resolveFocused(list, null, new Set())).toBe('s_1')
  })

  it('is null when every session is closed', () => {
    expect(resolveFocused(list, 's_1', new Set(['term:s_1', 'term:s_2']))).toBeNull()
    expect(resolveFocused([], null, new Set())).toBeNull()
  })
})

describe('sessionsForMode', () => {
  const list = [session('s_1', 'ra-a'), session('s_2', 'ra-b'), session('s_3', 'ra-c')]

  it('shows one session in focus mode', () => {
    expect(sessionsForMode(list, 'focus', 's_2', new Set()).map((s) => s.id)).toEqual(['s_2'])
  })

  it('shows every open session when tiled', () => {
    expect(sessionsForMode(list, 'grid', 's_2', new Set()).map((s) => s.id)).toEqual([
      's_1',
      's_2',
      's_3'
    ])
    expect(sessionsForMode(list, 'columns', null, new Set(['term:s_2'])).map((s) => s.id)).toEqual([
      's_1',
      's_3'
    ])
  })

  it('shows nothing when the focused session is the only one and it is closed', () => {
    expect(sessionsForMode([list[0]], 'focus', 's_1', new Set(['term:s_1']))).toEqual([])
  })
})

describe('gridShape', () => {
  it('is as square as possible, never taller than wide', () => {
    expect(gridShape(0)).toEqual({ cols: 0, rows: 0 })
    expect(gridShape(1)).toEqual({ cols: 1, rows: 1 })
    expect(gridShape(2)).toEqual({ cols: 2, rows: 1 })
    expect(gridShape(3)).toEqual({ cols: 2, rows: 2 })
    expect(gridShape(4)).toEqual({ cols: 2, rows: 2 })
    expect(gridShape(5)).toEqual({ cols: 3, rows: 2 })
    expect(gridShape(6)).toEqual({ cols: 3, rows: 2 })
    expect(gridShape(9)).toEqual({ cols: 3, rows: 3 })
    expect(gridShape(10)).toEqual({ cols: 4, rows: 3 })
  })
})

describe('sessionAccent', () => {
  it('is stable per session and stays inside the palette', () => {
    expect(sessionAccent('s_1')).toBe(sessionAccent('s_1'))
    expect(sessionAccent('s_1')).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('projectAccent', () => {
  it('is stable per project and stays inside the palette', () => {
    expect(projectAccent('p_1')).toBe(projectAccent('p_1'))
    expect(projectAccent('p_1')).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('does not simply mirror the same-id session accent', () => {
    // project and session ids share a namespace in the caller; the prefix
    // keeps a project from always landing on its like-named session's colour
    const differs = ['p_1', 'p_2', 'abc', 'x'].some((id) => projectAccent(id) !== sessionAccent(id))
    expect(differs).toBe(true)
  })
})

describe('shellTmuxName', () => {
  it('derives the companion shell session name', () => {
    expect(shellTmuxName('ra-demo-feature')).toBe('ra-demo-feature-shell')
  })
})

// ---------------- layout building ----------------

describe('addSessionPanels', () => {
  it('builds terminal | files / viewer and tabs later sessions in, in focus mode', () => {
    const { dv, fake } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' })
    expect(shape(fake)).toEqual([['term:s_1', 'shell:s_1'], ['tree:s_1'], ['view:s_1']])

    addSessionPanels(dv, session('s_2', 'ra-b'), { ...CTX, mode: 'focus' })
    expect(shape(fake)).toEqual([
      ['term:s_1', 'shell:s_1', 'term:s_2', 'shell:s_2'],
      ['tree:s_1', 'tree:s_2'],
      ['view:s_1', 'view:s_2']
    ])
  })

  it('gives each session its own group when tiled', () => {
    const { dv, fake } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'columns' })
    addSessionPanels(dv, session('s_2', 'ra-b'), { ...CTX, mode: 'columns' })
    expect(shape(fake)).toEqual([
      ['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1'],
      ['term:s_2', 'shell:s_2', 'tree:s_2', 'view:s_2']
    ])
  })

  it('adds only the requested kinds (older layouts gaining a shell)', () => {
    const { dv, fake } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' }, ['term', 'tree'])
    expect(shape(fake)).toEqual([['term:s_1'], ['tree:s_1']])

    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' }, ['shell'])
    expect(shape(fake)).toEqual([['term:s_1', 'shell:s_1'], ['tree:s_1']])
  })

  it('still places a panel when its usual neighbour was closed', () => {
    const { dv, fake } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' }, ['term'])
    // no tree panel to sit under: the viewer falls back to the terminal
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' }, ['view'])
    expect(shape(fake)).toEqual([['term:s_1'], ['view:s_1']])
  })
})

describe('applySessionLayout', () => {
  const sessions = [session('s_1', 'ra-a'), session('s_2', 'ra-b'), session('s_3', 'ra-c')]

  function focused(): { dv: DockviewApi; fake: FakeDock } {
    const built = dock()
    for (const s of sessions) addSessionPanels(built.dv, s, { ...CTX, mode: 'focus' })
    return built
  }

  it('tiles one group per session, in session order', () => {
    const { dv, fake } = focused()
    applySessionLayout(dv, sessions, { ...CTX, mode: 'columns' })
    expect(shape(fake)).toEqual([
      ['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1'],
      ['term:s_2', 'shell:s_2', 'tree:s_2', 'view:s_2'],
      ['term:s_3', 'shell:s_3', 'tree:s_3', 'view:s_3']
    ])
    expect(fake.getPanel('tree:s_2')?.title).toBe('Files')
  })

  it('rows tile the same way — only the split direction differs', () => {
    const { dv, fake } = focused()
    applySessionLayout(dv, sessions, { ...CTX, mode: 'rows' })
    expect(shape(fake)).toHaveLength(3)
    expect(shape(fake)[1]).toEqual(['term:s_2', 'shell:s_2', 'tree:s_2', 'view:s_2'])
  })

  it('folds tiles back into the focus frame', () => {
    const { dv, fake } = focused()
    applySessionLayout(dv, sessions, { ...CTX, mode: 'columns' })
    applySessionLayout(dv, sessions, { ...CTX, mode: 'focus' })
    expect(shape(fake)).toEqual([
      ['term:s_1', 'shell:s_1', 'term:s_2', 'shell:s_2', 'term:s_3', 'shell:s_3'],
      ['tree:s_1', 'tree:s_2', 'tree:s_3'],
      ['view:s_1', 'view:s_2', 'view:s_3']
    ])
    expect(fake.getPanel('tree:s_2')?.title).toBe('Files — ra-b')
  })

  it('leaves hidden sessions out of the tiling', () => {
    const { dv, fake } = focused()
    closeSessionPanels(dv, 's_2')
    applySessionLayout(dv, visibleSessions(sessions, new Set(['term:s_2'])), {
      ...CTX,
      mode: 'columns'
    })
    expect(shape(fake)).toEqual([
      ['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1'],
      ['term:s_3', 'shell:s_3', 'tree:s_3', 'view:s_3']
    ])
  })
})

describe('grid layout', () => {
  function tiled(count: number): { dv: DockviewApi; fake: FakeDock; sessions: SessionMeta[] } {
    const built = dock()
    const sessions = Array.from({ length: count }, (_, i) => session(`s_${i}`, `ra-${i}`))
    for (const s of sessions) addSessionPanels(built.dv, s, { ...CTX, mode: 'grid' })
    return { ...built, sessions }
  }

  it('gives every session a cell, in row-major order', () => {
    const { dv, fake, sessions } = tiled(4)
    applySessionLayout(dv, sessions, { ...CTX, mode: 'grid' })
    expect(shape(fake)).toEqual([
      ['term:s_0', 'shell:s_0', 'tree:s_0', 'view:s_0'],
      ['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1'],
      ['term:s_2', 'shell:s_2', 'tree:s_2', 'view:s_2'],
      ['term:s_3', 'shell:s_3', 'tree:s_3', 'view:s_3']
    ])
  })

  it('handles a ragged last row', () => {
    const { dv, fake, sessions } = tiled(3)
    applySessionLayout(dv, sessions, { ...CTX, mode: 'grid' })
    expect(shape(fake)).toHaveLength(3)
    expect(shape(fake)[2]).toEqual(['term:s_2', 'shell:s_2', 'tree:s_2', 'view:s_2'])
  })

  it('degenerates to a single row for one or two sessions', () => {
    const { dv, fake, sessions } = tiled(2)
    applySessionLayout(dv, sessions, { ...CTX, mode: 'grid' })
    expect(shape(fake)).toHaveLength(2)
  })
})

describe('expand / collapse inside a tile', () => {
  it('splits one session apart without touching the others', () => {
    const { dv, fake } = dock()
    const a = session('s_1', 'ra-a')
    const b = session('s_2', 'ra-b')
    addSessionPanels(dv, a, { ...CTX, mode: 'grid' })
    addSessionPanels(dv, b, { ...CTX, mode: 'grid' })
    expect(isSessionTabbed(dv, 's_1')).toBe(true)

    expandSessionPanels(dv, a)
    expect(isSessionTabbed(dv, 's_1')).toBe(false)
    expect(shape(fake)).toEqual([
      ['term:s_1', 'shell:s_1'],
      ['tree:s_1'],
      ['view:s_1'],
      ['term:s_2', 'shell:s_2', 'tree:s_2', 'view:s_2']
    ])
    // the other tile is still tabbed
    expect(isSessionTabbed(dv, 's_2')).toBe(true)
  })

  it('tabs a session back together', () => {
    const { dv, fake } = dock()
    const a = session('s_1', 'ra-a')
    addSessionPanels(dv, a, { ...CTX, mode: 'focus' })
    expect(isSessionTabbed(dv, 's_1')).toBe(false)

    collapseSessionPanels(dv, a)
    expect(isSessionTabbed(dv, 's_1')).toBe(true)
    expect(shape(fake)).toEqual([['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1']])
  })

  it('counts only the panels that are open', () => {
    const { dv } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'grid' }, ['term', 'shell'])
    expect(openPanelCount(dv, 's_1')).toBe(2)
    expect(openPanelCount(dv, 's_2')).toBe(0)
  })
})

describe('closeSessionPanels', () => {
  it('takes every window of the session, and its placeholder, with it', () => {
    const { dv, fake } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' })
    addSessionPanels(dv, session('s_2', 'ra-b'), { ...CTX, mode: 'focus' })
    dv.addPanel({ id: 'gone:s_1', component: 'placeholder', title: 'ra-a' })

    expect(closeSessionPanels(dv, 's_1')).toEqual(['term:s_1', 'shell:s_1', 'tree:s_1', 'view:s_1'])
    expect(fake.panels.map((p) => p.id).sort()).toEqual([
      'shell:s_2',
      'term:s_2',
      'tree:s_2',
      'view:s_2'
    ])
  })

  it('can keep the placeholder that explains where the session went', () => {
    const { dv, fake } = dock()
    addSessionPanels(dv, session('s_1', 'ra-a'), { ...CTX, mode: 'focus' })
    dv.addPanel({ id: 'gone:s_1', component: 'placeholder', title: 'ra-a' })

    closeSessionPanels(dv, 's_1', { keepPlaceholder: true })
    expect(fake.panels.map((p) => p.id)).toEqual(['gone:s_1'])
  })
})
