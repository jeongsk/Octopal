import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Info, KeyRound, Loader2 } from 'lucide-react'
import { ProviderCard } from './ProviderCard'
import { RuntimeCard } from './RuntimeCard'
import { DefaultModelCard } from './DefaultModelCard'

/**
 * Settings → Models tab (Step 2 of the Runtime-first IA refactor).
 *
 * Sections (top to bottom):
 *   1. Runtime card — segmented control, writes `providers.useLegacyClaudeCli`.
 *   2. Default model card — runtime-aware single control. Writes only the
 *      backend field consumed by the active runtime, never both.
 *   3. Status banner — keyring / env_fallback / unavailable.
 *   4. Per-provider key cards — dimmed + inline banner under Claude CLI
 *      (those keys are only consumed by the Goose runtime).
 *
 * `plannerModel` UI is hidden — backend field is preserved for the day
 * the dispatcher actually consumes it (still hardcoded to haiku today).
 */

interface ModelsTabProps {
  providers: NonNullable<AppSettings['providers']>
  advanced: AppSettings['advanced']
  bestOpusModel: string | null
  onProvidersChange: (patch: Partial<NonNullable<AppSettings['providers']>>) => void
  onAdvancedChange: (patch: Partial<AppSettings['advanced']>) => void
}

export function ModelsTab({
  providers,
  advanced,
  bestOpusModel,
  onProvidersChange,
  onAdvancedChange,
}: ModelsTabProps) {
  const { t } = useTranslation()
  const [manifest, setManifest] = useState<ProvidersManifest | null>(null)
  const [status, setStatus] = useState<KeyringStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const [configured, setConfigured] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [m, s] = await Promise.all([
          window.api.getProvidersManifest?.() ?? Promise.resolve(null),
          window.api.keyringStatus?.() ?? Promise.resolve(null),
        ])
        if (cancelled) return
        setManifest(m)
        setStatus(s)
        if (m) {
          const entries = await Promise.all(
            Object.keys(m).map(async (pid) => {
              const has = (await window.api.hasApiKey?.(pid)) ?? false
              return [pid, has] as const
            }),
          )
          if (cancelled) return
          setConfigured(Object.fromEntries(entries))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshConfigured = useCallback(
    async (provider: string) => {
      const has = (await window.api.hasApiKey?.(provider)) ?? false
      setConfigured((prev) => ({ ...prev, [provider]: has }))
      onProvidersChange({
        configuredProviders: {
          ...(providers.configuredProviders ?? {}),
          [provider]: has,
        },
      })
    },
    [providers.configuredProviders, onProvidersChange],
  )

  const availableModelsFor = useCallback(
    (providerId: string): string[] => {
      if (!manifest) return []
      const entry = manifest[providerId]
      if (!entry) return []
      const baseList = Array.isArray(entry.models) ? entry.models : []
      if (providerId === 'anthropic') {
        return ['opus', 'sonnet', 'haiku', ...baseList]
      }
      return baseList
    },
    [manifest],
  )

  const isClaudeCli = providers.useLegacyClaudeCli !== false

  const runtimeCard = useMemo(
    () => (
      <RuntimeCard
        useLegacyClaudeCli={providers.useLegacyClaudeCli !== false}
        onChange={(useLegacyClaudeCli) => onProvidersChange({ useLegacyClaudeCli })}
      />
    ),
    [providers.useLegacyClaudeCli, onProvidersChange],
  )

  if (loading) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">
          <KeyRound size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('settings.tabs.models')}
        </h3>
        {runtimeCard}
        <div style={{ opacity: 0.6, marginTop: 12 }}>
          <Loader2 size={14} className="spin" style={{ marginRight: 6, verticalAlign: 'middle' }} />
          {t('common.loading')}
        </div>
      </div>
    )
  }

  if (!manifest) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">
          <KeyRound size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('settings.tabs.models')}
        </h3>
        {runtimeCard}
        <p className="settings-section-desc">{t('settings.providers.manifestUnavailable')}</p>
      </div>
    )
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">
        <KeyRound size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        {t('settings.tabs.models')}
      </h3>

      {runtimeCard}

      <DefaultModelCard
        useLegacyClaudeCli={isClaudeCli}
        providers={providers}
        advanced={advanced}
        bestOpusModel={bestOpusModel}
        manifest={manifest}
        availableModelsFor={availableModelsFor}
        onProvidersChange={onProvidersChange}
        onAdvancedChange={onAdvancedChange}
      />

      <h4 className="settings-section-title" style={{ marginTop: 20, fontSize: 14 }}>
        {t('settings.providers.keysTitle')}
      </h4>

      {isClaudeCli && (
        <div className="providers-status-banner info" role="note">
          <Info size={14} />
          <span>{t('settings.models.keysClaudeCliBanner')}</span>
        </div>
      )}

      {status && (
        <div
          className={`providers-status-banner ${status.backend === 'env_fallback' ? 'warn' : status.available ? 'info' : 'error'}`}
        >
          {status.backend === 'env_fallback' ? (
            <AlertTriangle size={14} />
          ) : status.available ? (
            <Info size={14} />
          ) : (
            <AlertTriangle size={14} />
          )}
          <span>
            {status.backend === 'env_fallback'
              ? t('settings.providers.statusEnvFallback', { envVar: status.fallback_env_var })
              : status.available
                ? t('settings.providers.statusKeyring')
                : t('settings.providers.statusUnavailable')}
          </span>
        </div>
      )}

      <div
        className="provider-card-grid"
        style={isClaudeCli ? { opacity: 0.5 } : undefined}
      >
        {Object.entries(manifest).map(([pid, entry]) => {
          const primaryAuth = entry.authMethods[0]
          if (!primaryAuth) return null
          const envVarName = `OCTOPAL_KEY_${pid.toUpperCase()}`
          const isHostOnly = primaryAuth.id === 'host_only'
          return (
            <ProviderCard
              key={pid}
              providerId={pid}
              displayName={entry.displayName}
              hasKey={configured[pid] ?? false}
              envFallback={status?.backend === 'env_fallback'}
              envVarName={envVarName}
              keyLabel={
                isHostOnly
                  ? t('settings.providers.hostUrl')
                  : t('settings.providers.apiKey')
              }
              authMethodId={primaryAuth.id}
              onSaved={() => refreshConfigured(pid)}
              onRemoved={() => refreshConfigured(pid)}
            />
          )
        })}
      </div>
    </div>
  )
}
