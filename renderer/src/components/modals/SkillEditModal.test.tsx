import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SkillEditModal } from './SkillEditModal'
import '../../i18n'

beforeEach(() => {
  ;(window as unknown as { api: any }).api = {
    createSkill: vi.fn(async () => ({ ok: true, path: '/x' })),
    updateSkill: vi.fn(async () => ({ ok: true, path: '/x' })),
    deleteSkill: vi.fn(async () => ({ ok: true })),
  }
})

afterEach(() => {
  cleanup()
})

const editSkill: SkillForSettings = {
  name: 'demo',
  description: 'A demo',
  source: 'workspace',
  path: '/tmp/.claude/skills/demo/SKILL.md',
  enabled: true,
  raw: '---\nname: demo\ndescription: |\n  A demo\nuser-invocable: true\n---\n# Body\n\nDetail',
}

describe('SkillEditModal — create flow', () => {
  it('rejects empty name', async () => {
    render(
      <SkillEditModal
        skill={null}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText(/^save$/i))
    expect(window.api.createSkill).not.toHaveBeenCalled()
    expect(screen.getByText(/name is required/i)).toBeInTheDocument()
  })

  it('rejects names with disallowed characters', async () => {
    render(
      <SkillEditModal
        skill={null}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const inputs = document.querySelectorAll('input.modal-input')
    fireEvent.change(inputs[0], { target: { value: 'has:colon' } })
    const desc = document.querySelector('textarea.modal-textarea') as HTMLTextAreaElement
    fireEvent.change(desc, { target: { value: 'desc' } })
    fireEvent.click(screen.getByText(/^save$/i))
    expect(window.api.createSkill).not.toHaveBeenCalled()
  })

  it('rejects empty description', async () => {
    render(
      <SkillEditModal
        skill={null}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const inputs = document.querySelectorAll('input.modal-input')
    fireEvent.change(inputs[0], { target: { value: 'demo' } })
    fireEvent.click(screen.getByText(/^save$/i))
    expect(window.api.createSkill).not.toHaveBeenCalled()
    expect(screen.getByText(/description is required/i)).toBeInTheDocument()
  })

  it('disables workspace scope when no activeFolder', () => {
    render(
      <SkillEditModal
        skill={null}
        activeFolder={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const radios = screen.getAllByRole('radio')
    const workspaceRadio = radios.find((r) =>
      /workspace/i.test(r.textContent ?? ''),
    )
    expect(workspaceRadio).toBeDisabled()
  })

  it('passes scope, name, description, body, enabled to createSkill', async () => {
    const onSaved = vi.fn()
    render(
      <SkillEditModal
        skill={null}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={onSaved}
        onDeleted={vi.fn()}
      />,
    )
    const nameInput = document.querySelector('input.modal-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'demo' } })
    const desc = document.querySelector('textarea.modal-textarea') as HTMLTextAreaElement
    fireEvent.change(desc, { target: { value: 'A demo' } })
    fireEvent.click(screen.getByText(/^save$/i))
    await waitFor(() => expect(window.api.createSkill).toHaveBeenCalledOnce())
    expect(window.api.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'workspace',
        folderPath: '/tmp',
        name: 'demo',
        description: 'A demo',
        enabled: true,
      }),
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('surfaces backend error in the error banner', async () => {
    ;(window.api as any).createSkill = vi.fn(async () => ({
      ok: false,
      error: 'A skill named "demo" already exists',
    }))
    render(
      <SkillEditModal
        skill={null}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const nameInput = document.querySelector('input.modal-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'demo' } })
    const desc = document.querySelector('textarea.modal-textarea') as HTMLTextAreaElement
    fireEvent.change(desc, { target: { value: 'desc' } })
    fireEvent.click(screen.getByText(/^save$/i))
    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeInTheDocument()
    })
  })

  it('surfaces apiUnavailable when bridge returns undefined', async () => {
    ;(window.api as any).createSkill = vi.fn(async () => undefined)
    render(
      <SkillEditModal
        skill={null}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const nameInput = document.querySelector('input.modal-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'demo' } })
    const desc = document.querySelector('textarea.modal-textarea') as HTMLTextAreaElement
    fireEvent.change(desc, { target: { value: 'desc' } })
    fireEvent.click(screen.getByText(/^save$/i))
    await waitFor(() => {
      expect(screen.getByText(/not available in this build/i)).toBeInTheDocument()
    })
  })
})

describe('SkillEditModal — edit flow', () => {
  it('strips frontmatter from raw to populate the body tab', async () => {
    render(
      <SkillEditModal
        skill={editSkill}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText(/^body$/i))
    const textarea = document.querySelector('textarea.modal-textarea--mono') as HTMLTextAreaElement
    expect(textarea.value).toContain('# Body')
    expect(textarea.value).toContain('Detail')
    expect(textarea.value).not.toContain('user-invocable')
  })

  it('calls updateSkill with new name and enabled flag', async () => {
    render(
      <SkillEditModal
        skill={editSkill}
        activeFolder="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const nameInput = document.querySelector('input.modal-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'renamed' } })
    fireEvent.click(screen.getByText(/^save$/i))
    await waitFor(() => expect(window.api.updateSkill).toHaveBeenCalledOnce())
    expect(window.api.updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        path: editSkill.path,
        name: 'renamed',
        enabled: true,
      }),
    )
  })

  it('auto-closes if a per-agent skill slips through', async () => {
    const onClose = vi.fn()
    render(
      <SkillEditModal
        skill={{ ...editSkill, source: 'agent:dev' }}
        activeFolder="/tmp"
        onClose={onClose}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
