import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'

interface DefaultModelCardProps {
  useLegacyClaudeCli: boolean
  providers: NonNullable<AppSettings['providers']>
  advanced: AppSettings['advanced']
  bestOpusModel: string | null
  manifest: ProvidersManifest
  availableModelsFor: (providerId: string) => string[]
  onProvidersChange: (patch: Partial<NonNullable<AppSettings['providers']>>) => void
  onAdvancedChange: (patch: Partial<AppSettings['advanced']>) => void
}

// `claude-opus-4-7` → `Opus 4.7`. Keep raw form on mismatch so we never
// hide information from the user.
function prettyOpusLabel(model: string): string {
  const match = model.match(/^claude-([a-z]+)-(\d+)-(\d+)$/i)
  if (!match) return model
  const [, tier, major, minor] = match
  const capitalized = tier.charAt(0).toUpperCase() + tier.slice(1)
  return `${capitalized} ${major}.${minor}`
}

/**
 * Runtime-aware default model card. Writes to whichever backend field is
 * actually consumed by the active runtime — never both — so the user's
 * other-runtime selection is preserved across toggles.
 *
 * - Claude CLI: `advanced.autoModelSelection` + `advanced.defaultAgentModel`
 *   (consumed by `agent.rs:515,522`)
 * - Goose:      `providers.defaultProvider` + `providers.defaultModel`
 *   (consumed by `goose_acp.rs:236-237` as GOOSE_PROVIDER / GOOSE_MODEL env)
 */
export function DefaultModelCard({
  useLegacyClaudeCli,
  providers,
  advanced,
  bestOpusModel,
  manifest,
  availableModelsFor,
  onProvidersChange,
  onAdvancedChange,
}: DefaultModelCardProps) {
  const { t } = useTranslation()
  const isClaudeCli = useLegacyClaudeCli !== false

  // Hook must run unconditionally (Rules of Hooks); value only consumed on the Goose branch.
  const defaultModelOptions = useMemo(
    () => availableModelsFor(providers.defaultProvider ?? 'anthropic'),
    [availableModelsFor, providers.defaultProvider],
  )

  if (isClaudeCli) {
    const adaptive = advanced?.autoModelSelection === true
    const tier = advanced?.defaultAgentModel ?? 'opus'
    return (
      <div>
        <h4 className="settings-section-title" style={{ marginTop: 20, fontSize: 14 }}>
          <Zap size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('settings.models.defaultModelTitle')}
        </h4>
        <label className="settings-toggle">
          <span className="settings-toggle-info">
            <span className="settings-label">{t('settings.models.adaptiveOn')}</span>
            <span className="settings-desc">{t('settings.advanced.autoModelSelectionDesc')}</span>
          </span>
          <input
            type="checkbox"
            checked={adaptive}
            onChange={(e) => onAdvancedChange({ autoModelSelection: e.target.checked })}
            aria-label={t('settings.models.adaptiveOn')}
          />
          <span className="toggle-slider" />
        </label>

        {!adaptive && (
          <div className="settings-field" style={{ marginLeft: 16, opacity: 0.9 }}>
            <span className="settings-toggle-info">
              <span className="settings-label">{t('settings.advanced.defaultAgentModel')}</span>
              <span className="settings-desc">{t('settings.advanced.defaultAgentModelDesc')}</span>
            </span>
            <select
              className="settings-select"
              value={tier}
              onChange={(e) =>
                onAdvancedChange({
                  defaultAgentModel: e.target.value as 'haiku' | 'sonnet' | 'opus',
                })
              }
            >
              <option value="haiku">{t('settings.advanced.modelHaiku')}</option>
              <option value="sonnet">{t('settings.advanced.modelSonnet')}</option>
              <option value="opus">
                {t('settings.advanced.modelOpus')}
                {bestOpusModel ? ` — ${prettyOpusLabel(bestOpusModel)}` : ''}
              </option>
            </select>
            {bestOpusModel && (
              <span
                className="settings-desc"
                style={{ marginLeft: 16, display: 'block', marginTop: 4 }}
              >
                {t('settings.advanced.opusDetected', { model: prettyOpusLabel(bestOpusModel) })}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }

  // Goose mode — provider + model select pair
  return (
    <div>
      <h4 className="settings-section-title" style={{ marginTop: 20, fontSize: 14 }}>
        <Zap size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        {t('settings.models.defaultModelTitle')}
      </h4>
      <div className="settings-field">
        <span className="settings-toggle-info">
          <span className="settings-label">{t('settings.providers.defaultProvider')}</span>
          <span className="settings-desc">{t('settings.providers.defaultProviderDesc')}</span>
        </span>
        <select
          className="settings-select"
          value={providers.defaultProvider ?? 'anthropic'}
          onChange={(e) => onProvidersChange({ defaultProvider: e.target.value })}
        >
          {Object.entries(manifest).map(([pid, entry]) => (
            <option key={pid} value={pid}>
              {entry.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <span className="settings-toggle-info">
          <span className="settings-label">{t('settings.providers.defaultModel')}</span>
          <span className="settings-desc">{t('settings.providers.defaultModelDesc')}</span>
        </span>
        <select
          className="settings-select"
          value={providers.defaultModel ?? 'claude-sonnet-4-6'}
          onChange={(e) => onProvidersChange({ defaultModel: e.target.value })}
        >
          {defaultModelOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
