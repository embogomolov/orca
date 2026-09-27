import type { AgentJournalTurn } from '../../shared/agent-session-journal-types'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome,
  ClaudeSession
} from './claude-structured-session-state'
import { forgetRetiredWaiter } from './claude-structured-dispatch-waiters'
import {
  claudeHasReplayContent,
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'
import { readClaudeFrameString } from './claude-structured-init-proof'
import { claudeDispatchContentKey } from './claude-structured-dispatch-content'

/** Settles a provider-proven late outcome; replay rows independently reconcile acceptance. */
export type ClaudeLateDispatchSettlement = (input: ClaudeLateDispatchOutcome) => void

export type ClaudeReplayTurnOrigin = { requestedAt: number | null; turn?: AgentJournalTurn }

export function resolveClaudeReplayTurn(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement
): ClaudeReplayTurnOrigin | null {
  const envelope = readClaudeMessageEnvelope(message)
  const isUserReplay =
    envelope?.role === 'user' &&
    message.parent_tool_use_id === null &&
    claudeHasReplayContent(envelope)
  const isCompletedCommand = message.type === 'result'
  if (
    (!isUserReplay && !isCompletedCommand) ||
    readClaudeFrameString(message, 'session_id') !== session.providerSessionId
  ) {
    return null
  }
  const uuid = readClaudeFrameString(message, 'uuid')
  if (!uuid) {
    return null
  }

  // Newer SDK frames carry the client uuid that caused a turn. A correlation
  // value is authoritative: never fall back to queue order or content, since
  // identical prompts may be in flight across a timeout boundary.
  const userMessageUuid = readClaudeFrameString(message, 'user_message_uuid')
  if (userMessageUuid) {
    const exact = session.dispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (exact) {
      settleWaiter(session, exact, uuid, onSettledLate)
      return isUserReplay ? replayOrigin(exact) : null
    }
    const retired = session.retiredDispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (retired) {
      forgetRetiredWaiter(session, retired)
      return recoverLateIdentity(session, retired, uuid, isUserReplay, onSettledLate)
    }
    return null
  }

  const exact = session.dispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (exact) {
    settleWaiter(session, exact, uuid, onSettledLate)
    return isUserReplay ? replayOrigin(exact) : null
  }
  const retired = session.retiredDispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (retired) {
    forgetRetiredWaiter(session, retired)
    return recoverLateIdentity(session, retired, uuid, isUserReplay, onSettledLate)
  }

  if (isUserReplay) {
    // Compatibility CLIs may mint a new replay uuid instead of echoing the
    // client uuid. Content is an acceptable join only when it is the sole
    // candidate on one side of the timeout boundary; with active and retired
    // candidates present, identical prompts are intentionally left unknown.
    const replayContentKey = claudeDispatchContentKey(envelope.content)
    if (!session.replayContentFallbackBlocked && session.retiredDispatchWaiters.length === 0) {
      const compatible = session.dispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (compatible.length === 1) {
        const [candidate] = compatible
        settleWaiter(session, candidate!, uuid, onSettledLate)
        return replayOrigin(candidate!)
      }
    } else if (!session.replayContentFallbackBlocked && session.dispatchWaiters.length === 0) {
      const lateCompatible = session.retiredDispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (lateCompatible.length === 1) {
        const [candidate] = lateCompatible
        forgetRetiredWaiter(session, candidate!)
        return recoverLateIdentity(session, candidate!, uuid, true, onSettledLate)
      }
    }
    return null
  }
  const current = session.dispatchWaiters[0]
  if (isCompletedCommand && !current?.acceptsResult) {
    return null
  }
  // A legacy result has no dispatch correlation. Any retired waiter makes queue order ambiguous,
  // even when the retired dispatch was an ordinary turn rather than a slash command.
  if (isCompletedCommand && session.retiredDispatchWaiters.length > 0) {
    return null
  }
  // Once an eviction occurred, a fresh result uuid cannot be joined to a waiter by queue order.
  if (isCompletedCommand && session.replayContentFallbackBlocked) {
    return null
  }
  const waiter = uuid ? session.dispatchWaiters.shift() : undefined
  if (waiter && uuid) {
    settleWaiter(session, waiter, uuid, onSettledLate)
    return isUserReplay ? replayOrigin(waiter) : null
  }
  return null
}

function settleWaiter(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
  waiter.settledUuid = uuid
  adoptTurn(session, waiter, uuid)
  waiter.resolve(uuid)
  // Dispatch returned on admission, so the replay is what settles delivery.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: {
        provider: 'claude',
        sessionId: session.providerSessionId,
        uuid,
        ...(waiter.steeredTurnId ? { turn: waiter.turn } : {})
      }
    })
  }
}

function recoverLateIdentity(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  isUserReplay: boolean,
  onSettledLate?: ClaudeLateDispatchSettlement
): ClaudeReplayTurnOrigin | null {
  if (!isUserReplay && !waiter.acceptsResult) {
    return null
  }
  // The provider acted on this dispatch, so the send it came from is delivered.
  // A retired replay settles delivery only; it cannot reopen a turn.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: {
        provider: 'claude',
        sessionId: session.providerSessionId,
        uuid,
        ...(waiter.steeredTurnId ? { turn: { turnId: waiter.steeredTurnId } } : {})
      }
    })
  }
  return isUserReplay && waiter.steeredTurnId
    ? { requestedAt: waiter.requestedAt, turn: { turnId: waiter.steeredTurnId } }
    : null
}

function adoptTurn(session: ClaudeSession, waiter: ClaudeDispatchWaiter, uuid: string): void {
  waiter.turn =
    waiter.steeredTurnId && session.translator?.currentTurnId
      ? { turnId: waiter.steeredTurnId }
      : { turnId: uuid, root: true }
}

function replayOrigin(waiter: ClaudeDispatchWaiter): ClaudeReplayTurnOrigin {
  return { requestedAt: waiter.requestedAt, ...(waiter.steeredTurnId ? { turn: waiter.turn } : {}) }
}
