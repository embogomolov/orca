import { useEffect, useRef, useState } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { SortableQueuedMessageCard, type QueuedMessageItem } from './QueuedMessageCard'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { cn } from '@/lib/utils'

const QUEUE_ANIMATION_MS = 200

/**
 * Shared queue list used by 1:1 conversations and rooms: identical rows,
 * buttons, container and scroll treatment. The host owns the DndContext.
 */
export function QueuedMessageList({
  items,
  disabled,
  interrupted,
  renderItem,
  onEdit,
  onEditInComposer,
  onRemove,
  onSteer,
  onRetry,
  onResume,
  imageLoadContext
}: {
  items: readonly QueuedMessageItem[]
  disabled?: boolean
  interrupted?: boolean
  renderItem?: (item: QueuedMessageItem) => React.ReactNode
  onEdit?: (id: string, text: string) => void
  onEditInComposer?: (item: QueuedMessageItem) => void
  onRemove?: (id: string) => void
  onSteer?: (id: string) => void
  onRetry?: (id: string) => void
  onResume?: () => void
  imageLoadContext?: NativeChatImageLoadContext
}): React.JSX.Element | null {
  const presence = useQueuedMessageContainerPresence(
    items.length > 0 || Boolean(interrupted && onResume)
  )
  if (!presence.mounted) {
    return null
  }
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
        presence.visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <SortableContext
          items={items.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="queued-message-scroll-fade scrollbar-sleek flex max-h-[30dvh] flex-col gap-px overflow-x-hidden overflow-y-auto px-3 py-1">
            {onResume ? (
              <div
                aria-hidden={!interrupted}
                className={cn(
                  'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
                  interrupted ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 py-0.5 text-sm text-muted-foreground">
                    <span className="truncate">
                      {translate(
                        'components.native-chat.queue.interrupted',
                        'Queue paused because you interrupted'
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={!interrupted}
                      onClick={onResume}
                    >
                      {translate('components.native-chat.queue.resume', 'Resume')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            <QueuedMessagePresence items={items}>
              {(item) =>
                renderItem ? (
                  <>{renderItem(item)}</>
                ) : (
                  <SortableQueuedMessageCard
                    item={item}
                    disabled={disabled}
                    dragDisabled={item.dragDisabled}
                    canSteer={item.canSteer}
                    onEdit={onEdit ? (text) => onEdit(item.id, text) : undefined}
                    onEditInComposer={onEditInComposer ? () => onEditInComposer(item) : undefined}
                    onRemove={onRemove ? () => onRemove(item.id) : undefined}
                    onSteer={onSteer ? () => onSteer(item.id) : undefined}
                    onRetry={onRetry ? () => onRetry(item.id) : undefined}
                    imageLoadContext={imageLoadContext}
                  />
                )
              }
            </QueuedMessagePresence>
          </div>
        </SortableContext>
      </div>
    </div>
  )
}

export function useQueuedMessageContainerPresence(visible: boolean): {
  mounted: boolean
  visible: boolean
} {
  const reducedMotion = usePrefersReducedMotion()
  const [mounted, setMounted] = useState(visible)
  const [shown, setShown] = useState(visible)
  useEffect(() => {
    if (visible) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    if (reducedMotion) {
      setMounted(false)
      return
    }
    const timer = setTimeout(() => setMounted(false), QUEUE_ANIMATION_MS)
    return () => clearTimeout(timer)
  }, [reducedMotion, visible])
  return { mounted, visible: shown }
}

type PresentQueuedMessage = { item: QueuedMessageItem; visible: boolean }

export function QueuedMessagePresence({
  items,
  children
}: {
  items: readonly QueuedMessageItem[]
  children: (item: QueuedMessageItem) => React.ReactNode
}): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const latest = useRef(items)
  latest.current = items
  const signature = items.map((item) => item.id).join('\0')
  const [present, setPresent] = useState<PresentQueuedMessage[]>(() =>
    items.map((item) => ({ item, visible: true }))
  )
  useEffect(() => {
    const desired = new Map(latest.current.map((item) => [item.id, item]))
    if (reducedMotion) {
      setPresent(latest.current.map((item) => ({ item, visible: true })))
      return
    }
    setPresent((current) => {
      const previous = new Map(current.map((entry) => [entry.item.id, entry]))
      return [
        ...latest.current.map((item) => ({
          item,
          visible: previous.get(item.id)?.visible ?? false
        })),
        ...current
          .filter((entry) => !desired.has(entry.item.id))
          .map((entry) => ({ ...entry, visible: false }))
      ]
    })
    const frame = requestAnimationFrame(() =>
      setPresent((current) =>
        current.map((entry) =>
          desired.has(entry.item.id) ? { item: desired.get(entry.item.id)!, visible: true } : entry
        )
      )
    )
    return () => cancelAnimationFrame(frame)
  }, [reducedMotion, signature])
  const current = new Map(items.map((item) => [item.id, item]))
  return (
    <>
      {present.map((entry) => (
        <div
          key={entry.item.id}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
            entry.visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
          onTransitionEnd={(event) => {
            if (!entry.visible && event.propertyName === 'opacity') {
              setPresent((value) =>
                value.filter((candidate) => candidate.item.id !== entry.item.id)
              )
            }
          }}
        >
          <div className="min-h-0 overflow-hidden">
            {children(current.get(entry.item.id) ?? entry.item)}
          </div>
        </div>
      ))}
    </>
  )
}
