import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/domain'
import { parseGridLayout, planGridReconcile } from './project-grid-layout'

function session(id: string, projectId: string): SessionMeta {
  return {
    id,
    projectId,
    tmuxName: `ra-${id}`,
    agent: 'claude',
    mode: 'dir',
    cwd: `/home/u/${id}`,
    createdAt: 0
  }
}

describe('parseGridLayout', () => {
  it('round-trips a saved layout', () => {
    const saved = { version: 1, mode: 'rows', dockview: { grid: {} } }
    expect(parseGridLayout(JSON.stringify(saved))).toEqual(saved)
  })

  it('treats missing, corrupt, or foreign values as no layout', () => {
    expect(parseGridLayout(null)).toBeNull()
    expect(parseGridLayout('{not json')).toBeNull()
    expect(parseGridLayout('42')).toBeNull()
    expect(parseGridLayout(JSON.stringify({ version: 2, mode: 'grid', dockview: {} }))).toBeNull()
    expect(parseGridLayout(JSON.stringify({ version: 1, mode: 'focus', dockview: {} }))).toBeNull()
    expect(parseGridLayout(JSON.stringify({ version: 1, mode: 'grid', dockview: null }))).toBeNull()
  })
})

describe('planGridReconcile', () => {
  const panels = [
    { sessionId: 's_1', projectId: 'p_a' },
    { sessionId: 's_2', projectId: 'p_a' },
    { sessionId: 's_3', projectId: 'p_b' }
  ]

  it('changes nothing when the tiles match the sessions', () => {
    const sessions = [session('s_1', 'p_a'), session('s_2', 'p_a'), session('s_3', 'p_b')]
    expect(planGridReconcile(panels, sessions, new Set())).toEqual({ remove: [], add: [] })
  })

  it('drops tiles of killed sessions and deleted projects', () => {
    // s_2 was killed; project p_b (s_3) was removed
    const sessions = [session('s_1', 'p_a')]
    expect(planGridReconcile(panels, sessions, new Set()).remove).toEqual(['s_2', 's_3'])
  })

  it('keeps the tiles of a project that failed to load', () => {
    const sessions = [session('s_1', 'p_a'), session('s_2', 'p_a')]
    expect(planGridReconcile(panels, sessions, new Set(['p_b'])).remove).toEqual([])
  })

  it('appends new sessions in display order', () => {
    const sessions = [
      session('s_1', 'p_a'),
      session('s_4', 'p_a'),
      session('s_2', 'p_a'),
      session('s_3', 'p_b'),
      session('s_5', 'p_c')
    ]
    expect(planGridReconcile(panels, sessions, new Set()).add.map((s) => s.id)).toEqual([
      's_4',
      's_5'
    ])
  })
})
