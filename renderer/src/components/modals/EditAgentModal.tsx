import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Edit2, Plus } from 'lucide-react'
import { EmojiPicker } from '../EmojiPicker'
import { McpValidationModal } from './McpValidationModal'
import { McpServerEditModal } from './McpServerEditModal'

type AgentTab = 'basic' | 'prompt' | 'permissions' | 'mcp'

interface EditAgentModalProps {
  agent: OctoFile
  folderPath: string
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

function transportOf(cfg: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if ('type' in cfg && cfg.type) return cfg.type
  return 'stdio'
}

export function EditAgentModal({ agent, folderPath: _folderPath, onClose, onSaved, onDeleted }: EditAgentModalProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<AgentTab>('basic')
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [prompt, setPrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(true)
  const [icon, setIcon] = useState(agent.icon || '')
  const [color, setColor] = useState(agent.color || '')
  const [fileWrite, setFileWrite] = useState(agent.permissions?.fileWrite === true)
  const [bash, setBash] = useState(agent.permissions?.bash === true)
  const [network, setNetwork] = useState(agent.permissions?.network === true)
  const [allowPaths, setAllowPaths] = useState((agent.permissions?.allowPaths || []).join(', '))
  const [denyPaths, setDenyPaths] = useState((agent.permissions?.denyPaths || []).join(', '))

  // MCP state — hydrated from `agent.mcp` (new shape) when present, otherwise
  // from `agent.mcpServers` (legacy blob).
  const [globalServers, setGlobalServers] = useState<McpServersConfig>({})
  const [globalServersLoadFailed, setGlobalServersLoadFailed] = useState(false)
  const [agentServers, setAgentServers] = useState<McpServersConfig>(agent.mcp?.servers ?? {})
  const [disabledServers, setDisabledServers] = useState<string[]>(agent.mcp?.disabledServers ?? [])
  const [disabledTools, setDisabledTools] = useState<Record<string, string[]>>(agent.mcp?.disabledTools ?? {})
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [mcpEditTarget, setMcpEditTarget] = useState<
    | { mode: 'add' }
    | { mode: 'override'; name: string; cfg: McpServerConfig }
    | { mode: 'edit-local'; name: string; cfg: McpServerConfig }
    | null
  >(null)

  const [error, setError] = useState<string | null>(null)
  const [showMcpValidation, setShowMcpValidation] = useState(false)
  const [pendingMcpServers, setPendingMcpServers] = useState<McpServersConfig | null>(null)

  // Load global MCP registry once on mount. On failure we surface a banner
  // (not a toast) — silent-swallow lets the user create a duplicate-name
  // local override under the mistaken assumption that no global exists, and
  // first save would clear the legacy `mcpServers` blob alongside it.
  useEffect(() => {
    let cancelled = false
    window.api.loadSettings().then((s) => {
      if (cancelled) return
      setGlobalServers(s.mcp?.servers ?? {})
    }).catch((err) => {
      console.error('[EditAgentModal] loadSettings failed', err)
      if (!cancelled) setGlobalServersLoadFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // If the agent only has the legacy blob (no `mcp.servers`), seed local
  // overrides from it so editing keeps them visible until first save.
  useEffect(() => {
    if (!agent.mcp && agent.mcpServers && Object.keys(agentServers).length === 0) {
      setAgentServers(agent.mcpServers as McpServersConfig)
    }
    // Eslint disable: we only want to run this once on mount for the legacy
    // hydration branch — `agentServers` deliberately omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const effective = useMemo<Record<string, { cfg: McpServerConfig; source: 'global' | 'local' }>>(() => {
    const out: Record<string, { cfg: McpServerConfig; source: 'global' | 'local' }> = {}
    for (const [n, c] of Object.entries(globalServers)) {
      if (!disabledServers.includes(n)) out[n] = { cfg: c, source: 'global' }
    }
    for (const [n, c] of Object.entries(agentServers)) {
      out[n] = { cfg: c, source: 'local' }
    }
    return out
  }, [globalServers, agentServers, disabledServers])

  // Load prompt.md content on mount
  useEffect(() => {
    window.api.readAgentPrompt(agent.path).then((res) => {
      if (res.ok) setPrompt(res.path)
      setPromptLoading(false)
    }).catch(() => setPromptLoading(false))
  }, [agent.path])

  const save = async () => {
    setError(null)

    const permissions: OctoPermissions = {
      fileWrite,
      bash,
      network,
      allowPaths: allowPaths
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      denyPaths: denyPaths
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }

    const mcp: AgentMcp = {}
    if (Object.keys(agentServers).length) mcp.servers = agentServers
    if (disabledServers.length) mcp.disabledServers = disabledServers
    const cleanedDisabledTools = Object.fromEntries(
      Object.entries(disabledTools).filter(([, tools]) => tools.length > 0),
    )
    if (Object.keys(cleanedDisabledTools).length) mcp.disabledTools = cleanedDisabledTools

    const res = await window.api.updateOcto({
      octoPath: agent.path,
      name,
      role,
      prompt,
      icon,
      color,
      permissions,
      // Clear the legacy blob on first save under the new shape — the resolver
      // only consults it when `mcp` is fully empty, so dropping it is safe.
      mcpServers: null,
      mcp,
    })
    if (res.ok) {
      // Surface validation only for stdio servers (the validator is stdio-only).
      const stdioOnly: McpServersConfig = {}
      for (const [n, c] of Object.entries(agentServers)) {
        if (transportOf(c) === 'stdio') stdioOnly[n] = c
      }
      if (Object.keys(stdioOnly).length > 0) {
        setPendingMcpServers(stdioOnly)
        setShowMcpValidation(true)
      } else {
        onSaved()
      }
    } else {
      setError(res.error)
    }
  }

  const remove = async () => {
    if (!confirm(t('modals.editAgent.deleteConfirm', { name: agent.name }))) return
    const res = await window.api.deleteOcto(agent.path)
    if (res.ok) onDeleted()
    else setError(res.error)
  }

  if (showMcpValidation && pendingMcpServers) {
    return (
      <McpValidationModal
        mcpServers={pendingMcpServers}
        onClose={() => { setShowMcpValidation(false); onSaved() }}
        onDone={() => { setShowMcpValidation(false); onSaved() }}
      />
    )
  }

  const tabs: { id: AgentTab; label: string }[] = [
    { id: 'basic', label: t('modals.editAgent.tabBasic') },
    { id: 'prompt', label: t('modals.editAgent.tabPrompt') },
    { id: 'permissions', label: t('modals.editAgent.tabPermissions') },
    { id: 'mcp', label: t('modals.editAgent.tabMcp') },
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('modals.editAgent.title')}</div>

        <div className="agent-modal-tabs">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              className={`agent-modal-tab ${tab === tb.id ? 'active' : ''}`}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="agent-modal-tab-content">
          {tab === 'basic' && (
            <>
              <EmojiPicker
                value={icon}
                onChange={setIcon}
                name={name || '?'}
                color={color || undefined}
                onColorChange={setColor}
              />

              <label className="modal-label">{t('label.name')}</label>
              <input
                className="modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />

              <label className="modal-label">{t('label.role')}</label>
              <input
                className="modal-input"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder={t('modals.editAgent.rolePlaceholder')}
              />
              <div className="modal-hint">{t('modals.editAgent.roleHint')}</div>
            </>
          )}

          {tab === 'prompt' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>{t('modals.editAgent.promptLabel')}</label>
              <div className="modal-hint" style={{ marginTop: 0 }}>
                {t('modals.editAgent.promptHint')}
              </div>
              {promptLoading ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>
                  {t('common.loading')}
                </div>
              ) : (
                <textarea
                  className="modal-textarea modal-textarea--mono"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('modals.editAgent.promptPlaceholder')}
                  rows={12}
                />
              )}
            </>
          )}

          {tab === 'permissions' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>{t('modals.createAgent.permissions')}</label>
              <div className="modal-hint" style={{ marginTop: 0 }}>
                {t('modals.createAgent.permissionsHint')}
              </div>
              <div className="perm-row">
                <label className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={fileWrite}
                    onChange={(e) => setFileWrite(e.target.checked)}
                  />
                  <span>{t('modals.createAgent.permFileWrite')}</span>
                </label>
                <label className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={bash}
                    onChange={(e) => setBash(e.target.checked)}
                  />
                  <span>{t('modals.createAgent.permShell')}</span>
                </label>
                <label className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={network}
                    onChange={(e) => setNetwork(e.target.checked)}
                  />
                  <span>{t('modals.createAgent.permNetwork')}</span>
                </label>
              </div>

              <label className="modal-label">{t('modals.createAgent.allowPaths')}</label>
              <input
                className="modal-input"
                placeholder={t('modals.createAgent.allowPathsPlaceholder')}
                value={allowPaths}
                onChange={(e) => setAllowPaths(e.target.value)}
              />

              <label className="modal-label">{t('modals.createAgent.denyPaths')}</label>
              <input
                className="modal-input"
                placeholder={t('modals.createAgent.denyPathsPlaceholder')}
                value={denyPaths}
                onChange={(e) => setDenyPaths(e.target.value)}
              />
            </>
          )}

          {tab === 'mcp' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>{t('agentMcp.title')}</label>
              <div className="modal-hint" style={{ marginTop: 0 }}>
                {t('agentMcp.desc')}
              </div>

              {globalServersLoadFailed && (
                <div className="modal-error" role="alert" style={{ marginTop: 8 }}>
                  {t('agentMcp.globalLoadFailed')}
                </div>
              )}

              {Object.keys(effective).length === 0 ? (
                <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6, marginTop: 12 }}>
                  {t('agentMcp.noEffectiveServers')}
                </p>
              ) : null}

              {/* Effective server list — global ∪ local, with toggles. */}
              <div className="agent-mcp-list">
                {Object.entries(effective).map(([sname, { cfg, source }]) => {
                  const enabled = !disabledServers.includes(sname)
                  const expanded = expandedTools.has(sname)
                  const transport = transportOf(cfg)
                  const tools = disabledTools[sname] ?? []
                  return (
                    <div key={sname} className="agent-mcp-row">
                      <div className="agent-mcp-row-header">
                        <label className="perm-toggle">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setDisabledServers((s) => s.filter((n) => n !== sname))
                              } else {
                                setDisabledServers((s) =>
                                  s.includes(sname) ? s : [...s, sname],
                                )
                              }
                            }}
                          />
                          <span>{sname}</span>
                        </label>
                        <span className={`provider-card-status ${source === 'local' ? 'active' : 'inactive'}`}>
                          <span className="provider-card-status-dot" />
                          {source === 'global' ? t('agentMcp.globalBadge') : t('agentMcp.localBadge')}
                        </span>
                        <span className="provider-card-status inactive">
                          {t(`mcp.global.transport.${transport}`)}
                        </span>
                        <button
                          type="button"
                          className="provider-card-icon-btn"
                          onClick={() =>
                            setExpandedTools((s) => {
                              const next = new Set(s)
                              if (next.has(sname)) next.delete(sname)
                              else next.add(sname)
                              return next
                            })
                          }
                          aria-label={t('agentMcp.tools')}
                        >
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {source === 'global' ? (
                          <button
                            type="button"
                            className="provider-card-btn"
                            onClick={() =>
                              setMcpEditTarget({ mode: 'override', name: sname, cfg })
                            }
                          >
                            {t('agentMcp.override')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="provider-card-btn"
                            onClick={() =>
                              setMcpEditTarget({ mode: 'edit-local', name: sname, cfg })
                            }
                            aria-label={t('agentMcp.editLocal')}
                          >
                            <Edit2 size={14} />
                            {t('agentMcp.editLocal')}
                          </button>
                        )}
                      </div>
                      {expanded && (
                        <div className="agent-mcp-tools">
                          {tools.length === 0 ? (
                            <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                              {t('agentMcp.toolsUnavailable')}
                            </p>
                          ) : (
                            tools.map((toolName) => (
                              <label key={toolName} className="perm-toggle">
                                <input
                                  type="checkbox"
                                  checked={false}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setDisabledTools((d) => {
                                        const next = { ...d }
                                        next[sname] = (next[sname] ?? []).filter((tn) => tn !== toolName)
                                        if (next[sname].length === 0) delete next[sname]
                                        return next
                                      })
                                    }
                                  }}
                                />
                                <span>{toolName}</span>
                              </label>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="provider-card-btn primary"
                  onClick={() => setMcpEditTarget({ mode: 'add' })}
                >
                  <Plus size={14} />
                  {t('agentMcp.addLocal')}
                </button>
              </div>

              {mcpEditTarget && (
                <McpServerEditModal
                  initialName={mcpEditTarget.mode === 'add' ? undefined : mcpEditTarget.name}
                  initialConfig={mcpEditTarget.mode === 'add' ? null : mcpEditTarget.cfg}
                  reservedNames={
                    mcpEditTarget.mode === 'edit-local'
                      ? Object.keys(agentServers).filter((n) => n !== mcpEditTarget.name)
                      : Object.keys(agentServers)
                  }
                  onClose={() => setMcpEditTarget(null)}
                  onSave={(n, cfg) => {
                    setAgentServers((s) => {
                      const next: McpServersConfig = { ...s }
                      if (
                        mcpEditTarget.mode === 'edit-local' &&
                        mcpEditTarget.name !== n
                      ) {
                        delete next[mcpEditTarget.name]
                      }
                      next[n] = cfg
                      return next
                    })
                    setMcpEditTarget(null)
                  }}
                />
              )}
            </>
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-danger" onClick={remove}>
            {t('common.delete')}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
