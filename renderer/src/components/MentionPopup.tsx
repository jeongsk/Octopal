import { AgentAvatar } from './AgentAvatar'

interface MentionPopupProps {
  filteredMentions: string[]
  pickMention: (name: string) => void
  octos: OctoFile[]
}

export function MentionPopup({ filteredMentions, pickMention, octos }: MentionPopupProps) {
  return (
    <div className="mention-popup">
      {filteredMentions.map((name) => {
        const octo =octos.find(r => r.name === name)
        return (
          <button
            key={name}
            className="mention-item"
            onClick={() => pickMention(name)}
          >
            {name === 'all' ? (
              <div className="avatar sm" style={{ background: '#666' }}>A</div>
            ) : (
              <AgentAvatar name={name} icon={octo?.icon} size="sm" />
            )}
            <span>{name}</span>
          </button>
        )
      })}
    </div>
  )
}
