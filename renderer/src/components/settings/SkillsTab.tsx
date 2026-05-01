import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { SkillEditModal } from '../modals/SkillEditModal'

interface SkillsTabProps {
  activeFolder?: string | null
}

function isAgentScope(source: string): boolean {
  return source.startsWith('agent:')
}

function scopeLabel(source: string, t: (k: string, opts?: any) => string): string {
  if (source === 'workspace') return t('settings.skills.scopeWorkspace')
  if (source === 'user') return t('settings.skills.scopeUser')
  if (isAgentScope(source)) {
    return t('settings.skills.scopeAgent', { name: source.slice('agent:'.length) })
  }
  return source
}

export function SkillsTab({ activeFolder }: SkillsTabProps) {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillForSettings[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editTarget, setEditTarget] = useState<SkillForSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.listSkillsForSettings?.(activeFolder ?? '')
      setSkills(list ?? [])
    } catch (e: any) {
      console.error('[SkillsTab] listSkillsForSettings failed', e)
      setSkills([])
      setError(typeof e === 'string' ? e : e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [activeFolder])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openCreate = () => {
    setEditTarget(null)
    setShowModal(true)
  }

  const openEdit = (skill: SkillForSettings) => {
    if (isAgentScope(skill.source)) return
    setEditTarget(skill)
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
    setEditTarget(null)
  }

  const handleDelete = async (skill: SkillForSettings) => {
    if (isAgentScope(skill.source)) return
    if (!confirm(t('settings.skills.deleteConfirm', { name: skill.name }))) return
    try {
      const res = await window.api.deleteSkill?.(skill.path)
      if (!res) {
        setError(t('settings.skills.apiUnavailable'))
        return
      }
      if (!res.ok) {
        setError(res.error)
        return
      }
      await refresh()
    } catch (e: any) {
      console.error('[SkillsTab] deleteSkill failed', e)
      setError(typeof e === 'string' ? e : e?.message ?? String(e))
    }
  }

  const handleToggle = async (skill: SkillForSettings, next: boolean) => {
    if (isAgentScope(skill.source)) return
    // Optimistic update.
    setSkills((prev) =>
      prev.map((s) => (s.path === skill.path ? { ...s, enabled: next } : s)),
    )
    try {
      const res = await window.api.updateSkill?.({ path: skill.path, enabled: next })
      if (!res) {
        setError(t('settings.skills.apiUnavailable'))
        await refresh()
        return
      }
      if (!res.ok) {
        setError(res.error)
        await refresh()
      }
    } catch (e: any) {
      console.error('[SkillsTab] updateSkill failed', e)
      setError(typeof e === 'string' ? e : e?.message ?? String(e))
      await refresh()
    }
  }

  return (
    <>
      <div
        className="settings-section-title"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <h3 className="settings-section-title" style={{ margin: 0 }}>
          <Sparkles size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('settings.skills.title')}
        </h3>
        <button
          type="button"
          className="provider-card-btn primary"
          onClick={openCreate}
        >
          <Plus size={14} />
          {t('settings.skills.addSkill')}
        </button>
      </div>

      <p className="settings-section-desc">{t('settings.skills.desc')}</p>

      {!activeFolder && (
        <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.7 }}>
          {t('settings.skills.openFolderHint')}
        </p>
      )}

      {error && <div className="modal-error" role="alert">{error}</div>}

      {loading ? (
        <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6 }}>
          {t('common.loading')}
        </p>
      ) : skills.length === 0 ? (
        <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6 }}>
          {t('settings.skills.noSkills')}
        </p>
      ) : (
        <div className="text-shortcut-list">
          {skills.map((skill) => {
            const agentReadOnly = isAgentScope(skill.source)
            const parseFailed = skill.parseFailed === true
            // Parse-failed rows are read-only so a stray toggle can't clobber
            // the user's hand-edited file with empty defaults.
            const readOnly = agentReadOnly || parseFailed
            return (
              <div key={skill.path} className="text-shortcut-row">
                <div className="text-shortcut-trigger">
                  <kbd>/{skill.name}</kbd>
                </div>
                <div className="text-shortcut-arrow">·</div>
                <div className="text-shortcut-expansion" style={{ flex: 1 }}>
                  <div>{skill.description || ''}</div>
                  <div
                    className="settings-section-desc"
                    style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}
                  >
                    {scopeLabel(skill.source, t)}
                    {parseFailed && (
                      <>
                        {' · '}
                        <span style={{ fontStyle: 'italic', color: 'var(--danger, #c33)' }}>
                          {t('settings.skills.frontmatterError', { reason: skill.path })}
                        </span>
                      </>
                    )}
                    {!skill.enabled && !parseFailed && (
                      <>
                        {' · '}
                        <span style={{ fontStyle: 'italic' }}>
                          {t('settings.skills.disabledTag')}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <label
                  className="settings-toggle"
                  style={{ width: 'auto', padding: 0, marginRight: 8 }}
                  title={
                    agentReadOnly
                      ? t('settings.skills.agentReadOnlyHint')
                      : t('settings.skills.enabledLabel')
                  }
                >
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    disabled={readOnly}
                    onChange={(e) => handleToggle(skill, e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
                <button
                  className="text-shortcut-delete"
                  title={
                    agentReadOnly
                      ? t('settings.skills.agentReadOnlyHint')
                      : t('common.edit')
                  }
                  disabled={readOnly}
                  aria-disabled={readOnly}
                  onClick={() => openEdit(skill)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="text-shortcut-delete"
                  title={
                    agentReadOnly
                      ? t('settings.skills.agentReadOnlyHint')
                      : t('common.delete')
                  }
                  disabled={readOnly}
                  aria-disabled={readOnly}
                  onClick={() => handleDelete(skill)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <p
        className="settings-section-desc"
        style={{ marginTop: 16, fontStyle: 'italic', opacity: 0.7 }}
      >
        {t('settings.skills.runtimeFootnote')}
      </p>

      {showModal && (
        <SkillEditModal
          skill={editTarget}
          activeFolder={activeFolder ?? null}
          onClose={closeModal}
          onSaved={() => {
            closeModal()
            void refresh()
          }}
          onDeleted={() => {
            closeModal()
            void refresh()
          }}
        />
      )}
    </>
  )
}
