import { describe, it, expect } from 'vitest'
import {
  CHAT_FONTS,
  CODE_FONTS,
  DEFAULT_FONTS,
  FONT_CATALOG,
  INTERFACE_FONTS,
  getFontStack,
} from './fonts'

describe('fonts catalog', () => {
  it('partitions catalog by role', () => {
    expect(INTERFACE_FONTS.every((f) => f.roles.includes('ui'))).toBe(true)
    expect(CHAT_FONTS.every((f) => f.roles.includes('chat'))).toBe(true)
    expect(CODE_FONTS.every((f) => f.roles.includes('code'))).toBe(true)

    // 'serif' is chat-only — must not appear in INTERFACE_FONTS
    expect(INTERFACE_FONTS.find((f) => f.id === 'serif')).toBeUndefined()
    expect(CHAT_FONTS.find((f) => f.id === 'serif')).toBeDefined()

    // monospace IDs must not leak into UI/chat lists
    for (const id of ['sf-mono', 'menlo', 'consolas', 'jetbrains-mono', 'fira-code', 'courier']) {
      expect(INTERFACE_FONTS.find((f) => f.id === id)).toBeUndefined()
      expect(CHAT_FONTS.find((f) => f.id === id)).toBeUndefined()
      expect(CODE_FONTS.find((f) => f.id === id)).toBeDefined()
    }
  })

  it('default IDs reference real catalog entries', () => {
    expect(FONT_CATALOG.find((f) => f.id === DEFAULT_FONTS.interfaceFont)).toBeDefined()
    expect(FONT_CATALOG.find((f) => f.id === DEFAULT_FONTS.chatFont)).toBeDefined()
    expect(FONT_CATALOG.find((f) => f.id === DEFAULT_FONTS.codeBlockFont)).toBeDefined()
  })

  it('every catalog stack ends with a generic family fallback', () => {
    for (const opt of FONT_CATALOG) {
      expect(opt.stack).toMatch(/(sans-serif|serif|monospace)$/)
    }
  })
})

describe('getFontStack', () => {
  it('appends Tossface for ui and chat roles', () => {
    expect(getFontStack('system', 'ui')).toMatch(/'Tossface'$/)
    expect(getFontStack('system', 'chat')).toMatch(/'Tossface'$/)
  })

  it('does not append Tossface for code role', () => {
    expect(getFontStack('sf-mono', 'code')).not.toMatch(/Tossface/)
  })

  it('falls back to role default for unknown id', () => {
    const ui = getFontStack('definitely-not-a-real-font', 'ui')
    const code = getFontStack('definitely-not-a-real-font', 'code')
    expect(ui).toContain('sans-serif')
    expect(code).toContain('monospace')
  })

  it('falls back to role default when id exists but role mismatches', () => {
    // 'sf-mono' is a code font; asking for it as 'ui' must NOT return the
    // monospace stack — would render code-y text in the UI.
    const ui = getFontStack('sf-mono', 'ui')
    expect(ui).not.toContain('SF Mono')
    expect(ui).toContain('sans-serif')

    // Reverse direction: a UI/chat font must NOT leak into the code role.
    const code = getFontStack('outfit', 'code')
    expect(code).not.toContain('Outfit')
    expect(code).toContain('monospace')
  })

  it('returns role default when id is empty or undefined', () => {
    // Settings.json crosses an IPC boundary; corrupted/missing values can
    // arrive as '' or undefined. Array.find safely misses → role default.
    expect(getFontStack('', 'ui')).toContain('sans-serif')
    expect(getFontStack('', 'chat')).toContain('sans-serif')
    expect(getFontStack('', 'code')).toContain('monospace')
    expect(getFontStack(undefined as unknown as string, 'ui')).toContain('sans-serif')
    expect(getFontStack(undefined as unknown as string, 'chat')).toContain('sans-serif')
    expect(getFontStack(undefined as unknown as string, 'code')).toContain('monospace')
  })

  it('resolves known ids to their declared stack', () => {
    expect(getFontStack('outfit', 'ui')).toContain(`'Outfit'`)
    expect(getFontStack('pretendard', 'chat')).toContain(`'Pretendard Variable'`)
    expect(getFontStack('jetbrains-mono', 'code')).toContain(`'JetBrains Mono'`)
  })
})
