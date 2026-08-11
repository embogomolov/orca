import { describe, expect, it } from 'vitest'
import { isLiteralRoomTransportText } from './native-chat-room-transport'

describe('isLiteralRoomTransportText', () => {
  it('recognizes Rooms deliveries and exact silent acknowledgements', () => {
    expect(isLiteralRoomTransportText('<orca-room-delivery id="delivery-1">\nhello')).toBe(true)
    expect(isLiteralRoomTransportText('<orca-room-silent />')).toBe(true)
    expect(isLiteralRoomTransportText('Done.\n<orca-room-silent />')).toBe(false)
  })
})
