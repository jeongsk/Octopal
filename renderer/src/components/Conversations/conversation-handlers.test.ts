import { describe, it, expect } from 'vitest'
import type { Conversation, Message } from '../../types'
import {
  applyNewConversation,
  applySwitchConversationLoaded,
  applyRenameConversation,
  applyDeleteConversation,
  type ConversationState,
} from './conversation-handlers'

const emptyState: ConversationState = {
  conversations: {},
  activeConversationId: {},
  messages: {},
  hasMoreMessages: {},
}

const conv = (id: string, updatedAt: number, title = id): Conversation => ({
  id,
  title,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 0,
})

describe('applyNewConversation', () => {
  it('seeds an empty messages slot keyed by folder::convId', () => {
    const next = applyNewConversation(emptyState, '/p', conv('new-1', 1))
    expect(next.messages['/p::new-1']).toEqual([])
    expect(next.hasMoreMessages['/p::new-1']).toBe(false)
    expect(next.activeConversationId['/p']).toBe('new-1')
  })

  it('puts the new conversation at the top of the folder list', () => {
    const start: ConversationState = {
      ...emptyState,
      conversations: { '/p': [conv('old', 1)] },
    }
    const next = applyNewConversation(start, '/p', conv('fresh', 2))
    expect(next.conversations['/p'].map((c) => c.id)).toEqual(['fresh', 'old'])
  })
})

describe('applySwitchConversationLoaded', () => {
  it('writes loaded history into the conversation slot only', () => {
    const start: ConversationState = {
      ...emptyState,
      messages: { '/p::a': [{ id: 'kept' } as Message] },
    }
    const history = [{ id: 'm1' } as Message, { id: 'm2' } as Message]
    const next = applySwitchConversationLoaded(start, '/p', 'b', history, true)
    expect(next.messages['/p::b']).toEqual(history)
    expect(next.messages['/p::a']).toEqual([{ id: 'kept' }])
    expect(next.hasMoreMessages['/p::b']).toBe(true)
    expect(next.activeConversationId['/p']).toBe('b')
  })
})

describe('applyRenameConversation', () => {
  it('replaces the renamed conversation in place', () => {
    const start: ConversationState = {
      ...emptyState,
      conversations: { '/p': [conv('a', 100, 'Old'), conv('b', 50, 'B')] },
    }
    const renamed = { ...conv('a', 200), title: 'New' }
    const next = applyRenameConversation(start, '/p', renamed)
    const a = next.conversations['/p'].find((c) => c.id === 'a')!
    expect(a.title).toBe('New')
    // Sort by updatedAt desc places the renamed one first.
    expect(next.conversations['/p'][0].id).toBe('a')
  })

  it('does not touch other folders', () => {
    const start: ConversationState = {
      ...emptyState,
      conversations: {
        '/p': [conv('a', 100, 'A')],
        '/q': [conv('a', 100, 'A in Q')],
      },
    }
    const next = applyRenameConversation(start, '/p', { ...conv('a', 200), title: 'Renamed' })
    expect(next.conversations['/q'][0].title).toBe('A in Q')
  })
})

describe('applyDeleteConversation', () => {
  it("removes only the deleted conversation's message slot", () => {
    const start: ConversationState = {
      ...emptyState,
      messages: {
        '/p::a': [{ id: 'm1' } as Message],
        '/p::b': [{ id: 'm2' } as Message],
      },
      hasMoreMessages: { '/p::a': true, '/p::b': false },
      conversations: { '/p': [conv('a', 1), conv('b', 2)] },
    }
    const next = applyDeleteConversation(start, '/p', 'a')
    expect(next.messages['/p::a']).toBeUndefined()
    expect(next.messages['/p::b']).toEqual([{ id: 'm2' }])
    expect(next.hasMoreMessages['/p::a']).toBeUndefined()
    expect(next.conversations['/p'].map((c) => c.id)).toEqual(['b'])
  })

  it('does not affect other folders’ message slots that share an id', () => {
    const start: ConversationState = {
      ...emptyState,
      messages: {
        '/p::shared': [{ id: 'p-msg' } as Message],
        '/q::shared': [{ id: 'q-msg' } as Message],
      },
      conversations: {
        '/p': [conv('shared', 1)],
        '/q': [conv('shared', 1)],
      },
    }
    const next = applyDeleteConversation(start, '/p', 'shared')
    expect(next.messages['/p::shared']).toBeUndefined()
    expect(next.messages['/q::shared']).toEqual([{ id: 'q-msg' }])
    expect(next.conversations['/q'].map((c) => c.id)).toEqual(['shared'])
  })
})
