import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { cn } from '@/lib/utils'
import type { RoomData } from './use-room-data'
import { QueuedMessageCard, type QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import {
  QueuedMessageList,
  useQueuedMessageContainerPresence
} from '../native-chat/QueuedMessageList'
import { RoomDirectedQueueRow, RoomSharedQueueRow } from './RoomQueueRows'
import { RoomQueueSquare, RoomQueueSquareGrid, RoomQueueSquareOverlay } from './RoomQueueSquare'
import { showRoomActionError } from './room-action-error'
import { SharedQueueZone } from './RoomQueueDropZone'
import type { RoomQueueComposerEdit } from './room-queue-composer-edit'
import { executeRoomQueueAction, useRoomQueueEditRequest } from './room-queue-action-executor'
import { roomDirectedQueueItems, roomSharedQueueItems } from './room-queue-items'
import { useRoomQueueSquarePresence } from './use-room-queue-square-presence'
import {
  computeRoomQueueState,
  isMessageMutable,
  parseSharedRowId,
  resolveRoomQueueDrop,
  SHARED_ZONE_ID
} from './room-queue-state'
import {
  clearRoomQueueLongPress,
  roomQueueCollision,
  roomQueueDropTarget,
  roomQueueLongPressTarget,
  roomQueuePointerForDrag,
  roomQueueSquareDropDisabled,
  pointInRect,
  trackRoomQueuePointer,
  updateRoomQueueLongPress,
  type RoomQueueLongPressState,
  type RoomQueuePointer
} from './room-queue-drag-targeting'

const EXPANDED_ANIMATION_MS = 200
const NOOP_EDIT = (): void => {}

export function RoomDeliveryQueues({
  data,
  editing = null,
  onEdit = NOOP_EDIT
}: {
  data: RoomData
  editing?: RoomQueueComposerEdit | null
  onEdit?: (edit: RoomQueueComposerEdit) => void
}): React.JSX.Element | null {
  const state = useMemo(() => computeRoomQueueState(data), [data])
  const [dragging, setDragging] = useState(false)
  const [activeDragItem, setActiveDragItem] = useState<QueuedMessageItem | null>(null)
  const [hoveredSquareId, setHoveredSquareId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [keptSquareId, setKeptSquareId] = useState<string | null>(null)
  const longPress = useRef<RoomQueueLongPressState>({ targetId: null, timer: null })
  const dragBrowseActive = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPointer = useRef<RoomQueuePointer | null>(null)
  const squareElements = useRef(new Map<string, HTMLButtonElement>())
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const queueAreaRef = useRef<HTMLDivElement | null>(null)
  const editRequest = useRoomQueueEditRequest(data, onEdit, showRoomActionError)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const clearLongPress = (): void => {
    clearRoomQueueLongPress(longPress.current)
  }
  useEffect(
    () => () => {
      clearLongPress()
      if (closeTimer.current) {
        clearTimeout(closeTimer.current)
      }
    },
    []
  )
  const closeSquare = useCallback((): void => {
    if (expandedId) {
      setExpandedId(null)
      setClosingId(expandedId)
      closeTimer.current = setTimeout(() => setClosingId(null), EXPANDED_ANIMATION_MS)
    }
  }, [expandedId])
  const directedRows = useCallback(
    (participantId: string) =>
      (state?.directed.get(participantId) ?? []).filter(
        (delivery) => delivery.messageId !== editing?.message.id
      ),
    [editing?.message.id, state]
  )
  useEffect(() => trackRoomQueuePointer((point) => (lastPointer.current = point)), [])
  useEffect(() => {
    if (!dragging && expandedId && state && directedRows(expandedId).length === 0) {
      closeSquare()
    }
  }, [closeSquare, directedRows, dragging, expandedId, state])
  const squarePresence = useRoomQueueSquarePresence({
    state,
    dragging,
    keptSquareId,
    directedRows
  })
  const hasContent = Boolean(
    state &&
    (dragging ||
      state.shared.length > 0 ||
      state.hasDirected ||
      squarePresence.squares.length > 0 ||
      data.snapshot?.workState === 'stopped')
  )
  const containerPresence = useQueuedMessageContainerPresence(hasContent)
  if (!state || !containerPresence.mounted) {
    return null
  }
  const { participants, squares } = squarePresence

  const supportsEdit = data.snapshot?.queueComposerEditVersion === 1

  const openSquare = (participantId: string): void => {
    if (expandedId === participantId) {
      return
    }
    clearLongPress()
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
    }
    setClosingId(null)
    setExpandedId(participantId)
  }

  const onDragStart = ({ active }: DragStartEvent): void => {
    clearLongPress()
    dragBrowseActive.current = expandedId !== null
    setHoveredSquareId(null)
    const id = String(active.id)
    const messageId = parseSharedRowId(id) ?? data.deliveries[id]?.messageId
    const message = messageId ? data.messages.find((item) => item.id === messageId) : undefined
    if (!message || message.actorKind !== 'user' || !isMessageMutable(data, message.id)) {
      return
    }
    const visualItem = active.data.current?.item as QueuedMessageItem | undefined
    setActiveDragItem({
      ...visualItem,
      id,
      text: message.body,
      dragDisabled: true,
      canEdit: false,
      canRemove: false
    })
    setDragging(true)
  }
  const updateDragHover = (event: DragMoveEvent | DragOverEvent): void => {
    const targetId = roomQueueLongPressTarget({
      activatorEvent: event.activatorEvent,
      point: lastPointer.current,
      squares: squareElements.current
    })
    setHoveredSquareId(targetId)
    if (targetId) {
      if (dragBrowseActive.current) {
        clearLongPress()
        openSquare(targetId)
      } else {
        updateRoomQueueLongPress(longPress.current, targetId, (participantId) => {
          dragBrowseActive.current = true
          openSquare(participantId)
        })
      }
      return
    }
    clearLongPress()
    const point = roomQueuePointerForDrag(event, lastPointer.current)
    if (
      point &&
      overlayRef.current &&
      pointInRect(point, overlayRef.current.getBoundingClientRect())
    ) {
      return
    }
    if (
      point &&
      queueAreaRef.current &&
      pointInRect(point, queueAreaRef.current.getBoundingClientRect())
    ) {
      closeSquare()
      return
    }
    const overId = event.over ? String(event.over.id) : null
    if (overId === SHARED_ZONE_ID || (overId && parseSharedRowId(overId) !== null)) {
      closeSquare()
    }
  }
  const onDragEnd = (event: DragEndEvent): void => {
    clearLongPress()
    dragBrowseActive.current = false
    setHoveredSquareId(null)
    setDragging(false)
    setActiveDragItem(null)
    const overId = roomQueueDropTarget(
      event,
      lastPointer.current,
      squareElements.current,
      expandedId,
      overlayRef.current,
      queueAreaRef.current
    )
    const actions = resolveRoomQueueDrop(data, state, String(event.active.id), overId)
    closeSquare()
    const placed = actions.find((action) => action.type === 'directAndPlace')
    if (placed?.type === 'directAndPlace') {
      setKeptSquareId(placed.participantId)
    }
    const execution = Promise.all(
      actions.map((action) => executeRoomQueueAction(data, action, showRoomActionError))
    )
    if (placed?.type === 'directAndPlace') {
      void execution.finally(() =>
        setKeptSquareId((current) => (current === placed.participantId ? null : current))
      )
    }
  }

  const sharedItems = roomSharedQueueItems(data, state, editing?.message.id)
  const renderSharedRow = (item: QueuedMessageItem): React.ReactNode => (
    <RoomSharedQueueRow
      data={data}
      item={item}
      report={showRoomActionError}
      inlineEdit={!supportsEdit}
      onEditInComposer={
        supportsEdit && !editing && !editRequest.pending
          ? () => {
              const message = data.messages.find(
                (candidate) => candidate.id === parseSharedRowId(item.id)
              )
              if (message) {
                editRequest.begin(message)
              }
            }
          : undefined
      }
    />
  )

  const expandedParticipant =
    participants.find((participant) => participant.id === (expandedId ?? closingId)) ?? null
  const expandedItems = roomDirectedQueueItems(
    data,
    expandedParticipant,
    expandedParticipant ? directedRows(expandedParticipant.id) : []
  )
  const renderExpandedRow = (item: QueuedMessageItem): React.ReactNode => (
    <RoomDirectedQueueRow
      data={data}
      item={item}
      participantId={expandedParticipant?.id ?? ''}
      report={showRoomActionError}
      inlineEdit={!supportsEdit}
      onEditInComposer={
        supportsEdit && !editing && !editRequest.pending
          ? () => {
              const delivery = data.deliveries[item.id]
              const message = delivery
                ? data.messages.find((candidate) => candidate.id === delivery.messageId)
                : null
              if (message) {
                editRequest.begin(message)
              }
            }
          : undefined
      }
    />
  )
  const draggingDirected = activeDragItem !== null && parseSharedRowId(activeDragItem.id) === null
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={roomQueueCollision}
      onDragStart={onDragStart}
      onDragMove={updateDragHover}
      onDragOver={updateDragHover}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        clearLongPress()
        dragBrowseActive.current = false
        setHoveredSquareId(null)
        setDragging(false)
        setActiveDragItem(null)
        closeSquare()
      }}
    >
      <div
        className={cn(
          'grid shrink-0 transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
          containerPresence.visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 overflow-hidden px-4 pt-2">
          <div ref={queueAreaRef} className="relative mx-auto w-full max-w-4xl">
            <RoomQueueSquareGrid
              visible={squarePresence.desiredIds.size > 0}
              raised={draggingDirected}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {squares.map((participant) => (
                    <RoomQueueSquare
                      key={participant.id}
                      participant={participant}
                      count={directedRows(participant.id).length}
                      expanded={expandedId === participant.id}
                      targeted={hoveredSquareId === participant.id}
                      visible={squarePresence.desiredIds.has(participant.id)}
                      droppableDisabled={roomQueueSquareDropDisabled(participant.id, expandedId)}
                      onToggle={() =>
                        expandedId === participant.id ? closeSquare() : openSquare(participant.id)
                      }
                      onRegister={(element) => {
                        if (element && squarePresence.desiredIds.has(participant.id)) {
                          squareElements.current.set(participant.id, element)
                        } else {
                          squareElements.current.delete(participant.id)
                        }
                      }}
                      onExited={() => {
                        squarePresence.removeExited(participant.id)
                      }}
                    />
                  ))}
                </div>
              </div>
            </RoomQueueSquareGrid>
            <SharedQueueZone empty={sharedItems.length === 0}>
              <QueuedMessageList
                items={sharedItems}
                interrupted={data.snapshot?.workState === 'stopped'}
                onResume={() =>
                  void roomRpc(data.target, 'rooms.work.resume', { roomId: data.roomId }).catch(
                    showRoomActionError
                  )
                }
                renderItem={renderSharedRow}
              />
            </SharedQueueZone>
            {expandedParticipant ? (
              <RoomQueueSquareOverlay
                participant={expandedParticipant}
                items={expandedItems}
                rows={renderExpandedRow}
                closing={expandedId !== expandedParticipant.id}
                onClose={closeSquare}
                refCallback={(element) => {
                  overlayRef.current = element
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDragItem ? (
          <div className="pointer-events-none opacity-70 shadow-lg">
            <QueuedMessageCard item={activeDragItem} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
