import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react'
import { EditAgentModal } from './EditAgentModal'
import '../../i18n'

type UpdateOctoArg = Parameters<NonNullable<typeof window.api>['updateOcto']>[0]

let lastUpdateOctoArg: UpdateOctoArg | null = null
let loadSettingsImpl: () => Promise<AppSettings> = async () => ({
  general: { restoreLastWorkspace: false, launchAtLogin: false, language: 'en' },
  agents: { defaultPermissions: { fileWrite: false, bash: false, network: false } },
  appearance: { chatFontSize: 14, theme: 'dark', uiFont: 'system', chatFont: 'system', codeFont: 'system' },
  shortcuts: { textExpansions: [] },
  advanced: { defaultAgentModel: 'sonnet', autoModelSelection: false },
  mcp: { servers: {} },
})

beforeEach(() => {
  lastUpdateOctoArg = null
  ;(window as unknown as { api: any }).api = {
    loadSettings: () => loadSettingsImpl(),
    updateOcto: vi.fn(async (arg: UpdateOctoArg) => {
      lastUpdateOctoArg = arg
      return { ok: true, path: arg.octoPath }
    }),
    deleteOcto: vi.fn(async () => ({ ok: true })),
    readAgentPrompt: vi.fn(async () => ({ ok: true, path: '' })),
  }
})

afterEach(() => {
  cleanup()
})

const baseAgent = (overrides: Partial<OctoFile> = {}): OctoFile => ({
  path: '/tmp/agent/config.json',
  name: 'researcher',
  role: 'research things',
  icon: '🔎',
  ...overrides,
})

describe('EditAgentModal — MCP overlay save', () => {
  it('legacy-only agent: save writes mcpServers: null and the new mcp block', async () => {
    loadSettingsImpl = async () => ({
      general: { restoreLastWorkspace: false, launchAtLogin: false, language: 'en' },
      agents: { defaultPermissions: { fileWrite: false, bash: false, network: false } },
      appearance: { chatFontSize: 14, theme: 'dark', uiFont: 'system', chatFont: 'system', codeFont: 'system' },
      shortcuts: { textExpansions: [] },
      advanced: { defaultAgentModel: 'sonnet', autoModelSelection: false },
      mcp: { servers: {} },
    })

    const agent = baseAgent({
      mcpServers: { 'old-server': { command: 'old-bin' } },
      mcp: null,
    })

    render(
      <EditAgentModal
        agent={agent}
        folderPath="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )

    await waitFor(() => expect((window as any).api.updateOcto).toBeDefined())

    fireEvent.click(screen.getByText(/^save$/i))

    await waitFor(() => expect(lastUpdateOctoArg).not.toBeNull())
    expect(lastUpdateOctoArg!.mcpServers).toBeNull()
    // The legacy seed should have been hydrated into agentServers, then
    // serialized into the mcp.servers payload on save.
    expect(lastUpdateOctoArg!.mcp?.servers).toMatchObject({
      'old-server': { command: 'old-bin' },
    })
  })

  it('http server in agent.mcp does not trigger validation modal on save', async () => {
    loadSettingsImpl = async () => ({
      general: { restoreLastWorkspace: false, launchAtLogin: false, language: 'en' },
      agents: { defaultPermissions: { fileWrite: false, bash: false, network: false } },
      appearance: { chatFontSize: 14, theme: 'dark', uiFont: 'system', chatFont: 'system', codeFont: 'system' },
      shortcuts: { textExpansions: [] },
      advanced: { defaultAgentModel: 'sonnet', autoModelSelection: false },
      mcp: { servers: {} },
    })

    const onSaved = vi.fn()
    const agent = baseAgent({
      mcp: {
        servers: {
          stripe: { type: 'http', url: 'https://mcp.stripe.com' },
        },
      },
    })

    render(
      <EditAgentModal
        agent={agent}
        folderPath="/tmp"
        onClose={vi.fn()}
        onSaved={onSaved}
        onDeleted={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText(/^save$/i))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    // No "MCP Server Validation" title visible
    expect(screen.queryByText(/MCP Server Validation/i)).not.toBeInTheDocument()
  })

  it('global server appears in MCP tab when not disabled', async () => {
    loadSettingsImpl = async () => ({
      general: { restoreLastWorkspace: false, launchAtLogin: false, language: 'en' },
      agents: { defaultPermissions: { fileWrite: false, bash: false, network: false } },
      appearance: { chatFontSize: 14, theme: 'dark', uiFont: 'system', chatFont: 'system', codeFont: 'system' },
      shortcuts: { textExpansions: [] },
      advanced: { defaultAgentModel: 'sonnet', autoModelSelection: false },
      mcp: {
        servers: {
          figma: { command: 'npx', args: ['-y', 'figma-mcp'] },
        },
      },
    })

    const agent = baseAgent({
      mcp: { servers: {} },
    })

    render(
      <EditAgentModal
        agent={agent}
        folderPath="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )

    // Switch to MCP tab. Use the tab button text (translated)
    const mcpTab = screen.getAllByText(/MCP/i).find((el) => el.tagName === 'BUTTON')
    expect(mcpTab).toBeDefined()
    fireEvent.click(mcpTab!)

    await waitFor(() => {
      expect(screen.getByText('figma')).toBeInTheDocument()
    })
  })

  it('shows banner when loadSettings fails (no silent swallow)', async () => {
    loadSettingsImpl = async () => {
      throw new Error('IPC failure')
    }

    const agent = baseAgent()

    render(
      <EditAgentModal
        agent={agent}
        folderPath="/tmp"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )

    // Switch to MCP tab
    const mcpTab = screen.getAllByText(/MCP/i).find((el) => el.tagName === 'BUTTON')
    fireEvent.click(mcpTab!)

    await waitFor(() => {
      expect(
        screen.getByText(/Could not load global MCP servers/i),
      ).toBeInTheDocument()
    })
  })
})
