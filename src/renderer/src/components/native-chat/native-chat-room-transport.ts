export function isLiteralRoomTransportText(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('<orca-room-delivery') || trimmed.trim() === '<orca-room-silent />'
}
