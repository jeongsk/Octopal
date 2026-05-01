import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { McpServerEditModal } from './McpServerEditModal'
import '../../i18n'

beforeEach(() => {
  cleanup()
})

describe('McpServerEditModal — name validation', () => {
  it('rejects names that fail NAME_PATTERN', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    const nameInput = screen.getByPlaceholderText(/figma/i)
    fireEvent.change(nameInput, { target: { value: 'Has Capital' } })
    fireEvent.change(screen.getByPlaceholderText(/npx/i), { target: { value: 'npx' } })
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/lowercase letters, numbers, hyphens/i)).toBeInTheDocument()
  })

  it('rejects empty name', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/npx/i), { target: { value: 'npx' } })
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/name is required/i)).toBeInTheDocument()
  })

  it('rejects duplicate name when creating', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={['figma']}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/figma/i), { target: { value: 'figma' } })
    fireEvent.change(screen.getByPlaceholderText(/npx/i), { target: { value: 'npx' } })
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('disables the name input when editing', () => {
    render(
      <McpServerEditModal
        initialName="figma"
        initialConfig={{ command: 'npx', args: ['-y', 'figma-mcp'] }}
        reservedNames={['stripe']}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    const nameInput = screen.getByDisplayValue('figma') as HTMLInputElement
    expect(nameInput).toBeDisabled()
  })

  it('allows reusing the same name when editing', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        initialName="figma"
        initialConfig={{ command: 'npx' }}
        reservedNames={['stripe']}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledWith('figma', expect.objectContaining({ command: 'npx' }))
  })
})

describe('McpServerEditModal — stdio save', () => {
  it('saves stdio with args and env, splitting args on newlines', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/figma/i), { target: { value: 'figma' } })
    fireEvent.change(screen.getByPlaceholderText(/npx/i), { target: { value: 'npx' } })
    const argsTextarea = document.querySelector('textarea')!
    fireEvent.change(argsTextarea, { target: { value: '-y\nfigma-mcp' } })
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).toHaveBeenCalledOnce()
    const [savedName, savedCfg] = onSave.mock.calls[0]
    expect(savedName).toBe('figma')
    expect(savedCfg.command).toBe('npx')
    expect(savedCfg.args).toEqual(['-y', 'figma-mcp'])
  })

  it('rejects empty command on stdio', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/figma/i), { target: { value: 'figma' } })
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/command is required/i)).toBeInTheDocument()
  })
})

describe('McpServerEditModal — http save', () => {
  it('saves http with url and headers when transport switched', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/figma/i), { target: { value: 'stripe' } })
    // Switch transport to HTTP
    fireEvent.click(screen.getByRole('radio', { name: /http/i }))
    fireEvent.change(screen.getByPlaceholderText(/mcp\.example\.com/i), {
      target: { value: 'https://mcp.stripe.com' },
    })
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).toHaveBeenCalledOnce()
    const [savedName, savedCfg] = onSave.mock.calls[0]
    expect(savedName).toBe('stripe')
    expect(savedCfg).toMatchObject({ type: 'http', url: 'https://mcp.stripe.com' })
  })

  it('rejects empty URL on http', () => {
    const onSave = vi.fn()
    render(
      <McpServerEditModal
        reservedNames={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/figma/i), { target: { value: 'stripe' } })
    fireEvent.click(screen.getByRole('radio', { name: /http/i }))
    fireEvent.click(screen.getByText(/save/i))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/url is required/i)).toBeInTheDocument()
  })
})
