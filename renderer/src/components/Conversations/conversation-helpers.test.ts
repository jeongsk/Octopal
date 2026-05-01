import { describe, it, expect } from 'vitest'
import { convKey, deriveTitle, sortConversations } from './conversation-helpers'

describe('convKey', () => {
  it('joins folder and conversation id with the canonical "::" separator', () => {
    expect(convKey('/Users/me/proj', 'abc-123')).toBe('/Users/me/proj::abc-123')
  })

  it('preserves arbitrary characters inside folder paths', () => {
    expect(convKey('/path with spaces/한글', 'id-xyz')).toBe(
      '/path with spaces/한글::id-xyz',
    )
  })
})

describe('deriveTitle', () => {
  it('falls back to "New conversation" for empty input', () => {
    expect(deriveTitle('')).toBe('New conversation')
    expect(deriveTitle('   ')).toBe('New conversation')
  })

  it('returns the trimmed message when short enough', () => {
    expect(deriveTitle('Hello')).toBe('Hello')
    expect(deriveTitle('  Hello world  ')).toBe('Hello world')
  })

  it('collapses runs of internal whitespace into single spaces', () => {
    expect(deriveTitle('hello\n\n\tworld')).toBe('hello world')
  })

  it('truncates with ellipsis when longer than 40 chars', () => {
    const long = 'a'.repeat(50)
    const out = deriveTitle(long)
    expect(out).toHaveLength(38) // 37 a's + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  it('keeps exactly 40-char inputs untruncated', () => {
    const exact = 'a'.repeat(40)
    expect(deriveTitle(exact)).toBe(exact)
  })
})

describe('sortConversations', () => {
  it('sorts by updatedAt descending (most recent first)', () => {
    const items = [
      { id: 'a', updatedAt: 100 },
      { id: 'b', updatedAt: 300 },
      { id: 'c', updatedAt: 200 },
    ]
    expect(sortConversations(items).map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('does not mutate the input array', () => {
    const items = [
      { id: 'a', updatedAt: 100 },
      { id: 'b', updatedAt: 300 },
    ]
    const before = items.map((c) => c.id)
    sortConversations(items)
    expect(items.map((c) => c.id)).toEqual(before)
  })

  it('handles empty input', () => {
    expect(sortConversations([])).toEqual([])
  })
})
