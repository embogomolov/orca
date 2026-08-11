import type { RoomParticipant } from '../../../shared/rooms'
import type { RoomHarnessBinding } from './harness-adapter'

export function roomParticipantHarnessBinding(
  participant: RoomParticipant
): RoomHarnessBinding | null {
  return participant.terminalHandle && participant.paneKey && participant.worktreeId
    ? {
        worktreeId: participant.worktreeId,
        terminalHandle: participant.terminalHandle,
        paneKey: participant.paneKey,
        providerSession: participant.providerSession
      }
    : null
}
