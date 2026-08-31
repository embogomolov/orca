import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RoomParticipant } from '../../../../shared/rooms'
import { RoomAuthorAvatar } from './RoomAuthorAvatar'
import type { QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import { QueuedMessagePresence, useStableQueuedMessageIds } from '../native-chat/QueuedMessageList'
import { squareId, squareOpenId } from './room-queue-state'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

/** Small square = 3x the 36px participant chip. */
export const ROOM_QUEUE_SQUARE_SIZE = 108
const EASE_TRANSFORM = 'cubic-bezier(0.12, 0.9, 0.2, 1)'
const EASE_OPACITY = 'cubic-bezier(0.16, 1, 0.3, 1)'
const NOOP = (): void => {}

export function RoomQueueSquare({
  participant,
  count,
  expanded,
  targeted,
  layoutSignature,
  visible = true,
  exitInFlow = false,
  droppableDisabled,
  onToggle,
  onRegister,
  onExited = NOOP
}: {
  participant: RoomParticipant
  count: number
  expanded: boolean
  targeted: boolean
  layoutSignature: string
  visible?: boolean
  exitInFlow?: boolean
  droppableDisabled: boolean
  onToggle: () => void
  onRegister: (element: HTMLButtonElement | null) => void
  onExited?: () => void
}): React.JSX.Element {
  const droppable = useDroppable({
    id: squareId(participant.id),
    disabled: droppableDisabled || !visible
  })
  const positionRef = useRef<HTMLDivElement>(null)
  const previousPosition = useRef<{ left: number; top: number } | null>(null)
  const exitPosition = useRef({ left: 0, top: 0 })
  const positionAnimation = useRef<Animation | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useLayoutEffect(() => {
    const element = positionRef.current
    if (!element) {
      return
    }
    positionAnimation.current?.cancel()
    const next = { left: element.offsetLeft, top: element.offsetTop }
    const previous = previousPosition.current
    previousPosition.current = next
    if (visible) {
      exitPosition.current = next
    }
    if (reducedMotion || !previous) {
      return
    }
    const x = previous.left - next.left
    const y = previous.top - next.top
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) {
      return
    }
    positionAnimation.current = element.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 200, easing: EASE_TRANSFORM }
    )
  }, [layoutSignature, reducedMotion, visible])
  return (
    <div
      ref={positionRef}
      className="shrink-0"
      style={
        visible || exitInFlow
          ? undefined
          : { position: 'absolute', left: exitPosition.current.left, top: exitPosition.current.top }
      }
    >
      <button
        type="button"
        ref={(element) => {
          droppable.setNodeRef(element)
          onRegister(visible ? element : null)
        }}
        aria-label={translate('rooms.queue.square', 'Queue of {{name}}', {
          name: `${participant.displayName} (@${participant.identity})`
        })}
        aria-expanded={expanded}
        data-room-queue-square
        aria-hidden={!visible}
        tabIndex={visible ? 0 : -1}
        onClick={onToggle}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            !visible &&
            event.propertyName === 'opacity'
          ) {
            onExited()
          }
        }}
        className={cn(
          'relative flex size-[108px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-muted/40 shadow-xs',
          !visible && 'pointer-events-none',
          (targeted || droppable.isOver) && 'bg-accent',
          expanded && 'border-foreground/20 bg-accent'
        )}
        style={{
          opacity: entered && visible ? 1 : 0,
          transform: entered && visible ? 'scale(1)' : 'scale(0.8) translateY(4px)',
          transition: `opacity 200ms ${EASE_OPACITY}, transform 200ms ${EASE_TRANSFORM}, background-color 200ms ease, border-color 200ms ease`
        }}
      >
        <RoomAuthorAvatar actorKind="agent" participant={participant} />
        <span className="max-w-[88px] truncate text-xs font-medium text-foreground">
          @{participant.identity}
        </span>
        <span
          aria-hidden={count === 0}
          className={cn(
            'absolute right-2 top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[10px] tabular-nums text-muted-foreground shadow-xs transition-[opacity,transform] duration-200 motion-reduce:transition-none',
            count > 0 ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
          )}
        >
          {count}
        </span>
      </button>
    </div>
  )
}

export function RoomQueueSquareGrid({
  phase,
  raised,
  children
}: {
  phase: 'visible' | 'exiting' | 'hidden'
  raised: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { measureDroppableContainers } = useDndContext()
  return (
    <div
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows,padding-bottom] duration-200 motion-reduce:transition-none',
        raised && 'relative z-50',
        phase === 'visible' ? 'grid-rows-[1fr] pb-3' : 'grid-rows-[0fr]'
      )}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
          measureDroppableContainers([])
        }
      }}
    >
      {children}
    </div>
  )
}

export function RoomQueueSquareOverlay({
  participant,
  items,
  rows,
  closing,
  suppressExitId,
  onClose,
  refCallback
}: {
  participant: RoomParticipant
  items: QueuedMessageItem[]
  rows: (item: QueuedMessageItem) => React.ReactNode
  closing: boolean
  suppressExitId?: string | null
  onClose: () => void
  refCallback: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  const droppable = useDroppable({ id: squareOpenId(participant.id) })
  const sortableIds = useStableQueuedMessageIds(items)
  const activeId = droppable.active ? String(droppable.active.id) : null
  const receiving =
    droppable.isOver && activeId !== null && !items.some((item) => item.id === activeId)
  return (
    <Dialog open={!closing} modal={false} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={(element) => {
          refCallback(element)
          droppable.setNodeRef(element)
        }}
        aria-describedby={undefined}
        showCloseButton
        overlayClassName="pointer-events-none bg-transparent backdrop-blur-none"
        className={cn(
          'flex max-h-[min(50dvh,24rem)] min-w-0 flex-col gap-2 p-3 sm:max-w-md',
          receiving && 'bg-accent'
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target
          if (target instanceof Element && target.closest('[data-room-queue-square]')) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="flex-row items-center gap-2 pr-8 text-left">
          <RoomAuthorAvatar actorKind="agent" participant={participant} />
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm">@{participant.identity}</DialogTitle>
            {participant.displayName !== participant.identity ? (
              <p className="truncate text-[11px] text-muted-foreground">
                {participant.displayName}
              </p>
            ) : null}
          </div>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{items.length}</span>
        </DialogHeader>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className="queued-message-scroll-fade scrollbar-sleek flex max-h-[min(40dvh,20rem)] min-h-0 w-full flex-col gap-px overflow-x-hidden overflow-y-auto">
            <QueuedMessagePresence
              key={participant.id}
              items={items}
              suppressExitId={suppressExitId}
            >
              {rows}
            </QueuedMessagePresence>
          </div>
        </SortableContext>
      </DialogContent>
    </Dialog>
  )
}
