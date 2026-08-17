import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core'
import { getEventCoordinates } from '@dnd-kit/utilities'
import {
  parseCollapsedSquareId,
  SHARED_ZONE_ID,
  squareId,
  squareOpenId
} from './room-queue-projection'

const LONG_PRESS_MS = 600

export type RoomQueuePointer = { x: number; y: number }
export type RoomQueueLongPressState = {
  targetId: string | null
  timer: ReturnType<typeof setTimeout> | null
}

export function pointInRect(point: RoomQueuePointer, rect: DOMRect): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

export function roomQueueSquareAtPointer(
  point: RoomQueuePointer,
  squares: ReadonlyMap<string, HTMLButtonElement>
): string | null {
  for (const [participantId, square] of squares) {
    if (pointInRect(point, square.getBoundingClientRect())) {
      return participantId
    }
  }
  return null
}

export function roomQueueLongPressTarget(input: {
  activatorEvent: Event
  point: RoomQueuePointer | null
  squares: ReadonlyMap<string, HTMLButtonElement>
}): string | null {
  const point = roomQueuePointerForDrag(input, input.point)
  return point ? roomQueueSquareAtPointer(point, input.squares) : null
}

export function clearRoomQueueLongPress(state: RoomQueueLongPressState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer)
  }
  state.targetId = null
  state.timer = null
}

export function updateRoomQueueLongPress(
  state: RoomQueueLongPressState,
  targetId: string | null,
  open: (participantId: string) => void
): void {
  if (state.targetId === targetId) {
    return
  }
  clearRoomQueueLongPress(state)
  if (targetId) {
    state.targetId = targetId
    state.timer = setTimeout(() => open(targetId), LONG_PRESS_MS)
  }
}

export function trackRoomQueuePointer(update: (point: RoomQueuePointer) => void): () => void {
  const capture = (event: PointerEvent): void => update({ x: event.clientX, y: event.clientY })
  window.addEventListener('pointermove', capture, true)
  window.addEventListener('pointerup', capture, true)
  return () => {
    window.removeEventListener('pointermove', capture, true)
    window.removeEventListener('pointerup', capture, true)
  }
}

export function roomQueuePointerForDrag(
  event: { activatorEvent: Event },
  point: RoomQueuePointer | null
): RoomQueuePointer | null {
  return getEventCoordinates(event.activatorEvent) ? point : null
}

export function roomQueueDropTarget(
  event: { activatorEvent: Event; over: { id: string | number } | null },
  lastPointer: RoomQueuePointer | null,
  squares: ReadonlyMap<string, HTMLButtonElement>,
  expandedId: string | null,
  expandedElement: HTMLDivElement | null,
  sharedElement: HTMLDivElement | null
): string | null {
  const point = roomQueuePointerForDrag(event, lastPointer)
  if (
    expandedId &&
    point &&
    expandedElement &&
    pointInRect(point, expandedElement.getBoundingClientRect())
  ) {
    return squareOpenId(expandedId)
  }
  const collapsed = point && roomQueueSquareAtPointer(point, squares)
  if (collapsed) {
    return squareId(collapsed)
  }
  if (point && sharedElement && pointInRect(point, sharedElement.getBoundingClientRect())) {
    return SHARED_ZONE_ID
  }
  return event.over ? String(event.over.id) : null
}

export function roomQueueSquareDropDisabled(
  participantId: string,
  expandedId: string | null
): boolean {
  return expandedId === participantId
}

export const roomQueueCollision: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) {
    return closestCenter(args)
  }
  const exact = pointerWithin(args)
  const exactSquares = exact.filter((collision) => parseCollapsedSquareId(String(collision.id)))
  if (exactSquares.length > 0) {
    return exactSquares
  }
  return exact
}
