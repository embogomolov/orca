import {
  RoomsListParams,
  RoomsCreateParams,
  RoomsSnapshotParams,
  RoomsSubscribeParams,
  RoomsUnsubscribeParams,
  RoomsMessagesListParams,
  RoomsMessagesSendParams,
  RoomsMessagesUpdateParams,
  RoomsMessagesDeleteParams,
  RoomsReadParams,
  RoomsParticipantsAddParams,
  RoomsParticipantsRemoveParams,
  RoomsParticipantsRevealParams,
  RoomsParticipantsUpdateParams,
  RoomsParticipantsCompactParams,
  RoomsParticipantsControlParams,
  RoomsParticipantsConfigureParams,
  RoomsDeliveriesRetryParams
} from '../../../../shared/rpc-contract/rooms-core-params'

import { defineMethod, defineStreamingMethod } from '../core'

import { ROOM_WORK_METHODS } from './rooms-work'
import { ROOM_NOTIFICATION_METHODS } from './rooms-notifications'
import { ROOM_EXISTING_PARTICIPANT_METHOD } from './rooms-participant-existing'

export const ROOM_CORE_METHODS = [
  defineMethod({
    name: 'rooms.list',
    params: RoomsListParams,
    handler: async (params, { runtime }) => ({
      rooms: runtime.getRoomService().listRooms(params.projectId)
    })
  }),
  defineMethod({
    name: 'rooms.create',
    params: RoomsCreateParams,
    handler: async (params, { runtime }) => ({
      snapshot: runtime.getRoomService().createRoom(params)
    })
  }),
  defineMethod({
    name: 'rooms.snapshot',
    params: RoomsSnapshotParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      // The header must render instantly from persisted state; harness
      // reconciliation can take minutes and streams participant.updated events.
      void service.activateRoom(params.roomId, params.readerKey).catch(() => {})
      return { snapshot: service.snapshot(params.roomId, params.readerKey) }
    }
  }),
  defineStreamingMethod({
    name: 'rooms.subscribe',
    params: RoomsSubscribeParams,
    handler: async (params, { runtime, connectionId }, emit) => {
      const key = `rooms:${connectionId ?? 'local'}:${params.subscriptionId}`
      let deleted = false
      const unsubscribe = runtime
        .getRoomService()
        .subscribe(params.roomId, params.readerKey, (event) => {
          emit(event)
          if (event.type === 'end' && event.reason === 'deleted') {
            deleted = true
            queueMicrotask(() => runtime.cleanupSubscription(key))
          }
        })
      runtime.registerSubscriptionCleanup(
        key,
        () => {
          unsubscribe()
          if (!deleted) {
            emit({ type: 'end' })
          }
        },
        connectionId
      )
    }
  }),
  defineMethod({
    name: 'rooms.unsubscribe',
    params: RoomsUnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      runtime.cleanupSubscription(`rooms:${connectionId ?? 'local'}:${params.subscriptionId}`)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'rooms.messages.list',
    params: RoomsMessagesListParams,
    handler: async (params, { runtime }) => ({
      page: runtime
        .getRoomService()
        .listMessages(params.roomId, params.beforeSequence ?? null, params.limit)
    })
  }),
  defineMethod({
    name: 'rooms.messages.send',
    params: RoomsMessagesSendParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      return {
        message: await service.sendMessage({
          ...params,
          senderIdentity: service.getUserParticipant(params.roomId).identity
        })
      }
    }
  }),
  defineMethod({
    name: 'rooms.messages.update',
    params: RoomsMessagesUpdateParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.messages.get(params.messageId)
      return {
        message: service.updateMessage(
          current.id,
          service.getUserParticipant(current.roomId).identity,
          params.body
        )
      }
    }
  }),
  defineMethod({
    name: 'rooms.messages.delete',
    params: RoomsMessagesDeleteParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.messages.get(params.messageId)
      await service.deleteMessage(current.id, service.getUserParticipant(current.roomId).identity)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'rooms.read',
    params: RoomsReadParams,
    handler: async (params, { runtime }) => ({
      unread: runtime.getRoomService().markRead(params.roomId, params.readerKey, params.sequence)
    })
  }),
  defineMethod({
    name: 'rooms.participants.add',
    params: RoomsParticipantsAddParams,
    handler: async (params, { runtime }) => ({
      participant: await runtime.getRoomService().addParticipant(params)
    })
  }),
  ROOM_EXISTING_PARTICIPANT_METHOD,
  defineMethod({
    name: 'rooms.participants.remove',
    params: RoomsParticipantsRemoveParams,
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().removeParticipant(params.participantId)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'rooms.participants.reveal',
    params: RoomsParticipantsRevealParams,
    handler: async (params, { runtime }) => {
      await runtime.getRoomService().revealParticipant(params.participantId, params.viewMode)
      return { revealed: true }
    }
  }),
  defineMethod({
    name: 'rooms.participants.update',
    params: RoomsParticipantsUpdateParams,
    handler: async (params, { runtime }) => {
      const service = runtime.getRoomService()
      const current = service.db.participants.get(params.participantId)
      service.assertWritable(current.roomId)
      const participant = service.db.participants.update(current.id, params)
      service.emitEvent(participant.roomId, { type: 'participant.updated', participant })
      return { participant }
    }
  }),
  defineMethod({
    name: 'rooms.participants.compact',
    params: RoomsParticipantsCompactParams,
    handler: async (params, { runtime }) => ({
      participant: await runtime.getRoomService().compactParticipant(params.participantId)
    })
  }),
  defineMethod({
    name: 'rooms.participants.control',
    params: RoomsParticipantsControlParams,
    handler: async (params, { runtime }) => ({
      participant: await runtime
        .getRoomService()
        .controlParticipant(params.participantId, params.command)
    })
  }),
  defineMethod({
    name: 'rooms.participants.configure',
    params: RoomsParticipantsConfigureParams,
    handler: async ({ participantId, ...preferences }, { runtime }) => ({
      participant: await runtime.getRoomService().reconfigureParticipant(participantId, preferences)
    })
  }),
  defineMethod({
    name: 'rooms.deliveries.retry',
    params: RoomsDeliveriesRetryParams,
    handler: async (params, { runtime }) => {
      runtime.getRoomService().retryDelivery(params.deliveryId)
      return { retried: true }
    }
  }),
  ...ROOM_WORK_METHODS,
  ...ROOM_NOTIFICATION_METHODS
]
