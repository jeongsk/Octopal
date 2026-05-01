import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { SkillsTab } from './SkillsTab'
import '../../i18n'

let listSkillsForSettingsImpl: () => Promise<SkillForSettings[]> = async () => []

beforeEach(() => {
  listSkillsForSettingsImpl = async () => []
  ;(window as unknown as { api: any }).api = {
    listSkillsForSettings: vi.fn(() => listSkillsForSettingsImpl()),
    updateSkill: vi.fn(async () => ({ ok: true, path: '/x' })),
    deleteSkill: vi.fn(async () => ({ ok: true })),
  }
})

afterEach(() => {
  cleanup()
})

const sampleSkill = (overrides: Partial<SkillForSettings> = {}): SkillForSettings => ({
  name: 'demo',
  description: 'A demo skill',
  source: 'workspace',
  path: '/tmp/.claude/skills/demo/SKILL.md',
  enabled: true,
  raw: '---\nname: demo\ndescription: |\n  A demo skill\nuser-invocable: true\n---\n# Body',
  ...overrides,
})

describe('SkillsTab', () => {
  it('renders empty state when no skills are loaded', async () => {
    listSkillsForSettingsImpl = async () => []
    render(<SkillsTab activeFolder="/tmp" />)
    await waitFor(() => {
      expect(screen.getByText(/no skills yet/i)).toBeInTheDocument()
    })
  })

  it('renders a skill row with name and scope label', async () => {
    listSkillsForSettingsImpl = async () => [sampleSkill()]
    render(<SkillsTab activeFolder="/tmp" />)
    await waitFor(() => {
      expect(screen.getByText('/demo')).toBeInTheDocument()
    })
    expect(screen.getByText(/Workspace/)).toBeInTheDocument()
  })

  it('opens the edit modal when the edit button is clicked', async () => {
    listSkillsForSettingsImpl = async () => [sampleSkill()]
    render(<SkillsTab activeFolder="/tmp" />)
    await waitFor(() => {
      expect(screen.getByText('/demo')).toBeInTheDocument()
    })
    // The "Pencil" edit button — find by the row's edit title attribute.
    const editBtn = screen.getByTitle(/^edit$/i)
    fireEvent.click(editBtn)
    expect(screen.getByText(/edit skill/i)).toBeInTheDocument()
  })

  it('disables actions for agent-scoped skills', async () => {
    listSkillsForSettingsImpl = async () => [
      sampleSkill({ source: 'agent:dev', name: 'agent-skill' }),
    ]
    render(<SkillsTab activeFolder="/tmp" />)
    await waitFor(() => {
      expect(screen.getByText('/agent-skill')).toBeInTheDocument()
    })
    // Edit / delete buttons exist but are disabled.
    const buttons = screen.getAllByRole('button')
    const disabledActionBtns = buttons.filter((b) => b.hasAttribute('disabled'))
    // At least the edit + delete buttons (2) should be disabled.
    expect(disabledActionBtns.length).toBeGreaterThanOrEqual(2)
  })
})
