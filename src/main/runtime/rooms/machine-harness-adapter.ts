import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredItemsToNativeChat
} from '../../../shared/structured-agent-session-projection'
import type { StructuredMachineAgent } from '../../../shared/structured-agent-provider'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { attachFingerprintFields } from '../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { RoomContextSnapshot } from '../../../shared/rooms'
import type {
  RoomHarnessLaunchOptions,
  RoomHarnessReadResult,
  RoomHarnessRuntime,
  RoomHarnessSubscriptionCallbacks,
  RoomMachineHarnessBinding
} from './harness-adapter-types'
import {
  createRoomMachineBinding,
  readStructuredRoomState,
  structuredRoomCaller,
  structuredRoomHolderId,
  structuredRoomHost,
  structuredRoomMutationEnvelope,
  structuredRoomOperationId
} from './machine-harness-session'
import {
  applyMachineRoomPreferences,
  machineRoomInputReady,
  machineRoomLastActivityAt,
  readMachineRoomContext,
  readMachineRoomReady,
  readMachineRoomStatus,
  subscribeMachineRoomSession
} from './machine-room-session-observation'

type MachineExistingInput = {
  worktreeId: string
  conversationId?: string
  providerSessionId?: string
}

export class MachineRoomHarnessAdapter {
  constructor(
    readonly agent: StructuredMachineAgent,
    private readonly runtime: RoomHarnessRuntime
  ) {}

  async launch(
    worktreeId: string,
    options?: RoomHarnessLaunchOptions
  ): Promise<RoomMachineHarnessBinding> {
    return this.attach(worktreeId, options)
  }

  async connectExisting(
    input: MachineExistingInput,
    options?: RoomHarnessLaunchOptions
  ): Promise<RoomMachineHarnessBinding> {
    if (!input.conversationId) {
      if (!input.providerSessionId) {
        throw new Error('room_historical_session_not_found')
      }
      return this.attach(input.worktreeId, options, input.providerSessionId)
    }
    const ensureHost = this.runtime.ensureStructuredAgentSessionHost?.bind(this.runtime)
    if (!ensureHost) {
      throw new Error('structured_agent_session_unsupported')
    }
    await ensureHost()
    const host = structuredRoomHost()
    if (!host.hasSession(input.conversationId)) {
      await host.restoreReadableSessions([input.conversationId])
    }
    const session = host
      .listSessionTabs()
      .find((candidate) => candidate.sessionId === input.conversationId)
    if (!session || session.workspaceId !== input.worktreeId || session.agent !== this.agent) {
      throw new Error('conversation_identity_conflict')
    }
    const history = host.history({
      sessionId: input.conversationId,
      direction: 'tail',
      limit: 1
    })
    const binding = createRoomMachineBinding(
      input.worktreeId,
      input.conversationId,
      'adopted',
      history.providerSession?.id
    )
    const holderId = structuredRoomHolderId(binding)
    await host.hold(input.conversationId, holderId)
    try {
      await this.applyPreferences(binding, options?.preferences)
      return binding
    } catch (error) {
      host.release(input.conversationId, holderId)
      throw error
    }
  }

