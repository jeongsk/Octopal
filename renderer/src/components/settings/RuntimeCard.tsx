import { useTranslation } from 'react-i18next'
import { FlaskConical } from 'lucide-react'

interface RuntimeCardProps {
  useLegacyClaudeCli: boolean
  onChange: (useLegacyClaudeCli: boolean) => void
}

/**
 * Runtime selection card — promoted to a first-class IA control because
 * it determines which other settings actually take effect (`agent.rs`
 * vs `goose_acp.rs` paths). Writes to `providers.useLegacyClaudeCli`.
 */
export function RuntimeCard({ useLegacyClaudeCli, onChange }: RuntimeCardProps) {
  const { t } = useTranslation()
  const isClaudeCli = useLegacyClaudeCli !== false

  return (
    <div className="settings-field" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <span className="settings-toggle-info" style={{ marginBottom: 4 }}>
        <span className="settings-label">
          <FlaskConical size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('settings.models.runtimeTitle')}
        </span>
        <span className="settings-desc">{t('settings.models.runtimeDesc')}</span>
      </span>
      <div className="settings-segment" role="radiogroup" aria-label={t('settings.models.runtimeTitle')}>
        <button
          type="button"
          role="radio"
          aria-checked={isClaudeCli}
          className={`settings-segment-option${isClaudeCli ? ' settings-segment-option--active' : ''}`}
          onClick={() => onChange(true)}
        >
          {t('settings.models.runtimeClaudeCli')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!isClaudeCli}
          className={`settings-segment-option${!isClaudeCli ? ' settings-segment-option--active' : ''}`}
          onClick={() => onChange(false)}
        >
          {t('settings.models.runtimeGoose')}
        </button>
      </div>
      <span className="settings-desc" style={{ marginTop: 2 }}>
        {isClaudeCli
          ? t('settings.models.runtimeClaudeCliDesc')
          : t('settings.models.runtimeGooseDesc')}
      </span>
    </div>
  )
}
