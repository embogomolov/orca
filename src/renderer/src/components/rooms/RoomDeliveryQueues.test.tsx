// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { SHARED_ZONE_ID, sharedRowId, squareId, squareOpenId } from './room-queue-state'
import {
  clearRoomQueueLongPress,
  roomQueueCollision,
  roomQueueDropTarget,
  roomQueueLongPressTarget,
  roomQueuePointerForDrag,
  roomQueueSquareAtPointer,
  roomQueueSquareDropDisabled,
  trackRoomQueuePointer,
  updateRoomQueueLongPress,
  type RoomQueueLongPressState,
  type RoomQueuePointer
} from './room-queue-drag-targeting'

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
})

const collisionArgs = (pointerCoordinates: { x: number; y: number } | null) => {
  const row = rect(0, 0, 100, 40)
  const square = rect(200, 0, 100, 100)
  const containers = [
    { id: 'row', rect: { current: row } },
    { id: SHARED_ZONE_ID, rect: { current: rect(100, 0, 100, 100) } },
    { id: squareId('agent'), rect: { current: square } }
  ].map((container) => ({
    ...container,
    key: container.id,
    data: { current: undefined },
    disabled: false,
    node: { current: null }
  }))
  return {
    active: { id: 'active', data: { current: undefined }, rect: { current: {} } },
    collisionRect: rect(215, 15, 20, 20),
    droppableRects: new Map(containers.map((container) => [container.id, container.rect.current])),
    droppableContainers: containers,
    pointerCoordinates
  } as Parameters<typeof roomQueueCollision>[0]
}

describe('room queue collision detection', () => {
  it('keeps pointer targets bounded and resolves keyboard targets by collision rect', () => {
    expect(roomQueueCollision(collisionArgs(null))[0]?.id).toBe(squareId('agent'))
    expect(roomQueueCollision(collisionArgs({ x: 10, y: 10 }))[0]?.id).toBe('row')
    expect(roomQueueCollision(collisionArgs({ x: 190, y: 50 }))[0]?.id).toBe(SHARED_ZONE_ID)
    const shared = collisionArgs({ x: 190, y: 50 })
    shared.active.id = sharedRowId('message')
    expect(roomQueueCollision(shared)[0]?.id).toBe(SHARED_ZONE_ID)
    expect(roomQueueCollision(collisionArgs({ x: 500, y: 500 }))).toEqual([])
  })

  it('uses exact visible bounds when an expanded queue overlaps a square', () => {
    const args = collisionArgs({ x: 180, y: 20 })
    const open = {
      id: squareOpenId('source'),
      key: squareOpenId('source'),
      data: { current: undefined },
      disabled: false,
      node: { current: null },
      rect: { current: rect(160, 0, 40, 40) }
    }
    args.droppableContainers = [open, ...args.droppableContainers]
    args.droppableRects = new Map([[open.id, open.rect.current], ...args.droppableRects.entries()])

    expect(roomQueueCollision(args)[0]?.id).toBe(squareOpenId('source'))
    args.active.id = sharedRowId('message')
    expect(roomQueueCollision(args)[0]?.id).toBe(squareOpenId('source'))
  })

  it('enables only other collapsed targets during directed drag', () => {
    expect(roomQueueSquareDropDisabled('source', 'source')).toBe(true)
    expect(roomQueueSquareDropDisabled('target', 'source')).toBe(false)
    expect(roomQueueSquareDropDisabled('target', null)).toBe(false)
  })

  it('uses the final captured pointer only for the current pointer drag', () => {
    let point: RoomQueuePointer | null = null
    const stop = trackRoomQueuePointer((next) => (point = next))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 120 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, clientY: 125 }))

    const pointerDrag = {
      activatorEvent: new PointerEvent('pointerdown', { clientX: 20, clientY: 100 }),
      delta: { x: 0, y: 70 }
    }
    expect(roomQueuePointerForDrag(pointerDrag, point)).toEqual({ x: 20, y: 125 })
    pointerDrag.delta.y = 20
    expect(roomQueuePointerForDrag(pointerDrag, point)).toEqual({ x: 20, y: 125 })
    expect(
      roomQueuePointerForDrag({ activatorEvent: new KeyboardEvent('keydown', { key: ' ' }) }, point)
    ).toBeNull()
    stop()
  })

  it('starts, preserves, cancels, and retargets long-press from real square bounds', () => {
    vi.useFakeTimers()
    const square = document.createElement('button')
    square.getBoundingClientRect = () => rect(200, 0, 100, 100) as DOMRect
    const squares = new Map([['agent', square]])
    expect(roomQueueSquareAtPointer({ x: 190, y: 50 }, squares)).toBeNull()
    expect(roomQueueSquareAtPointer({ x: 200, y: 50 }, squares)).toBe('agent')
    expect(
      roomQueueDropTarget(
        { activatorEvent: new PointerEvent('pointerdown'), over: { id: 'row' } },
        { x: 200, y: 50 },
        squares,
        null,
        null,
        null
      )
    ).toBe(squareId('agent'))
    const shared = document.createElement('div')
    shared.getBoundingClientRect = () => rect(0, 0, 400, 200) as DOMRect
    expect(
      roomQueueDropTarget(
        { activatorEvent: new PointerEvent('pointerdown'), over: null },
        { x: 100, y: 100 },
        squares,
        null,
        null,
        shared
      )
    ).toBe(SHARED_ZONE_ID)
    const target = {
      activatorEvent: new PointerEvent('pointerdown'),
      point: { x: 200, y: 50 },
      squares
    }
    expect(roomQueueLongPressTarget(target)).toBe('agent')
    expect(
      roomQueueLongPressTarget({
        ...target,
        activatorEvent: new KeyboardEvent('keydown', { key: ' ' })
      })
    ).toBeNull()

    const state: RoomQueueLongPressState = { targetId: null, timer: null }
    const opened = vi.fn((id: string) => {
      clearRoomQueueLongPress(state)
      return id
    })
    updateRoomQueueLongPress(state, 'agent-a', opened)
    vi.advanceTimersByTime(300)
    updateRoomQueueLongPress(state, 'agent-a', opened)
    vi.advanceTimersByTime(300)
    expect(opened).toHaveBeenCalledWith('agent-a')

    updateRoomQueueLongPress(state, 'agent-a', opened)
    vi.advanceTimersByTime(300)
    updateRoomQueueLongPress(state, null, opened)
    vi.advanceTimersByTime(300)
    expect(opened).toHaveBeenCalledTimes(1)

    updateRoomQueueLongPress(state, 'agent-a', opened)
    vi.advanceTimersByTime(300)
    updateRoomQueueLongPress(state, 'agent-b', opened)
    vi.advanceTimersByTime(600)
    expect(opened).toHaveBeenCalledTimes(2)
    expect(opened).toHaveBeenLastCalledWith('agent-b')
    vi.useRealTimers()
  })
})