  private async attach(
    worktreeId: string,
    options?: RoomHarnessLaunchOptions,
    providerSessionId?: string
  ): Promise<RoomMachineHarnessBinding> {
    const sessionId = `room_${randomUUID().replaceAll('-', '_')}`
    const ensureHost = this.runtime.ensureStructuredAgentSessionHost?.bind(this.runtime)
    const resolveIntent = this.runtime.resolveStructuredAgentSessionCreateIntent?.bind(this.runtime)
    if (!ensureHost || !resolveIntent) {
      throw new Error('structured_agent_session_unsupported')
    }
    await ensureHost()
    const params = await resolveIntent({
      envelope: { sessionId, clientOperationId: structuredRoomOperationId() },
      worktree: `id:${worktreeId}`,
      agent: this.agent,
      ...(providerSessionId ? { providerSessionId } : {})
    })
    params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId,
      fields: attachFingerprintFields(params)
    })
    const result = await structuredRoomHost().attach(
      { callerKey: `trusted-local:room:${worktreeId}` },
      params
    )
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
    const created = createRoomMachineBinding(worktreeId, sessionId, 'created', providerSessionId)
    try {
      await structuredRoomHost().hold(sessionId, structuredRoomHolderId(created))
      await this.applyPreferences(created, options?.preferences)
      return created
    } catch (error) {
      await structuredRoomHost()
        .close(sessionId)
        .catch(() => undefined)
      throw error
    }
  }

  async locate(value: RoomMachineHarnessBinding): Promise<RoomMachineHarnessBinding | null> {
    try {
      const ensureHost = this.runtime.ensureStructuredAgentSessionHost?.bind(this.runtime)
      if (!ensureHost) {
        return null
      }
      await ensureHost()
      if (!structuredRoomHost().hasSession(value.conversationId)) {
        await structuredRoomHost().restoreReadableSessions([value.conversationId])
      }
      return structuredRoomHost().hasSession(value.conversationId)
        ? { ...value, disposition: 'adopted' }
        : null
    } catch {
      return null
    }
  }

  async read(value: RoomMachineHarnessBinding, limit = 200): Promise<RoomHarnessReadResult> {
    const result = structuredRoomHost().history({
      sessionId: value.conversationId,
      direction: 'tail',
      limit
    })
    return {
      messages: projectStructuredItemsToNativeChat(result.page.items),
      hasMore: result.page.hasOlder,
      beforeOffset: result.page.window.oldest?.sequence ?? 0
    }
  }

  async send(
    value: RoomMachineHarnessBinding,
    prompt: string,
    options?: { imagePaths?: readonly string[] }
  ): Promise<{ handle: string; accepted: boolean; bytesWritten: number }> {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ...(options?.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path }))
      ]
    }
    const result = await structuredRoomHost().send(structuredRoomCaller(value), {
      envelope: structuredRoomMutationEnvelope(value.conversationId, 'agentSession.send', { body }),
      body
    })
    return {
      handle: value.conversationId,
      accepted: result.ok && result.value.submission.dispatchState === 'accepted',
      bytesWritten: result.ok ? Buffer.byteLength(prompt) : 0
    }
  }

  async steer(
    value: RoomMachineHarnessBinding,
    prompt: string,
    options?: { imagePaths?: readonly string[] }
  ): Promise<{ handle: string; accepted: boolean; bytesWritten: number }> {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ...(options?.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path }))
      ]
    }
    const result = await structuredRoomHost().steer(structuredRoomCaller(value), {
      envelope: structuredRoomMutationEnvelope(value.conversationId, 'agentSession.steer', {
        body
      }),
      body
    })
    return {
      handle: value.conversationId,
      accepted: result.ok && result.value.submission.dispatchState === 'accepted',
      bytesWritten: result.ok ? Buffer.byteLength(prompt) : 0
    }
  }

  async interrupt(value: RoomMachineHarnessBinding): Promise<void> {
    const turnId = activeStructuredAgentSessionTurnId(
      readStructuredRoomState(value.conversationId).items
    )
    if (!turnId) {
      return
    }
    const result = await structuredRoomHost().cancel(structuredRoomCaller(value), {
      envelope: structuredRoomMutationEnvelope(value.conversationId, 'agentSession.cancel', {
        turnId
      }),
      turnId
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
  }

  compact(value: RoomMachineHarnessBinding) {
    return this.send(value, '/compact')
  }

  async stop(value: RoomMachineHarnessBinding) {
    await this.interrupt(value)
    structuredRoomHost().release(value.conversationId, structuredRoomHolderId(value))
    await structuredRoomHost().close(value.conversationId)
    return { handle: value.conversationId, tabId: value.conversationId, ptyKilled: true }
  }

  async restore(
    value: RoomMachineHarnessBinding,
    preferences?: RoomHarnessLaunchOptions['preferences']
  ): Promise<RoomMachineHarnessBinding> {
    if (!(await this.locate(value))) {
      const sourceSessionId = value.providerSession.sourceSessionId
      if (!sourceSessionId) {
        throw new Error('conversation_not_found')
      }
      return this.attach(value.worktreeId, preferences && { preferences }, sourceSessionId)
    }
    await structuredRoomHost().hold(value.conversationId, structuredRoomHolderId(value))
    return { ...value, disposition: 'adopted' }
  }

  async reconfigure(
    value: RoomMachineHarnessBinding,
    preferences: NonNullable<RoomHarnessLaunchOptions['preferences']>
  ): Promise<RoomMachineHarnessBinding> {
    await this.applyPreferences(value, preferences)
    return { ...value, disposition: 'adopted' }
  }

  async status(value: RoomMachineHarnessBinding) {
    return readMachineRoomStatus(value)
  }

  incarnation = (): null => null

  async awaitReady(value: RoomMachineHarnessBinding) {
    return readMachineRoomReady(value)
  }

  async awaitInputReady(value: RoomMachineHarnessBinding): Promise<boolean> {
    return machineRoomInputReady(value)
  }

  async context(
    value: RoomMachineHarnessBinding,
    current: RoomContextSnapshot
  ): Promise<RoomContextSnapshot> {
    return readMachineRoomContext(this.agent, value, current)
  }

  async lastTranscriptActivityAt(value: RoomMachineHarnessBinding): Promise<number> {
    return machineRoomLastActivityAt(value)
  }

  stageAttachment(
    value: RoomMachineHarnessBinding,
    attachment: { id: string; fileName: string; localPath: string }
  ): Promise<string> {
    return this.runtime.stageRoomAttachment(value.worktreeId, undefined, attachment)
  }

  subscribe(value: RoomMachineHarnessBinding, callbacks: RoomHarnessSubscriptionCallbacks) {
    return subscribeMachineRoomSession(value, callbacks)
  }

  private async applyPreferences(
    value: RoomMachineHarnessBinding,
    preferences?: RoomHarnessLaunchOptions['preferences']
  ): Promise<void> {
    await applyMachineRoomPreferences(value, preferences)
  }
}
