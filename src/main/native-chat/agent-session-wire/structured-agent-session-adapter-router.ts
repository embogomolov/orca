import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { StructuredProviderConfiguration } from '../../../shared/structured-agent-provider'
import type { AgentSessionContextSnapshot } from '../../../shared/agent-session-context'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import type { MachineStructuredSessionAdapter } from '../../harness-conversation/machine-structured-session-adapter'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from './structured-agent-session-adapter'

type Lane = 'codex' | 'machine'

export class StructuredAgentSessionAdapterRouter implements StructuredAgentSessionAdapter {
  private readonly lanes = new Map<string, Lane>()

  constructor(
    private readonly codex: CodexStructuredSessionAdapter,
    private readonly machine: MachineStructuredSessionAdapter
  ) {}

  supportsCreate(location: AgentSessionExecutionLocation, agent: string): boolean {
    if (agent === 'codex') {
      return this.codex.supportsLocation?.(location) ?? false
    }
    return this.machine.supportsCreate?.(location, agent) ?? false
  }

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const lane = laneForIdentity(input.identity)
    const acquired = await this.adapter(lane).acquire(input)
    this.lanes.set(input.identity.sessionId, lane)
    return acquired
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    const lane = this.lanes.get(input.sessionId)
    if (!lane) {
      return true
    }
    const released = (await this.adapter(lane).releaseAcquisition?.(input)) === true
    if (released) {
      this.lanes.delete(input.sessionId)
    }
    return released
  }

  dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: Parameters<StructuredAgentSessionAdapter['dispatch']>[0]['body']
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    return this.sessionAdapter(input.sessionId).dispatch(input)
  }

  steer(input: Parameters<NonNullable<StructuredAgentSessionAdapter['steer']>>[0]) {
    const adapter = this.sessionAdapter(input.sessionId)
    return (
      adapter.steer?.(input) ??
      Promise.resolve({ state: 'rejected' as const, reason: 'conversation_steer_unsupported' })
    )
  }

  cancelTurn(input: { sessionId: string; turnId: string; fence: number }) {
    return this.sessionAdapter(input.sessionId).cancelTurn(input)
  }

  answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }) {
    return this.sessionAdapter(input.sessionId).answerPrompt(input)
  }

  setOption(input: StructuredAgentSessionSetOptionInput) {
    return this.sessionAdapter(input.sessionId).setOption(input)
  }

  readOptions(input: { sessionId: string; fence: number }): Promise<AgentSessionOptionsResult> {
    const adapter = this.sessionAdapter(input.sessionId)
    if (!adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    return adapter.readOptions(input)
  }

  historyFilePath(input: { identity: AgentSessionJournalIdentity }): Promise<string | null> {
    return (
      this.adapter(laneForIdentity(input.identity)).historyFilePath?.(input) ??
      Promise.resolve(null)
    )
  }

  closeSession = (sessionId: string): Promise<boolean> => this.close('closeSession', sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.close('forceCloseSession', sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.close('disposeSession', sessionId)

  readContext(sessionId: string): AgentSessionContextSnapshot | null {
    return this.machine.readContext(sessionId)
  }

  readConfiguration(sessionId: string): StructuredProviderConfiguration | null {
    return this.machine.readConfiguration(sessionId)
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.codex.closeAll(), this.machine.closeAll()])
    this.lanes.clear()
  }

  private async close(
    method: 'closeSession' | 'forceCloseSession' | 'disposeSession',
    sessionId: string
  ): Promise<boolean> {
    const lane = this.lanes.get(sessionId)
    if (!lane) {
      return true
    }
    const operation = this.adapter(lane)[method]
    const closed = operation ? await operation.call(this.adapter(lane), sessionId) : false
    if (closed) {
      this.lanes.delete(sessionId)
    }
    return closed
  }

  private sessionAdapter(sessionId: string): StructuredAgentSessionAdapter {
    const lane = this.lanes.get(sessionId)
    if (!lane) {
      throw new Error(`no structured adapter for session ${sessionId}`)
    }
    return this.adapter(lane)
  }

  private adapter(lane: Lane): StructuredAgentSessionAdapter {
    return lane === 'codex' ? this.codex : this.machine
  }
}

function laneForIdentity(identity: AgentSessionJournalIdentity): Lane {
  return identity.agent === 'codex' || identity.providerHandle.kind === 'codex'
    ? 'codex'
    : 'machine'
}
