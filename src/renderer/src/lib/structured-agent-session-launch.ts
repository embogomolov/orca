import { toast } from 'sonner'
import {
  createStructuredAgentSessionLaunchIntent,
  launchStructuredAgentSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import { useAppStore } from '@/store'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { translate } from '@/i18n/i18n'
import type { StructuredMachineAgent } from '../../../shared/structured-agent-provider'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-outbox'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { applyStructuredAgentLaunchOptions } from './structured-agent-session-launch-options'

type StructuredLaunchState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<string>
  visibilityUnknown: boolean
  supportConfirmed: boolean
}

export class StructuredAgentSessionUnavailableError extends Error {}

const pendingStructuredLaunchesByWorktree = new Map<string, StructuredLaunchState>()

function trackLaunchSettlement(
  worktreeId: string,
  state: StructuredLaunchState,
  promise: Promise<string>
): void {
  void promise.then(
    () => {
      if (
        state.promise === promise &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
      }
    },
    () => {
      if (
        state.promise === promise &&
        !state.visibilityUnknown &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
      }
    }
  )
}

async function verifyPublishedSession(intent: StructuredAgentSessionLaunchIntent): Promise<string> {
  const published =
    intent.target.kind === 'local'
      ? (await refreshLocalStructuredSessionTabs()).some(
          (snapshot) =>
            snapshot.worktree === intent.worktreeId &&
            snapshot.tabs.some(
              (tab) => tab.type === 'agent-session' && tab.sessionId === intent.sessionId
            )
        )
      : await refreshRemotePublishedSession(intent)
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
  return intent.sessionId
}

async function refreshRemotePublishedSession(
  intent: StructuredAgentSessionLaunchIntent
): Promise<boolean> {
  if (intent.target.kind !== 'environment') {
    return false
  }
  await refreshWebRuntimeSessionTabsSnapshot(intent.target.environmentId, intent.worktreeId, {
    acceptCurrentSnapshot: true,
    afterCurrentInFlight: true,
    errorMode: 'throw'
  })
  return (useAppStore.getState().unifiedTabsByWorktree[intent.worktreeId] ?? []).some(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === intent.sessionId
  )
}

async function ensureCreateSupported(state: StructuredLaunchState): Promise<void> {
  if (state.supportConfirmed) {
    return
  }
  const support = await callStructuredAgentSession<{ supported: boolean }>(
    state.intent.target,
    'agentSession.createSupport',
    { worktree: state.intent.params.worktree, agent: state.intent.params.agent }
  ).catch((error) => {
    throw new StructuredAgentSessionUnavailableError(
      error instanceof Error ? error.message : String(error)
    )
  })
  if (!support.supported) {
    throw new StructuredAgentSessionUnavailableError('structured agent session unavailable')
  }
  state.supportConfirmed = true
}

async function retrySameIntent(state: StructuredLaunchState, priorError: unknown): Promise<string> {
  try {
    await launchStructuredAgentSession(state.intent)
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      state.visibilityUnknown = true
      throw error ?? priorError
    }
  }
}

async function launchAndReconcile(state: StructuredLaunchState): Promise<string> {
  await ensureCreateSupported(state)
  try {
    await launchStructuredAgentSession(state.intent)
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

async function reconcileUnknownLaunch(state: StructuredLaunchState): Promise<string> {
  state.visibilityUnknown = false
  try {
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

function getOrStartStructuredAgentSession(
  worktreeId: string,
  agent: StructuredMachineAgent,
  target: RuntimeClientTarget,
  groupId?: string
): { state: StructuredLaunchState; started: boolean } {
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const key = `${targetKey}:${worktreeId}:${agent}`
  const existing = pendingStructuredLaunchesByWorktree.get(key)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(key, existing, existing.promise)
    }
    return { state: existing, started: false }
  }
  const state: StructuredLaunchState = {
    intent: createStructuredAgentSessionLaunchIntent(worktreeId, agent, target, groupId),
    promise: Promise.resolve(''),
    visibilityUnknown: false,
    supportConfirmed: false
  }
  state.promise = launchAndReconcile(state)
  pendingStructuredLaunchesByWorktree.set(key, state)
  trackLaunchSettlement(key, state, state.promise)
  return { state, started: true }
}

async function sendLaunchPrompt(
  intent: StructuredAgentSessionLaunchIntent,
  text: string
): Promise<void> {
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    intent.target,
    'agentSession.history',
    { sessionId: intent.sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.page.fence
  if (fence === undefined) {
    throw new Error('structured session fence unavailable')
  }
  const body = structuredAgentSessionSendBody(text, [])
  const fields = { body }
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionSendResult>
  >(intent.target, 'agentSession.send', {
    envelope: {
      sessionId: intent.sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
      expectedRuntimeFence: fence,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: intent.sessionId,
        fields
      })
    },
    ...fields
  })
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  if (result.value.submission.dispatchState !== 'accepted') {
    throw new Error(result.value.submission.reason ?? 'Message delivery is unconfirmed')
  }
}

export type StructuredAgentLaunchDelivery = {
  delivered: boolean
  failureNotified: boolean
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: StructuredMachineAgent = 'codex',
  options: {
    target?: RuntimeClientTarget
    groupId?: string
    prompt?: string
    promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
    sessionOptions?: Record<string, SessionOptionValue>
    onPromptDelivered?: () => void
    onUnavailable?: () =>
      | StructuredAgentLaunchDelivery
      | Promise<StructuredAgentLaunchDelivery>
      | void
  } = {}
): Promise<StructuredAgentLaunchDelivery> {
  const launch = getOrStartStructuredAgentSession(
    worktreeId,
    agent,
    options.target ?? { kind: 'local' },
    options.groupId
  )
  const prompt = options.prompt?.trim() ?? ''
  const draft =
    prompt.length > 0 &&
    (options.promptDelivery === 'draft' || agent === 'claude' || agent === 'openclaude')
  if (launch.started && draft) {
    writeNativeChatDraftCache(launch.state.intent.sessionId, prompt)
  }
  return launch.state.promise
    .then(async () => {
      if (launch.started && options.sessionOptions) {
        await applyStructuredAgentLaunchOptions(launch.state.intent, options.sessionOptions)
      }
      if (!launch.started || prompt.length === 0 || draft) {
        return { delivered: false, failureNotified: false }
      }
      await sendLaunchPrompt(launch.state.intent, prompt)
      options.onPromptDelivered?.()
      return { delivered: true, failureNotified: false }
    })
    .catch(async (error): Promise<StructuredAgentLaunchDelivery> => {
      if (error instanceof StructuredAgentSessionUnavailableError && options.onUnavailable) {
        return (await options.onUnavailable()) ?? { delivered: false, failureNotified: false }
      }
      toast.error(
        translate(
          'components.native-chat.structuredSessionLaunchFailed',
          'Could not open {{agent}} chat',
          { agent: agent === 'openclaude' ? 'OpenClaude' : agent[0].toUpperCase() + agent.slice(1) }
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
      return { delivered: false, failureNotified: true }
    })
}
