import { randomUUID } from 'node:crypto'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import type { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  currentTurnMessages,
  turnUserMessage,
  type RoomHarnessLifecycleEvent
} from './harness-lifecycle'
import type { RoomMachineHarnessBinding } from './harness-adapter-types'

export function structuredRoomHost() {
  const current = getStructuredAgentSessionHost()
  if (!current) {
    throw new Error('structured_agent_session_unsupported')
  }
  return current
}

export function readStructuredRoomState(sessionId: string): StructuredAgentSessionState {
  const result = structuredRoomHost().history({ sessionId, direction: 'tail', limit: 200 })
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'tail-page',
    page: result.page
  })
}

export function roomStructuredLifecycle(
  state: StructuredAgentSessionState,
  messages: ReturnType<typeof projectStructuredItemsToNativeChat>
): RoomHarnessLifecycleEvent | null {
  const lifecycle = state.items
    .toReversed()
    .find((item) => item.body.kind === 'status' && item.body.turnLifecycle)?.body
  if (!lifecycle || lifecycle.kind !== 'status' || !lifecycle.turnLifecycle) {
    return null
  }
  const userMessage = turnUserMessage(messages)
  const active = lifecycle.turnLifecycle.state === 'running'
  const outcome = lifecycle.turnLifecycle.outcome
  const prompt = state.items.findLast(
    (item) =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
  const permission =
    prompt?.body.kind === 'approval'
      ? {
          id: prompt.itemId,
          itemId: prompt.itemId,
          revision: prompt.revision,
          title: prompt.body.title,
          ...(prompt.body.detail ? { detail: prompt.body.detail } : {}),
          options: prompt.body.options.map((option) => ({
            ...option,
            kind: option.id.startsWith('reject') ? ('reject' as const) : ('allow-once' as const)
          }))
        }
      : undefined
  const input =
    prompt?.body.kind === 'question'
      ? {
          id: prompt.itemId,
          itemId: prompt.itemId,
          revision: prompt.revision,
          questions: prompt.body.questions ?? [
            {
              id: prompt.body.freeTextQuestionId ?? prompt.itemId,
              header: prompt.body.question,
              question: prompt.body.question,
              options: prompt.body.options.map((option) => ({ label: option.label })),
              allowOther: Boolean(prompt.body.freeTextQuestionId)
            }
          ]
        }
      : undefined
  return {
    type: active
      ? 'activity'
      : outcome === 'failed'
        ? 'failed'
        : outcome === 'interrupted'
          ? 'interrupted'
          : 'final',
    source: 'transcript',
    turnId: lifecycle.turnLifecycle.turnId,
    timestamp: state.items.at(-1)?.observedAt ?? Date.now(),
    messages: currentTurnMessages(messages),
    ...(userMessage ? { userMessage } : {}),
    ...(active ? { activity: { kind: 'thinking' as const } } : {}),
    ...(permission ? { permission } : {}),
    ...(input ? { input } : {})
  }
}

export function structuredRoomMutationEnvelope(
  sessionId: string,
  method: string,
  fields: Record<string, unknown>
): AgentSessionMutationEnvelope {
  return {
    sessionId,
    clientOperationId: structuredRoomOperationId(),
    expectedRuntimeFence: readStructuredRoomState(sessionId).fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

export function structuredRoomOperationId(): string {
  return createStructuredAgentSessionOperationId(randomUUID)
}

export function structuredRoomCaller(value: RoomMachineHarnessBinding) {
  return { callerKey: `trusted-local:room:${value.worktreeId}` }
}

export function structuredRoomHolderId(value: RoomMachineHarnessBinding): string {
  return `room:${value.worktreeId}:${value.conversationId}`
}

export function createRoomMachineBinding(
  worktreeId: string,
  conversationId: string,
  disposition: 'created' | 'adopted',
  sourceSessionId?: string
): RoomMachineHarnessBinding {
  return {
    transport: 'machine',
    worktreeId,
    conversationId,
    providerSession: {
      key: 'session_id',
      id: conversationId,
      transport: 'machine',
      ...(sourceSessionId ? { sourceSessionId } : {})
    },
    disposition
  }
}
