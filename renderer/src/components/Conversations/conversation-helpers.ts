export const convKey = (folder: string, conversationId: string) =>
  `${folder}::${conversationId}`

export function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return 'New conversation'
  return trimmed.length <= 40 ? trimmed : trimmed.slice(0, 37) + '…'
}

export function sortConversations<T extends { updatedAt: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}
