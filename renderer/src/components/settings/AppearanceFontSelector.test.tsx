import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import {
  AppearanceFontSelector,
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  applyFontVars,
  optionsFor,
  stackFor,
} from './AppearanceFontSelector'
import '../../i18n'

describe('AppearanceFontSelector', () => {
  it('renders the curated options for the given kind', () => {
    render(<AppearanceFontSelector kind="code" value="system" onChange={() => {}} />)
    expect(screen.getByRole('option', { name: /menlo/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /jetbrains mono/i })).toBeInTheDocument()
    cleanup()
  })

  it('does not include UI-only fonts in the code dropdown', () => {
    render(<AppearanceFontSelector kind="code" value="system" onChange={() => {}} />)
    // Outfit/Georgia are UI-only; a regression that returned UI_FONT_OPTIONS
    // for code would silently leak proportional fonts into the code picker.
    expect(screen.queryByRole('option', { name: /outfit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /georgia/i })).not.toBeInTheDocument()
    cleanup()
  })

  it('does not include monospace-only fonts in the UI dropdown', () => {
    render(<AppearanceFontSelector kind="ui" value="system" onChange={() => {}} />)
    expect(screen.queryByRole('option', { name: /jetbrains mono/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /fira code/i })).not.toBeInTheDocument()
    cleanup()
  })

  it('calls onChange with the picked value', () => {
    const onChange = vi.fn()
    render(<AppearanceFontSelector kind="chat" value="system" onChange={onChange} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'georgia' } })
    expect(onChange).toHaveBeenCalledWith('georgia')
    cleanup()
  })

  it('applies inline style for non-system values, none for system', () => {
    const { container, rerender } = render(
      <AppearanceFontSelector kind="ui" value="system" onChange={() => {}} />
    )
    const previewSystem = container.querySelector('.font-preview') as HTMLElement
    expect(previewSystem.style.fontFamily).toBe('')

    rerender(<AppearanceFontSelector kind="ui" value="georgia" onChange={() => {}} />)
    const previewGeorgia = container.querySelector('.font-preview') as HTMLElement
    expect(previewGeorgia.style.fontFamily).toContain('Georgia')
    cleanup()
  })

  it('stackFor returns empty string for system, full stack otherwise', () => {
    expect(stackFor('code', 'system')).toBe('')
    expect(stackFor('code', 'menlo')).toContain('Menlo')
    expect(stackFor('ui', 'unknown')).toBe('')
  })
})

describe('optionsFor — kind boundaries', () => {
  it('returns the monospace-only list for code', () => {
    const opts = optionsFor('code')
    expect(opts).toBe(CODE_FONT_OPTIONS)
    // Every non-system stack must declare monospace as the final family.
    for (const o of opts) {
      if (o.value === 'system') continue
      expect(o.stack).toMatch(/monospace/)
    }
  })

  it('returns the proportional list for ui and chat', () => {
    expect(optionsFor('ui')).toBe(UI_FONT_OPTIONS)
    expect(optionsFor('chat')).toBe(UI_FONT_OPTIONS)
  })

  it('UI/chat stacks end with Tossface so emoji rendering matches the :root default', () => {
    for (const o of UI_FONT_OPTIONS) {
      if (o.value === 'system') continue
      expect(o.stack).toMatch(/"Tossface"$/)
    }
  })
})

describe('applyFontVars — CSSOM contract', () => {
  it('writes all three CSS variables from the matching appearance fields', () => {
    const root = document.createElement('div')
    // Pre-populate with sentinel values so we can verify they get overwritten.
    root.style.setProperty('--font-ui', 'sentinel')
    root.style.setProperty('--font-chat', 'sentinel')
    root.style.setProperty('--font-mono', 'sentinel')

    applyFontVars(root, { uiFont: 'georgia', chatFont: 'pretendard', codeFont: 'menlo' })

    expect(root.style.getPropertyValue('--font-ui')).toContain('Georgia')
    expect(root.style.getPropertyValue('--font-chat')).toContain('Pretendard')
    expect(root.style.getPropertyValue('--font-mono')).toContain('Menlo')
  })

  it('removes a previously-set CSS variable when value is "system"', () => {
    // Per CSSOM § 6.7.2, setProperty(name, '') === removeProperty(name).
    const root = document.createElement('div')
    root.style.setProperty('--font-ui', 'Georgia, serif')
    expect(root.style.getPropertyValue('--font-ui')).toBe('Georgia, serif')

    applyFontVars(root, { uiFont: 'system', chatFont: 'system', codeFont: 'system' })

    expect(root.style.getPropertyValue('--font-ui')).toBe('')
    expect(root.style.getPropertyValue('--font-chat')).toBe('')
    expect(root.style.getPropertyValue('--font-mono')).toBe('')
  })

  it('does not cross-wire fields (uiFont applies to --font-ui, not --font-chat)', () => {
    // Guards against copy-paste typos like setProperty('--font-ui', stackFor('ui', chatFont)).
    const root = document.createElement('div')
    applyFontVars(root, { uiFont: 'georgia', chatFont: 'system', codeFont: 'system' })

    expect(root.style.getPropertyValue('--font-ui')).toContain('Georgia')
    expect(root.style.getPropertyValue('--font-chat')).toBe('')
    expect(root.style.getPropertyValue('--font-mono')).toBe('')
  })

  it('falls back to "system" defaults when appearance is undefined', () => {
    const root = document.createElement('div')
    root.style.setProperty('--font-ui', 'sentinel')
    applyFontVars(root, undefined)
    expect(root.style.getPropertyValue('--font-ui')).toBe('')
  })
})
