import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Users,
  Palette,
  Keyboard,
  Info,
  ExternalLink,
  RotateCw,
  Globe,
  Plus,
  Trash2,
  Zap,
  Wrench,
  Download,
  Check,
  KeyRound,
  Plug,
} from 'lucide-react'
import { ModelsTab } from './settings/ModelsTab'
import { McpTab } from './settings/McpTab'
import { AppearanceFontSelector, applyFontVars } from './settings/AppearanceFontSelector'
import { showToast } from './Toast'

type SettingsTab = 'general' | 'agents' | 'models' | 'mcp' | 'appearance' | 'shortcuts' | 'advanced' | 'about'

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
]

interface SettingsPanelProps {
  onSettingsSaved?: (settings: AppSettings) => void
}

export function SettingsPanel({ onSettingsSaved }: SettingsPanelProps = {}) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newTrigger, setNewTrigger] = useState('')
  const [newExpansion, setNewExpansion] = useState('')
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<{
    version: string
    electron: string
    node: string
  } | null>(null)
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  >('idle')
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  // Newest explicit Opus model name (e.g. `claude-opus-4-7`) detected on this
  // machine, or `null` while the probe is still running / no premium model.
  const [bestOpusModel, setBestOpusModel] = useState<string | null>(null)
  // Captured at load — lets the save bar surface a "runtime change applies
  // next session" hint only when the user has actually toggled the runtime.
  const [initialUseLegacyClaudeCli, setInitialUseLegacyClaudeCli] = useState<boolean | null>(null)

  const TABS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
    { id: 'general', label: t('settings.tabs.general'), icon: Settings },
    { id: 'agents', label: t('settings.tabs.agents'), icon: Users },
    { id: 'models', label: t('settings.tabs.models'), icon: KeyRound },
    { id: 'mcp', label: t('settings.tabs.mcp'), icon: Plug },
    { id: 'appearance', label: t('settings.tabs.appearance'), icon: Palette },
    { id: 'shortcuts', label: t('settings.tabs.shortcuts'), icon: Keyboard },
    { id: 'advanced', label: t('settings.tabs.advanced'), icon: Wrench },
    { id: 'about', label: t('settings.tabs.about'), icon: Info },
  ]

  const SHORTCUTS = [
    { label: t('settings.shortcuts.sendMessage'), keys: ['Enter'] },
    { label: t('settings.shortcuts.newLine'), keys: ['Shift', 'Enter'] },
    { label: t('settings.shortcuts.mentionAgent'), keys: ['@'] },
    { label: t('settings.shortcuts.stopAllAgents'), keys: ['Esc'] },
  ]

  useEffect(() => {
    window.api.loadSettings().then((s) => {
      setSettings(s)
      setInitialUseLegacyClaudeCli(s.providers?.useLegacyClaudeCli !== false)
    })
    window.api.getVersion().then(setVersionInfo)
    // Query the best available Opus variant. The backend probes on startup,
    // but the result may not be ready yet — poll briefly to pick it up once
    // the probe finishes. Gracefully skipped under Electron where this API
    // isn't implemented.
    const probeFn = window.api.getBestOpusModel
    if (probeFn) {
      let cancelled = false
      let attempts = 0
      const tick = () => {
        if (cancelled) return
        probeFn()
          .then((m) => {
            if (cancelled) return
            if (m) {
              setBestOpusModel(m)
            } else if (attempts < 30) {
              // probe hasn't finished yet — retry up to ~30s
              attempts += 1
              setTimeout(tick, 1000)
            }
          })
          .catch(() => {
            // non-Tauri or command missing — ignore silently
          })
      }
      tick()
      return () => {
        cancelled = true
      }
    }
  }, [])

  const update = <K extends keyof AppSettings>(
    section: K,
    patch: Partial<AppSettings[K]>
  ) => {
    if (!settings) return
    const updated = {
      ...settings,
      [section]: { ...settings[section], ...patch },
    }
    setSettings(updated)
    setDirty(true)
  }

  const updateNested = (
    section: 'agents',
    key: 'defaultPermissions',
    patch: Partial<AppSettings['agents']['defaultPermissions']>
  ) => {
    if (!settings) return
    const updated = {
      ...settings,
      agents: {
        ...settings.agents,
        defaultPermissions: { ...settings.agents.defaultPermissions, ...patch },
      },
    }
    setSettings(updated)
    setDirty(true)
  }

  const changeLanguage = async (lang: string) => {
    if (!settings) return
    i18n.changeLanguage(lang)
    const updated = {
      ...settings,
      general: { ...settings.general, language: lang },
    }
    setSettings(updated)
    await window.api.saveSettings(updated)
  }

  const addTextShortcut = () => {
    if (!settings) return
    const trigger = newTrigger.trim()
    const expansion = newExpansion.trim()

    // Validate
    if (!trigger) { setShortcutError(t('settings.shortcuts.triggerEmpty')); return }
    if (!trigger.startsWith('/')) { setShortcutError(t('settings.shortcuts.triggerPrefix')); return }
    if (trigger.length < 2) { setShortcutError(t('settings.shortcuts.triggerMinLength')); return }
    if (/\s/.test(trigger)) { setShortcutError(t('settings.shortcuts.triggerNoSpaces')); return }
    if (!expansion) { setShortcutError(t('settings.shortcuts.expansionEmpty')); return }

    const existing = settings.shortcuts?.textExpansions || []
    if (existing.some((s) => s.trigger.toLowerCase() === trigger.toLowerCase())) {
      setShortcutError(t('settings.shortcuts.triggerDuplicate'))
      return
    }

    const updated = {
      ...settings,
      shortcuts: {
        ...settings.shortcuts,
        textExpansions: [...existing, { trigger, expansion }],
      },
    }
    setSettings(updated)
    setDirty(true)
    setNewTrigger('')
    setNewExpansion('')
    setShortcutError(null)
  }

  const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking')
      setUpdateError(null)
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        setUpdateStatus('downloading')
        let totalBytes = 0
        let downloadedBytes = 0
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started' && event.data.contentLength) {
            totalBytes = event.data.contentLength
          } else if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength
            if (totalBytes > 0) {
              setDownloadProgress(Math.round((downloadedBytes / totalBytes) * 100))
            }
          } else if (event.event === 'Finished') {
            setUpdateStatus('ready')
          }
        })
        setUpdateStatus('ready')
      } else {
        setUpdateStatus('up-to-date')
        setTimeout(() => setUpdateStatus('idle'), 3000)
      }
    } catch (err: any) {
      console.error('[Updater] Update check failed:', err)
      setUpdateStatus('error')
      const message = err?.message || 'Update check failed'
      setUpdateError(message)
      // Don't auto-dismiss error — let user see and click to retry
    }
  }

  const relaunchApp = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch {
      // fallback
    }
  }

  const save = async () => {
    if (!settings || !dirty) return
    setSaving(true)
    try {
      await window.api.saveSettings(settings)

      // Apply font size to document
      document.documentElement.style.setProperty(
        '--chat-font-size',
        `${settings.appearance.chatFontSize}px`
      )

      applyFontVars(document.documentElement, settings.appearance)

      setDirty(false)
      setInitialUseLegacyClaudeCli(settings.providers?.useLegacyClaudeCli !== false)
      onSettingsSaved?.(settings)
    } catch (err: any) {
      console.error('[Settings] save failed:', err)
      showToast({
        type: 'error',
        title: t('settings.saveFailedTitle'),
        message:
          typeof err === 'string'
            ? err
            : err?.message ?? t('settings.saveFailedMessage'),
      })
    } finally {
      setSaving(false)
    }
  }

  const currentUseLegacyClaudeCli = settings?.providers?.useLegacyClaudeCli !== false
  const runtimeDirty =
    initialUseLegacyClaudeCli !== null &&
    initialUseLegacyClaudeCli !== currentUseLegacyClaudeCli

  if (!settings) {
    return (
      <div className="settings-panel">
        <div className="settings-loading">{t('common.loading')}</div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      {/* Top drag strip — spans full width so users can drag the window
          from above either column on the settings page. */}
      <div className="settings-drag-strip drag" data-tauri-drag-region />
      <div className="settings-sidebar">
        <h2 className="settings-title drag" data-tauri-drag-region>{t('settings.title')}</h2>
        <nav className="settings-nav">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              className={`settings-nav-item ${tab === tb.id ? 'active' : ''}`}
              onClick={() => setTab(tb.id)}
            >
              <tb.icon size={16} />
              <span>{tb.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="settings-content">
        {tab === 'general' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.general.title')}</h3>

            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">
                  <Globe size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                  {t('settings.language.title')}
                </span>
                <span className="settings-desc">{t('settings.language.desc')}</span>
              </span>
              <select
                className="settings-select"
                value={settings.general.language || 'en'}
                onChange={(e) => changeLanguage(e.target.value)}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.general.restoreWorkspace')}</span>
                <span className="settings-desc">
                  {t('settings.general.restoreWorkspaceDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.general.restoreLastWorkspace}
                onChange={(e) =>
                  update('general', { restoreLastWorkspace: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.general.launchAtLogin')}</span>
                <span className="settings-desc">
                  {t('settings.general.launchAtLoginDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.general.launchAtLogin}
                onChange={(e) =>
                  update('general', { launchAtLogin: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>

          </div>
        )}

        {tab === 'agents' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.agents.title')}</h3>
            <p className="settings-section-desc">
              {t('settings.agents.desc')}
            </p>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.agents.fileWrite')}</span>
                <span className="settings-desc">
                  {t('settings.agents.fileWriteDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.agents.defaultPermissions.fileWrite}
                onChange={(e) =>
                  updateNested('agents', 'defaultPermissions', {
                    fileWrite: e.target.checked,
                  })
                }
              />
              <span className="toggle-slider" />
            </label>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.agents.shell')}</span>
                <span className="settings-desc">
                  {t('settings.agents.shellDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.agents.defaultPermissions.bash}
                onChange={(e) =>
                  updateNested('agents', 'defaultPermissions', {
                    bash: e.target.checked,
                  })
                }
              />
              <span className="toggle-slider" />
            </label>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.agents.network')}</span>
                <span className="settings-desc">
                  {t('settings.agents.networkDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.agents.defaultPermissions.network}
                onChange={(e) =>
                  updateNested('agents', 'defaultPermissions', {
                    network: e.target.checked,
                  })
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        )}

        {tab === 'models' && (
          <ModelsTab
            providers={
              settings.providers ?? {
                useLegacyClaudeCli: true,
                defaultProvider: 'anthropic',
                defaultModel: 'claude-sonnet-4-6',
                plannerModel: 'claude-haiku-4-5-20251001',
                configuredProviders: {},
              }
            }
            advanced={settings.advanced}
            bestOpusModel={bestOpusModel}
            onProvidersChange={(patch) => update('providers', patch)}
            onAdvancedChange={(patch) => update('advanced', patch)}
          />
        )}

        {tab === 'mcp' && (
          <McpTab
            servers={settings.mcp?.servers ?? {}}
            onChange={(servers) => update('mcp', { servers })}
          />
        )}

        {tab === 'appearance' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.appearance.title')}</h3>

            <div className="settings-field">
              <span className="settings-label">{t('settings.appearance.theme')}</span>
              <div className="settings-segment" role="radiogroup" aria-label={t('settings.appearance.theme')}>
                {(['system', 'light', 'dark'] as const).map((value) => {
                  const labelKey =
                    value === 'system'
                      ? 'settings.appearance.themeSystem'
                      : value === 'light'
                        ? 'settings.appearance.themeLight'
                        : 'settings.appearance.themeDark'
                  const active = settings.appearance.theme === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`settings-segment-option${active ? ' settings-segment-option--active' : ''}`}
                      onClick={() => update('appearance', { theme: value })}
                    >
                      {t(labelKey)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="settings-field">
              <span className="settings-label">{t('settings.appearance.chatFontSize')}</span>
              <div className="settings-slider-row">
                <span className="settings-slider-label">A</span>
                <input
                  type="range"
                  min={13}
                  max={18}
                  step={1}
                  value={settings.appearance.chatFontSize}
                  onChange={(e) =>
                    update('appearance', {
                      chatFontSize: Number(e.target.value),
                    })
                  }
                />
                <span className="settings-slider-label settings-slider-label--lg">A</span>
                <span className="settings-slider-value">
                  {settings.appearance.chatFontSize}px
                </span>
              </div>
            </div>

            <h4 className="settings-section-title" style={{ marginTop: 20, fontSize: 14 }}>
              {t('settings.appearance.fontsTitle')}
            </h4>

            <AppearanceFontSelector
              kind="ui"
              value={settings.appearance.uiFont}
              onChange={(next) => update('appearance', { uiFont: next })}
            />
            <AppearanceFontSelector
              kind="chat"
              value={settings.appearance.chatFont}
              onChange={(next) => update('appearance', { chatFont: next })}
            />
            <AppearanceFontSelector
              kind="code"
              value={settings.appearance.codeFont}
              onChange={(next) => update('appearance', { codeFont: next })}
            />
          </div>
        )}

        {tab === 'shortcuts' && (
          <div className="settings-section">
            {/* Keyboard Shortcuts (read-only) */}
            <h3 className="settings-section-title">{t('settings.shortcuts.keyboardTitle')}</h3>
            <div className="settings-shortcut-list">
              {SHORTCUTS.map((s) => (
                <div key={s.label} className="settings-shortcut-row">
                  <span className="settings-shortcut-action">{s.label}</span>
                  <span className="settings-shortcut-keys">
                    {s.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>

            {/* Text Shortcuts (CRUD) */}
            <h3 className="settings-section-title" style={{ marginTop: 24 }}>
              <Zap size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('settings.shortcuts.textExpansionsTitle')}
            </h3>
            <p className="settings-section-desc">
              {t('settings.shortcuts.textExpansionsDesc')}
            </p>

            {/* Existing shortcuts list */}
            {(settings.shortcuts?.textExpansions || []).length === 0 ? (
              <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                {t('settings.shortcuts.noShortcuts')}
              </p>
            ) : (
              <div className="text-shortcut-list">
                {(settings.shortcuts?.textExpansions || []).map((sc, idx) => (
                  <div key={idx} className="text-shortcut-row">
                    <div className="text-shortcut-trigger">
                      <kbd>{sc.trigger}</kbd>
                    </div>
                    <div className="text-shortcut-arrow">→</div>
                    <div className="text-shortcut-expansion">{sc.expansion}</div>
                    {sc.description && (
                      <div className="text-shortcut-desc">{sc.description}</div>
                    )}
                    <button
                      className="text-shortcut-delete"
                      title={t('common.delete')}
                      onClick={() => {
                        if (!confirm(t('settings.shortcuts.deleteConfirm', { trigger: sc.trigger }))) return
                        const updated = {
                          ...settings,
                          shortcuts: {
                            ...settings.shortcuts,
                            textExpansions: (settings.shortcuts?.textExpansions || []).filter((_, i) => i !== idx),
                          },
                        }
                        setSettings(updated)
                        setDirty(true)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new shortcut form */}
            <div className="text-shortcut-add">
              <div className="text-shortcut-add-row">
                <input
                  className="text-shortcut-input trigger-input"
                  placeholder={t('settings.shortcuts.triggerPlaceholder')}
                  value={newTrigger}
                  onChange={(e) => {
                    setNewTrigger(e.target.value)
                    setShortcutError(null)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTextShortcut() }}
                />
                <input
                  className="text-shortcut-input expansion-input"
                  placeholder={t('settings.shortcuts.expansionPlaceholder')}
                  value={newExpansion}
                  onChange={(e) => {
                    setNewExpansion(e.target.value)
                    setShortcutError(null)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTextShortcut() }}
                />
                <button
                  className="text-shortcut-add-btn"
                  onClick={addTextShortcut}
                  title={t('settings.shortcuts.addShortcut')}
                >
                  <Plus size={16} />
                </button>
              </div>
              {shortcutError && (
                <div className="text-shortcut-error">{shortcutError}</div>
              )}
            </div>
          </div>
        )}

        {tab === 'advanced' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.advanced.title')}</h3>

            {/* Backup Retention */}
            <h3 className="settings-section-title">
              <RotateCw size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('settings.advanced.backupTitle')}
            </h3>
            <p className="settings-section-desc">{t('settings.advanced.backupDesc')}</p>

            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.advanced.backupMaxCount')}</span>
                <span className="settings-desc">{t('settings.advanced.backupMaxCountDesc')}</span>
              </span>
              <input
                type="number"
                className="settings-input"
                min={1}
                max={1000}
                value={settings.backup?.maxBackupsPerWorkspace ?? 50}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(1000, Number(e.target.value) || 50))
                  update('backup', {
                    maxBackupsPerWorkspace: n,
                    maxAgeDays: settings.backup?.maxAgeDays ?? 7,
                  })
                }}
                style={{ width: 80 }}
              />
            </div>

            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.advanced.backupMaxAge')}</span>
                <span className="settings-desc">{t('settings.advanced.backupMaxAgeDesc')}</span>
              </span>
              <input
                type="number"
                className="settings-input"
                min={1}
                max={365}
                value={settings.backup?.maxAgeDays ?? 7}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(365, Number(e.target.value) || 7))
                  update('backup', {
                    maxBackupsPerWorkspace: settings.backup?.maxBackupsPerWorkspace ?? 50,
                    maxAgeDays: n,
                  })
                }}
                style={{ width: 80 }}
              />
            </div>

          </div>
        )}

        {tab === 'about' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.about.title')}</h3>

            <div className="settings-about-logo">
              <span className="settings-about-emoji">🐙</span>
              <span className="settings-about-name">Octopal</span>
            </div>

            <div className="settings-about-info">
              <div className="settings-about-row">
                <span>{t('settings.about.version')}</span>
                <span>{versionInfo?.version || '...'}</span>
              </div>
              <div className="settings-about-row">
                <span>{t('settings.about.electron')}</span>
                <span>{versionInfo?.electron || '...'}</span>
              </div>
              <div className="settings-about-row">
                <span>{t('settings.about.node')}</span>
                <span>{versionInfo?.node || '...'}</span>
              </div>
            </div>

            <div className="settings-about-links">
              <button
                className="settings-about-link"
                onClick={() => {
                  window.open('https://github.com/gilhyun/Octopal', '_blank');
                }}
              >
                <ExternalLink size={14} />
                <span>{t('settings.about.github')}</span>
              </button>
              {updateStatus === 'ready' ? (
                <button
                  className="settings-about-link settings-update-ready"
                  onClick={relaunchApp}
                >
                  <Download size={14} />
                  <span>{t('settings.about.restartToUpdate')}</span>
                </button>
              ) : (
                <button
                  className="settings-about-link"
                  disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                  onClick={checkForUpdates}
                >
                  {updateStatus === 'checking' ? (
                    <RotateCw size={14} className="spin" />
                  ) : updateStatus === 'downloading' ? (
                    <Download size={14} />
                  ) : updateStatus === 'up-to-date' ? (
                    <Check size={14} />
                  ) : (
                    <RotateCw size={14} />
                  )}
                  <span>
                    {updateStatus === 'checking'
                      ? t('settings.about.checking')
                      : updateStatus === 'downloading'
                        ? `${t('settings.about.downloading')} ${downloadProgress}%`
                        : updateStatus === 'up-to-date'
                          ? t('settings.about.upToDate')
                          : updateStatus === 'error'
                            ? updateError || 'Error'
                            : t('settings.about.checkUpdates')}
                  </span>
                </button>
              )}
            </div>

            <p className="settings-about-copyright">
              {t('settings.about.copyright')}
            </p>
          </div>
        )}

        {dirty && (
          <div className="settings-save-bar">
            <span>
              {t('settings.unsavedChanges')}
              {runtimeDirty && (
                <span className="settings-save-bar-hint">
                  {' · '}
                  {t('settings.models.runtimeApplyHint')}
                </span>
              )}
            </span>
            <button
              className="settings-save-btn"
              onClick={save}
              disabled={saving}
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
