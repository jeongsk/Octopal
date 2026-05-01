// Pure-state reducers for the conversation lifecycle handlers in App.tsx.
//
// Extracted so the re-keying contract — `messages`, `hasMoreMessages`,
// `agentLocksRef`, and `activeRunsRef` are all keyed by `${folder}::${conv}`
// (or the triple-form for locks) — can be unit-tested without spinning up
// React/IPC. The IPC orchestration (await + try/catch + showToast) stays
// in App.tsx; only the state transitions live here.
import type { Conversation, Message } from '../../types'
import { convKey, sortConversations } from './conversation-helpers'

export interface ConversationState {
  conversations: Record<string, Conversation[]>
  activeConversationId: Record<string, string>
  messages: Record<string, Message[]>
  hasMoreMessages: Record<string, boolean>
}

export function applyNewConversation(
  state: ConversationState,
  folderPath: string,
  conv: Conversation,
): ConversationState {
  const key = convKey(folderPath, conv.id)
  return {
    conversations: {
      ...state.conversations,
      [folderPath]: sortConversations([conv, ...(state.conversations[folderPath] || [])]),
    },
    activeConversationId: { ...state.activeConversationId, [folderPath]: conv.id },
    messages: { ...state.messages, [key]: [] },
    hasMoreMessages: { ...state.hasMoreMessages, [key]: false },
  }
}

export function applySwitchConversationLoaded(
  state: ConversationState,
  folderPath: string,
  conversationId: string,
  history: Message[],
  hasMore: boolean,
): ConversationState {
  const key = convKey(folderPath, conversationId)
  return {
    ...state,
    activeConversationId: { ...state.activeConversationId, [folderPath]: conversationId },
    messages: { ...state.messages, [key]: history },
    hasMoreMessages: { ...state.hasMoreMessages, [key]: hasMore },
  }
}

export function applyRenameConversation(
  state: ConversationState,
  folderPath: string,
  updated: Conversation,
): ConversationState {
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [folderPath]: sortConversations(
        (state.conversations[folderPath] || []).map((c) => (c.id === updated.id ? updated : c)),
      ),
    },
  }
}

export function applyDeleteConversation(
  state: ConversationState,
  folderPath: string,
  conversationId: string,
): ConversationState {
  const key = convKey(folderPath, conversationId)
  const nextMessages = { ...state.messages }
  delete nextMessages[key]
  const nextHasMore = { ...state.hasMoreMessages }
  delete nextHasMore[key]
  const nextConvs = (state.conversations[folderPath] || []).filter((c) => c.id !== conversationId)
  return {
    ...state,
    messages: nextMessages,
    hasMoreMessages: nextHasMore,
    conversations: { ...state.conversations, [folderPath]: nextConvs },
  }
}
