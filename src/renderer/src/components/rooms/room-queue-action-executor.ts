import { useEffect, useRef, useState } from 'react'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomData } from './use-room-data'
import type { RoomQueueAction } from './room-queue-state'
import type { RoomMessage } from '../../../../shared/rooms'
import type { RoomQueueComposerEdit } from './room-queue-composer-edit'

export function useRoomQueueEditRequest(
  data: RoomData,
  onEdit: (edit: RoomQueueComposerEdit) => void,
  report: (error: unknown) => void
): { pending: boolean; begin: (message: RoomMessage) => void } {
  const [request, setRequest] = useState<{ roomId: string; messageId: string } | null>(null)
  const mounted = useRef(true)
  const roomId = useRef(data.roomId)
  roomId.current = data.roomId
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return {
    pending: request?.roomId === data.roomId,
    begin: (message) => {
      if (request?.roomId === data.roomId) {
        return
      }
      const started = { roomId: message.roomId, messageId: message.id }
      setRequest(started)
      void roomRpc<RoomQueueComposerEdit>(data.target, 'rooms.messages.beginQueueEdit', {
        messageId: message.id
      })
        .then((edit) => {
          if (mounted.current && roomId.current === edit.message.roomId) {
            onEdit(edit)
            return
          }
          void roomRpc(data.target, 'rooms.messages.cancelQueueEdit', {
            messageId: edit.message.id,
            editToken: edit.editToken
          }).catch(report)
        })
        .catch(report)
        .finally(() => {
          if (mounted.current) {
            setRequest((current) =>
              current?.roomId === started.roomId && current.messageId === started.messageId
                ? null
                : current
            )
          }
        })
    }
  }
}

export function executeRoomQueueAction(
  data: RoomData,
  action: RoomQueueAction,
  report: (error: unknown) => void
): Promise<void> {
  const supportsMutations = data.snapshot?.deliveryQueueMutationVersion === 1
  switch (action.type) {
    case 'retarget':
      return roomRpc(data.target, 'rooms.messages.retarget', {
        messageId: action.messageId,
        participantIds: action.participantIds
      })
        .then(() => undefined)
        .catch(report)
    case 'reorderShared':
      return roomRpc(data.target, 'rooms.messages.reorderQueue', {
        roomId: data.roomId,
        messageIds: action.messageIds,
        ...(supportsMutations ? { movedMessageId: action.movedMessageId } : {})
      })
        .then(() => undefined)
        .catch(report)
    case 'reorderAgent':
    case 'directAndPlace':
      return roomRpc(data.target, 'rooms.deliveries.reorder', {
        participantId: action.participantId,
        deliveryIds: action.deliveryIds,
        ...(supportsMutations
          ? action.type === 'reorderAgent'
            ? { movedDeliveryId: action.movedDeliveryId }
            : { retargetMessageId: action.messageId }
          : {})
      })
        .then(() => undefined)
        .catch(report)
  }
}
