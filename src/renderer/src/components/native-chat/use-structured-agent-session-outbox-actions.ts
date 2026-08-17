import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

export function useStructuredAgentSessionOutboxActions(args: {
  sessionId: string
  outboxRef: MutableRefObject<StructuredAgentSessionOutboxEntry[]>
  blockedIdRef: MutableRefObject<string | null>
  setOutbox: Dispatch<SetStateAction<StructuredAgentSessionOutboxEntry[]>>
  setError: Dispatch<SetStateAction<string | null>>
}) {
  const { blockedIdRef, outboxRef, sessionId, setError, setOutbox } = args

  const edit = useCallback(
    (
      clientMessageId: string,
      text: string,
      attachments: readonly { path: string; previewUri: string }[] = []
    ): boolean => {
      const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
      if (!current || current.state === 'dispatching' || current.state === 'unconfirmed') {
        return false
      }
      const next = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? {
              ...entry,
              body: structuredAgentSessionSendBody(text, attachments),
              previewUris: attachments.map((attachment) => attachment.previewUri),
              intent: undefined
            }
          : entry
      )
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [outboxRef, sessionId, setError, setOutbox]
  )

  const remove = useCallback(
    (clientMessageId: string): boolean => {
      const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
      if (!current || current.state === 'dispatching' || current.state === 'unconfirmed') {
        return false
      }
      const next = outboxRef.current.filter((entry) => entry.clientMessageId !== clientMessageId)
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      blockedIdRef.current = blockedIdRef.current === clientMessageId ? null : blockedIdRef.current
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [blockedIdRef, outboxRef, sessionId, setError, setOutbox]
  )

  const reorder = useCallback(
    (clientMessageIds: readonly string[]): boolean => {
      const current = outboxRef.current
      if (
        clientMessageIds.length !== current.length ||
        new Set(clientMessageIds).size !== current.length ||
        current.some((entry) => entry.state === 'dispatching')
      ) {
        return false
      }
      const byId = new Map(current.map((entry) => [entry.clientMessageId, entry]))
      const next = clientMessageIds.map((id) => byId.get(id)).filter((entry) => entry !== undefined)
      if (next.length !== current.length || !writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      return true
    },
    [outboxRef, sessionId, setError, setOutbox]
  )

  const steer = useCallback(
    (clientMessageId: string): boolean => {
      const next = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId && entry.state === 'queued'
          ? { ...entry, intent: 'steer' as const }
          : entry
      )
      if (
        next.every((entry, index) => entry === outboxRef.current[index]) ||
        !writeOutbox(sessionId, next)
      ) {
        return false
      }
      blockedIdRef.current = null
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [blockedIdRef, outboxRef, sessionId, setError, setOutbox]
  )

  return { edit, remove, reorder, steer }
}
