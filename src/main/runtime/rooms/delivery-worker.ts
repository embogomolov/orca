import type { RoomDelivery, RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import { formatRoomDeliveryPrompt } from './delivery-prompt'
import type { RoomAttachmentManager } from './attachments'
import { deferPausedDelivery, deliveryFailureState } from './delivery-selection'
import { stageRoomDeliveryAttachments } from './delivery-attachments'
import { RoomDeliveryConfirmations } from './delivery-confirmations'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import { claimReadyRoomDelivery } from './delivery-machine-readiness'
import { runRoomSteer } from './delivery-steer-selection'
import { claimReadyRoomBroadcast } from './delivery-broadcast-dispatch'
import { scheduleRoomDeliveryDrain } from './delivery-scheduler'
import { assertCurrentRoomDelivery, isRoomDeliveryMissing } from './delivery-current-guard'
import { RoomDeliveryGate, type RoomDeliveryFence } from './delivery-room-gate'

export class RoomDeliveryWorker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private rerun = false
  private disposed = false
  private readonly confirmations: RoomDeliveryConfirmations
  private readonly gate = new RoomDeliveryGate()
  private busyRetryAt = 0

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly attachments: RoomAttachmentManager,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly ensureParticipantReady: (participantId: string) => Promise<RoomParticipant>,
    confirmDeadlineMs = 30_000
  ) {
    this.confirmations = new RoomDeliveryConfirmations(
      db,
      adapters,
      emit,
      () => this.wake(),
      confirmDeadlineMs
    )
  }

  start(): void {
    this.db.messages.deliveries.suppressDeletedMessages()
    this.db.messages.deliveries.recoverInterrupted()
    this.wake()
  }

  wake(): void {
    if (this.disposed) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.draining) {
      this.rerun = true
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, 0)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.confirmations.dispose()
    this.gate.dispose()
  }

  requestRoomFence(roomId: string, options: { discardConfirmations: boolean }): RoomDeliveryFence {
    const fence = this.gate.requestFence(roomId)
    return {
      ready: fence.ready.then((acquired) => {
        if (acquired && options.discardConfirmations) {
          this.confirmations.clearRoom(roomId)
        }
      }),
      claimAllowed: fence.claimAllowed,
      release: () => {
        fence.release()
        this.wake()
      }
    }
  }

  /** Stable delivery IDs distinguish room turns from direct Chat/CLI turns. */
  confirmTurn(participantId: string, userMessage: RoomHarnessTurnUserMessage): RoomDelivery | null {
    return this.confirmations.confirm(participantId, userMessage)
  }

  async steer(id: string, group = false): Promise<void> {
    return runRoomSteer(
      this.db,
      this.adapters,
      id,
      this.requestRoomFence.bind(this),
      this.deliver.bind(this),
      this.track.bind(this),
      group
    )
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) {
      return
    }
    this.draining = true
    try {
      const { db, adapters, ensureParticipantReady } = this
      let repeat: boolean
      do {
        this.rerun = false
        let claimedAny = false
        let busyCandidate = false
        const due = this.db.messages.deliveries.listDue(Date.now(), 100, this.gate.blockedRoomIds())
        const handledBroadcasts = new Set<string>()
        for (const candidate of due) {
          const roomId = this.db.messages.get(candidate.messageId).roomId
          if (!this.gate.claimAllowed(roomId)) {
            continue
          }
          if (this.db.messages.deliveries.workState(roomId) === 'stopped') {
            busyCandidate = true
            continue
          }
          if (this.db.messages.deliveries.isInitialBroadcastDispatch(candidate.messageId)) {
            if (handledBroadcasts.has(candidate.messageId)) {
              continue
            }
            handledBroadcasts.add(candidate.messageId)
            const claimed = await this.gate.startClaim(
              roomId,
              () =>
                claimReadyRoomBroadcast(
                  db,
                  adapters,
                  candidate.messageId,
                  ensureParticipantReady,
                  () => this.gate.claimAllowed(roomId)
                ),
              (delivery) => void this.track(roomId, () => this.deliver(delivery))
            )
            if (!claimed) {
              busyCandidate = true
              continue
            }
            claimedAny = true
            continue
          }
          const claimed = await this.gate.startClaim(
            roomId,
            async () => {
              const delivery = await claimReadyRoomDelivery(
                db,
                adapters,
                candidate,
                ensureParticipantReady,
                () => this.gate.claimAllowed(roomId)
              )
              return delivery ? [delivery] : null
            },
            (delivery) => void this.track(roomId, () => this.deliver(delivery))
          )
          if (!claimed) {
            busyCandidate = true
            continue
          }
          claimedAny = true
        }
        if (!claimedAny && busyCandidate) {
          this.busyRetryAt = Date.now() + 250
        }
        repeat = claimedAny || this.rerun
      } while (repeat)
    } finally {
      this.draining = false
      this.scheduleNext()
    }
  }

  private async deliver(delivery: RoomDelivery, steer = false): Promise<void> {
    const message = this.db.messages.get(delivery.messageId)
    let target = this.db.participants.get(delivery.participantId)
    this.emit(message.roomId, { type: 'delivery.updated', delivery })
    try {
      this.db.core.get(message.roomId)
      const initiallyDeferred = deferPausedDelivery(this.db, delivery)
      if (initiallyDeferred) {
        return this.emit(target.roomId, { type: 'delivery.updated', delivery: initiallyDeferred })
      }
      // A second status probe would reject silent daemon-recovered PTYs.
      if (!steer) {
        target = await this.ensureParticipantReady(target.id)
      }
      assertCurrentRoomDelivery(this.db, delivery)
      const adapter = target.agent ? this.adapters[target.agent] : undefined
      const binding = roomParticipantHarnessBinding(target)
      if (!adapter || !binding) {
        throw new Error('room_agent_not_attached')
      }
      const snapshot = this.db.snapshot(message.roomId)
      const role = snapshot.roles.find((item) => item.id === target.roleId) ?? null
      const configuration = this.db.deliveryConfiguration.pending({
        participant: target,
        room: snapshot.room,
        role
      })
      const replyParent = message.replyToId ? this.db.messages.get(message.replyToId) : null
      const attachmentPaths = await stageRoomDeliveryAttachments({
        adapter,
        binding,
        attachments: this.attachments,
        messages: replyParent ? [replyParent, message] : [message]
      })
      assertCurrentRoomDelivery(this.db, delivery)
      const prompt = formatRoomDeliveryPrompt({
        deliveryId: delivery.id,
        attempt: delivery.attempts,
        response: message.mentions.some(
          (identity) => identity.toLocaleLowerCase() === target.identity.toLocaleLowerCase()
        )
          ? 'required'
          : 'optional',
        roomName: snapshot.room.name,
        message,
        replyParent,
        target,
        participants: snapshot.participants,
        configuration: configuration.configuration,
        attachmentPaths
      })
      const imagePaths = message.attachments
        .filter((attachment) => attachment.mimeType.startsWith('image/'))
        .map((attachment) => attachmentPaths.get(attachment.id)!)
      target = this.db.participants.get(delivery.participantId)
      const deferred = deferPausedDelivery(this.db, delivery)
      if (deferred) {
        return this.emit(target.roomId, { type: 'delivery.updated', delivery: deferred })
      }
      this.confirmations.prepare(delivery.id, target.id, configuration.snapshot)
      delivery = this.db.messages.deliveries.setPhase(delivery.id, 'submitting')
      this.emit(message.roomId, { type: 'delivery.updated', delivery })
      const result = steer
        ? await adapter.steer!(binding, prompt, imagePaths.length > 0 ? { imagePaths } : undefined)
        : await adapter.send(binding, prompt, {
            beforeWrite: () => assertCurrentRoomDelivery(this.db, delivery),
            clearInput: delivery.attempts > 1,
            ...(imagePaths.length > 0 ? { imagePaths } : {})
          })
      if (!result.accepted) {
        throw new Error(result.refusedReason ?? 'room_delivery_refused')
      }
      if (this.db.messages.deliveries.get(delivery.id).state !== 'delivering') {
        return
      }
      delivery = this.db.messages.deliveries.setPhase(delivery.id, 'awaiting-turn')
      this.emit(message.roomId, { type: 'delivery.updated', delivery })
      // Only a provider turn confirms PTY paste; a swallowed paste must be requeued.
      this.confirmations.arm(delivery.id)
    } catch (error) {
      this.confirmations.discard(delivery.id)
      if (this.disposed || isRoomDeliveryMissing(this.db, delivery.id)) {
        return
      }
      const messageText = error instanceof Error ? error.message : String(error)
      const uncertain = messageText === 'conversation_steer_uncertain'
      if (steer && !uncertain) {
        const queued = this.db.messages.deliveries.returnSteerToNext(delivery.id, messageText)
        this.emit(message.roomId, { type: 'delivery.updated', delivery: queued })
        throw new Error(messageText)
      }
      const exhausted = delivery.attempts >= 5
      const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, delivery.attempts - 1))
      const failed = this.db.messages.deliveries.complete(
        delivery.id,
        uncertain ? 'failed' : deliveryFailureState(exhausted),
        uncertain ? 'room_delivery_uncertain' : messageText,
        uncertain || exhausted ? Number.MAX_SAFE_INTEGER : Date.now() + delay
      )
      this.emit(message.roomId, { type: 'delivery.updated', delivery: failed })
    }
  }

  private async track(roomId: string, run: () => Promise<void>): Promise<void> {
    try {
      await this.gate.startTask(roomId, run)
    } finally {
      this.wake()
    }
  }

  private scheduleNext(): void {
    scheduleRoomDeliveryDrain(
      this.db,
      this.gate.blockedRoomIds(),
      this.busyRetryAt,
      this.disposed,
      this.timer,
      (timer) => (this.timer = timer),
      () => {
        this.timer = null
        void this.drain()
      }
    )
  }
}
