import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ClaudeLoginModalProps {
  installed: boolean
  onDismiss: () => void
  onStatusChange?: (status: { installed: boolean; loggedIn: boolean }) => void
}

export function ClaudeLoginModal({ installed, onDismiss, onStatusChange }: ClaudeLoginModalProps) {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)

  const handleRetryCheck = async () => {
    setChecking(true)
    setRetryFailed(false)
    try {
      const status = await window.api.checkClaudeCli()
      if (status.installed && status.loggedIn) {
        onStatusChange?.(status)
        onDismiss()
      } else {
        onStatusChange?.(status)
        setRetryFailed(true)
      }
    } catch {
      setRetryFailed(true)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop--blocking">
      <div className="modal claude-login-modal">
        <div className="claude-login-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="welcome-title">
          {installed ? t('modals.claudeLogin.titleNotLoggedIn') : t('modals.claudeLogin.titleNotInstalled')}
        </div>
        <div className="welcome-desc claude-login-desc">
          {installed ? (
            <>
              <p>{t('modals.claudeLogin.descNotLoggedIn')}</p>
              <div className="claude-login-code">
                <code>claude login</code>
              </div>
              <p className="claude-login-hint">
                {t('modals.claudeLogin.hint')}
              </p>
            </>
          ) : (
            <>
              <p>{t('modals.claudeLogin.descNotInstalled')}</p>
              <div className="claude-login-code">
                <code>npm install -g @anthropic-ai/claude-code</code>
              </div>
              <p className="claude-login-step-label">{t('modals.claudeLogin.thenLogin')}</p>
              <div className="claude-login-code">
                <code>claude login</code>
              </div>
            </>
          )}
          {retryFailed && (
            <p className="claude-login-retry-failed">
              {t('modals.claudeLogin.retryFailed')}
            </p>
          )}
        </div>
        <div className="claude-login-actions">
          <button className="btn-primary" onClick={handleRetryCheck} disabled={checking}>
            {checking ? t('modals.claudeLogin.checking') : t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
