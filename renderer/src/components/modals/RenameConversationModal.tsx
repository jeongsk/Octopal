import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface RenameConversationModalProps {
  currentTitle: string
  onClose: () => void
  onRenamed: (title: string) => void
}

export function RenameConversationModal({
  currentTitle,
  onClose,
  onRenamed,
}: RenameConversationModalProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(currentTitle)

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && trimmed !== currentTitle.trim()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('modals.renameConversation.title')}</div>
        <label className="modal-label">{t('modals.renameConversation.nameLabel')}</label>
        <input
          className="modal-input"
          placeholder={t('modals.renameConversation.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) onRenamed(trimmed)
          }}
          autoFocus
        />
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!canSave}
            onClick={() => onRenamed(trimmed)}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
