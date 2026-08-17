import { useEffect, useMemo, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import type { RoomParticipant } from '../../../../shared/rooms'
import type { RoomQueueState } from './room-queue-state'

const EMPTY_PARTICIPANTS: RoomParticipant[] = []

export function useRoomQueueSquarePresence(input: {
  state: RoomQueueState | null
  dragging: boolean
  keptSquareId: string | null
  directedRows: (participantId: string) => readonly unknown[]
}) {
  const { state, dragging, keptSquareId, directedRows } = input
  const participants = state?.participants ?? EMPTY_PARTICIPANTS
  const prefersReducedMotion = usePrefersReducedMotion()
  const [renderedIds, setRenderedIds] = useState<string[]>([])
  const desiredIds = useMemo(
    () =>
      new Set(
        (dragging
          ? participants
          : participants.filter(
              (participant) =>
                participant.id === keptSquareId || directedRows(participant.id).length > 0
            )
        ).map((participant) => participant.id)
      ),
    [directedRows, dragging, keptSquareId, participants]
  )
  const desiredRef = useRef(desiredIds)
  desiredRef.current = desiredIds
  useEffect(() => {
    if (prefersReducedMotion) {
      setRenderedIds([...desiredIds])
      return
    }
    setRenderedIds((current) => [
      ...current.filter((id) => participants.some((participant) => participant.id === id)),
      ...[...desiredIds].filter((id) => !current.includes(id))
    ])
  }, [desiredIds, participants, prefersReducedMotion])
  return {
    participants,
    desiredIds,
    squares: renderedIds.flatMap((id) => {
      const participant = participants.find((candidate) => candidate.id === id)
      return participant ? [participant] : []
    }),
    removeExited: (id: string): void => {
      if (!desiredRef.current.has(id)) {
        setRenderedIds((current) => current.filter((candidate) => candidate !== id))
      }
    }
  }
}
