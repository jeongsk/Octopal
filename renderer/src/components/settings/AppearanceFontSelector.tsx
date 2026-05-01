import { useTranslation } from 'react-i18next'

type FontKind = 'ui' | 'chat' | 'code'

export interface FontOption {
  value: string
  label: string
  stack: string
}

// Every UI/chat stack ends with `"Tossface"` to keep emoji rendering aligned
// with the :root default in globals.css — without it, picking any non-default
// font silently swaps Tossface emoji for the OS-default emoji font.
export const UI_FONT_OPTIONS: FontOption[] = [
  { value: 'system', label: 'System Default', stack: '' },
  {
    value: 'system-ui',
    label: 'System Sans',
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif, "Tossface"',
  },
  { value: 'outfit', label: 'Outfit', stack: '"Outfit", system-ui, sans-serif, "Tossface"' },
  {
    value: 'pretendard',
    label: 'Pretendard',
    stack: '"Pretendard Variable", system-ui, sans-serif, "Tossface"',
  },
  {
    value: 'helvetica',
    label: 'Helvetica Neue',
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif, "Tossface"',
  },
  { value: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", serif, "Tossface"' },
]

export const CHAT_FONT_OPTIONS: FontOption[] = UI_FONT_OPTIONS

export const CODE_FONT_OPTIONS: FontOption[] = [
  { value: 'system', label: 'System Default', stack: '' },
  {
    value: 'ui-monospace',
    label: 'UI Monospace',
    stack: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  { value: 'menlo', label: 'Menlo', stack: 'Menlo, monospace' },
  { value: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  {
    value: 'jetbrains',
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", ui-monospace, monospace',
  },
  { value: 'fira-code', label: 'Fira Code', stack: '"Fira Code", ui-monospace, monospace' },
]

export function optionsFor(kind: FontKind): FontOption[] {
  if (kind === 'code') return CODE_FONT_OPTIONS
  if (kind === 'chat') return CHAT_FONT_OPTIONS
  return UI_FONT_OPTIONS
}

export function stackFor(kind: FontKind, value: string): string {
  return optionsFor(kind).find((o) => o.value === value)?.stack ?? ''
}

// Per CSSOM § 6.7.2, setProperty(name, '') is equivalent to removeProperty(name)
// — so 'system' (whose stack is '') reverts to the :root default cascade
// rather than overriding it with an empty literal. Replacing '' with e.g.
// 'inherit' would NOT remove the variable; it would set it to the literal
// string 'inherit', silently breaking the Korean Pretendard cascade.
export function applyFontVars(
  root: HTMLElement,
  appearance: { uiFont?: string; chatFont?: string; codeFont?: string } | undefined
): void {
  root.style.setProperty('--font-ui', stackFor('ui', appearance?.uiFont ?? 'system'))
  root.style.setProperty('--font-chat', stackFor('chat', appearance?.chatFont ?? 'system'))
  root.style.setProperty('--font-mono', stackFor('code', appearance?.codeFont ?? 'system'))
}

interface Props {
  kind: FontKind
  value: string
  onChange: (next: string) => void
}

export function AppearanceFontSelector({ kind, value, onChange }: Props) {
  const { t } = useTranslation()
  const options = optionsFor(kind)
  const labelKey =
    kind === 'ui'
      ? 'settings.appearance.interfaceFont'
      : kind === 'chat'
        ? 'settings.appearance.chatFont'
        : 'settings.appearance.codeFont'
  const descKey = `${labelKey}Desc`
  const previewText =
    kind === 'code'
      ? t('settings.appearance.fontPreviewCode')
      : t('settings.appearance.fontPreview')
  const stack = stackFor(kind, value)

  return (
    <div className="settings-field">
      <span className="settings-toggle-info">
        <span className="settings-label">{t(labelKey)}</span>
        <span className="settings-desc">{t(descKey)}</span>
      </span>
      <select
        className="settings-select"
        aria-label={t(labelKey)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value === 'system' ? t('settings.appearance.fontSystemDefault') : o.label}
          </option>
        ))}
      </select>
      <div
        className="font-preview"
        style={stack ? { fontFamily: stack } : undefined}
      >
        {previewText}
      </div>
    </div>
  )
}
