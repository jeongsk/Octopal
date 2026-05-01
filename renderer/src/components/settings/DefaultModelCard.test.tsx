import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { DefaultModelCard } from './DefaultModelCard'
import '../../i18n'

const baseProviders: NonNullable<AppSettings['providers']> = {
  useLegacyClaudeCli: true,
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  configuredProviders: {},
}

const baseAdvanced: AppSettings['advanced'] = {
  defaultAgentModel: 'opus',
  autoModelSelection: false,
}

const manifest: ProvidersManifest = {
  anthropic: {
    displayName: 'Anthropic',
    models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
    authMethods: [
      { id: 'api_key', label: 'API Key', goose_provider: 'anthropic' },
    ],
  },
  openai: {
    displayName: 'OpenAI',
    models: ['gpt-4o'],
    authMethods: [{ id: 'api_key', label: 'API Key', goose_provider: 'openai' }],
  },
}

const availableModelsFor = (providerId: string): string[] => {
  const entry = manifest[providerId]
  if (!entry) return []
  const baseList = Array.isArray(entry.models) ? entry.models : []
  if (providerId === 'anthropic') return ['opus', 'sonnet', 'haiku', ...baseList]
  return baseList
}

beforeAll(() => {
  // Silence i18next "missing key" warnings — keys exist in en.json,
  // but tests don't always wait for async init.
})

describe('DefaultModelCard — runtime-routing invariant', () => {
  it('Claude CLI mode writes ONLY to advanced.* (never providers.*)', () => {
    const onProvidersChange = vi.fn()
    const onAdvancedChange = vi.fn()

    render(
      <DefaultModelCard
        useLegacyClaudeCli={true}
        providers={baseProviders}
        advanced={baseAdvanced}
        bestOpusModel={null}
        manifest={manifest}
        availableModelsFor={availableModelsFor}
        onProvidersChange={onProvidersChange}
        onAdvancedChange={onAdvancedChange}
      />,
    )

    // Toggle the adaptive checkbox.
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(checkbox)

    expect(onAdvancedChange).toHaveBeenCalledWith({ autoModelSelection: true })
    expect(onProvidersChange).not.toHaveBeenCalled()

    // Change the model tier select (visible while adaptive=false).
    const select = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'haiku' } })

    expect(onAdvancedChange).toHaveBeenCalledWith({ defaultAgentModel: 'haiku' })
    expect(onProvidersChange).not.toHaveBeenCalled()
  })

  it('Goose mode writes ONLY to providers.* (never advanced.*)', () => {
    const onProvidersChange = vi.fn()
    const onAdvancedChange = vi.fn()

    render(
      <DefaultModelCard
        useLegacyClaudeCli={false}
        providers={baseProviders}
        advanced={baseAdvanced}
        bestOpusModel={null}
        manifest={manifest}
        availableModelsFor={availableModelsFor}
        onProvidersChange={onProvidersChange}
        onAdvancedChange={onAdvancedChange}
      />,
    )

    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(selects).toHaveLength(2)

    // Provider select.
    fireEvent.change(selects[0], { target: { value: 'openai' } })
    expect(onProvidersChange).toHaveBeenCalledWith({ defaultProvider: 'openai' })
    expect(onAdvancedChange).not.toHaveBeenCalled()

    // Model select.
    fireEvent.change(selects[1], { target: { value: 'claude-opus-4-7' } })
    expect(onProvidersChange).toHaveBeenCalledWith({ defaultModel: 'claude-opus-4-7' })
    expect(onAdvancedChange).not.toHaveBeenCalled()
  })

  it('toggling runtime preserves both bags (no cross-writes during render)', () => {
    const onProvidersChange = vi.fn()
    const onAdvancedChange = vi.fn()

    const { rerender } = render(
      <DefaultModelCard
        useLegacyClaudeCli={true}
        providers={baseProviders}
        advanced={baseAdvanced}
        bestOpusModel={null}
        manifest={manifest}
        availableModelsFor={availableModelsFor}
        onProvidersChange={onProvidersChange}
        onAdvancedChange={onAdvancedChange}
      />,
    )

    // Render alone must not invoke either callback — the card observes,
    // does not mutate.
    expect(onAdvancedChange).not.toHaveBeenCalled()
    expect(onProvidersChange).not.toHaveBeenCalled()

    rerender(
      <DefaultModelCard
        useLegacyClaudeCli={false}
        providers={baseProviders}
        advanced={baseAdvanced}
        bestOpusModel={null}
        manifest={manifest}
        availableModelsFor={availableModelsFor}
        onProvidersChange={onProvidersChange}
        onAdvancedChange={onAdvancedChange}
      />,
    )

    // Toggling the runtime prop in isolation must not write to either
    // backend bag — only explicit user interaction should.
    expect(onAdvancedChange).not.toHaveBeenCalled()
    expect(onProvidersChange).not.toHaveBeenCalled()

    cleanup()
  })
})
