import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ModalTab = 'basic' | 'body'

interface SkillEditModalProps {
  skill: SkillForSettings | null
  activeFolder?: string | null
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

function stripFrontmatter(raw: string): string {
  const trimmed = raw.replace(/^﻿/, '')
  if (!trimmed.startsWith('---')) return raw
  const afterOpener = trimmed.replace(/^---[^\n]*\n/, '')
  const closeIdx = afterOpener.indexOf('\n---')
  if (closeIdx === -1) return raw
  return afterOpener.slice(closeIdx + 4).replace(/^\n+/, '')
}

function deriveScope(source: string): SkillScope {
  if (source === 'user') return 'user'
  return 'workspace'
}

const NAME_PATTERN = /^[a-zA-Z0-9_\- ]+$/

export function SkillEditModal({
  skill,
  activeFolder,
  onClose,
  onSaved,
  onDeleted,
}: SkillEditModalProps) {
  const { t } = useTranslation()
  const isEdit = skill !== null
  const [tab, setTab] = useState<ModalTab>('basic')
  const initialBody = useMemo(
    () => (skill ? stripFrontmatter(skill.raw) : ''),
    [skill],
  )

  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [argumentHint, setArgumentHint] = useState(skill?.argumentHint ?? '')
  const [body, setBody] = useState(initialBody)
  const [enabled, setEnabled] = useState(skill?.enabled ?? true)
  const [scope, setScope] = useState<SkillScope>(
    skill ? deriveScope(skill.source) : activeFolder ? 'workspace' : 'user',
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Per-agent skills should never reach this modal (caller filters), but
  // close defensively if one slips through.
  useEffect(() => {
    if (skill && skill.source.startsWith('agent:')) {
      onClose()
    }
  }, [skill, onClose])

  const validate = (): string | null => {
    const trimmedName = name.trim()
    if (!trimmedName) return t('settings.skills.nameRequired')
    if (!NAME_PATTERN.test(trimmedName)) return t('settings.skills.nameInvalid')
    if (!description.trim()) return t('settings.skills.descriptionRequired')
    return null
  }

  const save = async () => {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setSaving(true)
    try {
      if (isEdit && skill) {
        const res = await window.api.updateSkill?.({
          path: skill.path,
          name: name.trim(),
          description: description.trim(),
          argumentHint: argumentHint.trim() || undefined,
          body,
          enabled,
        })
        if (res && !res.ok) {
          setError(res.error)
          return
        }
        onSaved()
      } else {
        if (scope === 'workspace' && !activeFolder) {
          setError(t('settings.skills.openFolderHint'))
          return
        }
        const res = await window.api.createSkill?.({
          scope,
          folderPath: scope === 'workspace' ? activeFolder ?? undefined : undefined,
          name: name.trim(),
          description: description.trim(),
          argumentHint: argumentHint.trim() || undefined,
          body,
          enabled,
        })
        if (res && !res.ok) {
          setError(res.error)
          return
        }
        onSaved()
      }
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!skill) return
    if (!confirm(t('modals.editSkill.deleteConfirm', { name: skill.name }))) return
    try {
      const res = await window.api.deleteSkill?.(skill.path)
      if (res && !res.ok) {
        setError(res.error)
        return
      }
      onDeleted()
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e?.message ?? String(e))
    }
  }

  const tabs: { id: ModalTab; label: string }[] = [
    { id: 'basic', label: t('modals.editSkill.tabBasic') },
    { id: 'body', label: t('modals.editSkill.tabBody') },
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {isEdit ? t('modals.editSkill.editTitle') : t('modals.editSkill.createTitle')}
        </div>

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
              <label className="modal-label" style={{ marginTop: 0 }}>{t('label.name')}</label>
              <input
                className="modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
              />

              <label className="modal-label">{t('settings.skills.scopeLabel')}</label>
              {isEdit ? (
                <input
                  className="modal-input"
                  value={
                    scope === 'workspace'
                      ? t('settings.skills.scopeWorkspace')
                      : t('settings.skills.scopeUser')
                  }
                  disabled
                />
              ) : (
                <div className="settings-segment" role="radiogroup" aria-label={t('settings.skills.scopeLabel')}>
                  {(['workspace', 'user'] as const).map((value) => {
                    const active = scope === value
                    const disabled = value === 'workspace' && !activeFolder
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        className={`settings-segment-option${active ? ' settings-segment-option--active' : ''}`}
                        onClick={() => setScope(value)}
                      >
                        {value === 'workspace'
                          ? t('settings.skills.scopeWorkspace')
                          : t('settings.skills.scopeUser')}
                      </button>
                    )
                  })}
                </div>
              )}

              <label className="modal-label">{t('label.role')}</label>
              <textarea
                className="modal-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />

              <label className="modal-label">{t('settings.skills.argumentHintLabel')}</label>
              <input
                className="modal-input"
                value={argumentHint}
                onChange={(e) => setArgumentHint(e.target.value)}
                placeholder={t('settings.skills.argumentHintPlaceholder')}
                disabled={saving}
              />

              <label className="settings-toggle" style={{ marginTop: 12 }}>
                <span className="settings-toggle-info">
                  <span className="settings-label">
                    {t('settings.skills.enabledLabel')}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </>
          )}

          {tab === 'body' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>
                {t('settings.skills.bodyLabel')}
              </label>
              <textarea
                className="modal-textarea modal-textarea--mono"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t('settings.skills.bodyPlaceholder')}
                rows={14}
              />
            </>
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          {isEdit && (
            <button className="btn-danger" onClick={remove} disabled={saving}>
              {t('common.delete')}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
