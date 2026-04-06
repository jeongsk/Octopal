export const AGENT_COLORS = [
  '#D44058',  // Crimson     (signature — brand accent)
  '#E8A8B4',  // Rose Gold   (soft warm secondary)
  '#4AADAB',  // Ocean Teal  (cool complement)
  '#C49080',  // Amber Clay  (warm earth tone)
  '#6B8FC2',  // Slate Blue  (cool accent)
  '#D4836B',  // Coral       (warm sibling)
  '#8EA07D',  // Sage Green  (earthy cool)
]

export function colorForName(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]
}

export function basename(p: string) {
  return p.split('/').filter(Boolean).pop() || p
}
