import { useState } from 'react'
import type { RoomData } from './use-room-data'
import type { QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import type { RoomMessage } from '../../../../shared/rooms'
import { RoomQueuedMessageCard } from './RoomQueuedMessageCard'
import { activeMessageDeliveries } from './room-queue-state'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { translate } from '@/i18n/i18n'

export function RoomSharedQueueRow({
  data,
  item,
  report,
  inlineEdit = true,
  onEditInComposer
}: {
  data: RoomData
  item: QueuedMessageItem
  report: (error: unknown) => void
  inlineEdit?: boolean
  onEditInComposer?: () => void
}): React.JSX.Element | null {
  const message = data.messages.find(
    (candidate) => candidate.id === item.id.slice('room-queue-all:'.length)
  )
  if (!message) {
    return null
  }
  const activeDeliveries = activeMessageDeliveries(data, message.id)
  return (
    <RoomQueuedMessageCard
      key={item.id}
      data={data}
      message={message}
      item={item}
      onEdit={
        inlineEdit
          ? (body) =>
              void roomRpc(data.target, 'rooms.messages.update', {
                messageId: message.id,
                body
              }).catch(report)
          : undefined
      }
      onEditInComposer={onEditInComposer}
      onRemove={() =>
        void roomRpc(data.target, 'rooms.messages.delete', { messageId: message.id }).catch(report)
      }
      onSteer={() => {
        const delivery = activeDeliveries.find((entry) => entry.state === 'pending')
        if (delivery) {
          void roomRpc(data.target, 'rooms.deliveries.steer', {
            deliveryId: delivery.id,
            group: true
          }).catch(report)
        }
      }}
      onRetry={
        activeDeliveries.some((delivery) => delivery.state === 'failed')
          ? () =>
              activeDeliveries
                .filter((delivery) => delivery.state === 'failed')
                .forEach(
                  (delivery) =>
                    void roomRpc(data.target, 'rooms.deliveries.retry', {
                      deliveryId: delivery.id
                    }).catch(report)
                )
          : undefined
      }
    />
  )
}

export function RoomDirectedQueueRow({
  data,
  item,
  participantId,
  report,
  inlineEdit = true,
  onEditInComposer
}: {
  data: RoomData
  item: QueuedMessageItem
  participantId: string
  report: (error: unknown) => void
  inlineEdit?: boolean
  onEditInComposer?: (message: RoomMessage) => void
}): React.JSX.Element | null {
  const [steering, setSteering] = useState(false)
  const delivery = data.deliveries[item.id]
  const participant = data.snapshot?.participants.find((entry) => entry.id === participantId)
  const message = delivery && data.messages.find((entry) => entry.id === delivery.messageId)
  if (!delivery || !participant || !message) {
    return null
  }
  return (
    <RoomQueuedMessageCard
      key={item.id}
      data={data}
      message={message}
      item={
        steering
          ? {
              ...item,
              state: 'submitting',
              detail: translate('rooms.queue.steering', 'Steering to the agent…')
            }
          : item
      }
      onEdit={
        inlineEdit
          ? (body) =>
              void roomRpc(data.target, 'rooms.messages.update', {
                messageId: message.id,
                body
              }).catch(report)
          : undefined
      }
      onEditInComposer={onEditInComposer ? () => onEditInComposer(message) : undefined}
      onRemove={
        data.snapshot?.deliveryQueueMutationVersion === 1
          ? () =>
              void roomRpc(data.target, 'rooms.messages.retarget', {
                messageId: message.id,
                removeParticipantId: participant.id
              }).catch(report)
          : undefined
      }
      onSteer={() => {
        if (steering) {
          return
        }
        setSteering(true)
        void roomRpc(data.target, 'rooms.deliveries.steer', { deliveryId: delivery.id })
          .catch(report)
          .finally(() => setSteering(false))
      }}
      onRetry={
        delivery.state === 'failed'
          ? () =>
              void roomRpc(data.target, 'rooms.deliveries.retry', {
                deliveryId: delivery.id
              }).catch(report)
          : undefined
      }
    />
  )
}
