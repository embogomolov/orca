import { useDndContext, useDroppable } from '@dnd-kit/core'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { parseSharedRowId, SHARED_ZONE_ID } from './room-queue-state'

export function SharedQueueZone({
  empty,
  children
}: {
  empty: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const droppable = useDroppable({ id: SHARED_ZONE_ID })
  const { active, over } = useDndContext()
  const dragging = Boolean(active)
  const overId = over ? String(over.id) : null
  const targeted =
    dragging && Boolean(overId === SHARED_ZONE_ID || (overId && parseSharedRowId(overId)))
  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        'relative min-h-0 rounded-md transition-[background-color,box-shadow,min-height] duration-200 motion-reduce:transition-none',
        targeted && 'bg-accent',
        dragging && 'ring-1 ring-inset ring-border',
        dragging && empty && 'flex min-h-16 items-center justify-center px-3 py-4'
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-background px-2 text-xs text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none',
          dragging ? 'opacity-100' : 'opacity-0',
          empty ? 'top-1/2 -translate-y-1/2' : 'top-0 -translate-y-1/2'
        )}
      >
        {translate('rooms.queue.dropShared', 'Drop here to return to the room queue')}
      </span>
      {children}
    </div>
  )
}
