import { randomBytes } from 'node:crypto'
import type {
  RoomAttachment,
  RoomContextSnapshot,
  RoomHarnessAgent,
  RoomProviderSession
} from '../../../shared/rooms'
import type {
  AgentLaunchPreferences,
  RuntimeCreateAgentSessionResult
} from '../../../shared/agent-session-host-authority'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalClose,
  RuntimeTerminalSend,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import {
  readNativeChatTranscriptTail,
  type NativeChatTranscriptSubscription
} from '../../native-chat/transcript-watch'
import { readRoomContext, readRoomTranscriptMtime } from './context-reader'
import { roomHarnessStatusEvent, type RoomHarnessLifecycleEvent } from './harness-lifecycle'
import type {
  RoomHarnessAdapter,
  RoomHarnessBinding,
  RoomHarnessReadResult,
  RoomHarnessRuntime,
  RoomHarnessSubscriptionCallbacks
} from './harness-adapter-types'
import { subscribeRoomHarnessTranscript } from './harness-transcript-subscription'

export { transcriptLifecycleEvent } from './harness-lifecycle'
export type { RoomHarnessActivityKind, RoomHarnessLifecycleEvent } from './harness-lifecycle'
export type {
  RoomHarnessAdapter,
  RoomHarnessBinding,
  RoomHarnessReadResult,
  RoomHarnessRuntime
} from './harness-adapter-types'

/** Nobody watches a room pane, so any interactive CLI nudge deadlocks its
 *  deliveries (probe honestly reports 'permission'). Codex pops a mid-session
 *  rate-limit model-switch modal — where Enter silently switches the model —
 *  and a startup update prompt; both are suppressed by documented config keys
 *  (unknown keys are tolerated by older CLIs, verified against the binary). */
const ROOM_AGENT_EXTRA_ARGS: Partial<Record<RoomHarnessAgent, string>> = {
  codex: '-c notice.hide_rate_limit_model_nudge=true -c check_for_update_on_startup=false'
}

export class PtyRoomHarnessAdapter implements RoomHarnessAdapter {
  constructor(
    readonly agent: RoomHarnessAgent,
    private readonly runtime: RoomHarnessRuntime
  ) {}

  async launch(
    worktreeId: string,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    const result = await this.runtime.createAgentSession({
      clientOperationId: `${Date.now()}-${randomBytes(16).toString('hex')}`,
      worktree: `id:${worktreeId}`,
      agent: this.agent,
      extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
      launchPreferences: preferences,
      presentation: 'background',
      viewMode: 'chat'
    })
    return this.binding(worktreeId, result.terminal, null, 'created')
  }

  async attach(binding: RoomHarnessBinding): Promise<RoomHarnessBinding> {
    const match = (await this.runtime.listRoomAttachableAgents(binding.worktreeId)).find(
      (candidate) =>
        candidate.agent === this.agent &&
        candidate.worktreeId === binding.worktreeId &&
        candidate.terminalHandle === binding.terminalHandle &&
        candidate.paneKey === binding.paneKey
    )
    if (!match) {
      throw new Error('room_agent_not_running')
    }
    return {
      worktreeId: match.worktreeId,
      terminalHandle: match.terminalHandle,
      paneKey: match.paneKey,
      providerSession: match.providerSession,
      disposition: 'attached'
    }
  }

  read(binding: RoomHarnessBinding, limit = 200): Promise<RoomHarnessReadResult> {
    const session = binding.providerSession
    if (!session) {
      return Promise.resolve({ error: 'Transcript unavailable', notFound: true })
    }
    return readNativeChatTranscriptTail({
      agent: this.agent,
      sessionId: session.id,
      transcriptPath: session.transcriptPath,
      limit
    })
  }

  send(
    binding: RoomHarnessBinding,
    prompt: string,
    options?: { clearInput?: boolean }
  ): Promise<RuntimeTerminalSend> {
    return options
      ? this.runtime.sendTerminalAgentPrompt(binding.terminalHandle, prompt, options)
      : this.runtime.sendTerminalAgentPrompt(binding.terminalHandle, prompt)
  }

  async prepareControl(binding: RoomHarnessBinding, command: string): Promise<void> {
    if (this.agent !== 'claude' || !/^\/fast (?:on|off)$/.test(command.trim())) {
      return
    }
    if (!this.runtime.sendTerminal) {
      throw new Error('room_agent_control_unsupported')
    }
    await this.runtime.sendTerminal(binding.terminalHandle, { text: '\x1b' })
    if (!(await this.awaitInputReady(binding))) {
      throw new Error('room_agent_not_ready')
    }
  }

  stop(binding: RoomHarnessBinding): Promise<RuntimeTerminalClose> {
    return this.runtime.closeTerminal(binding.terminalHandle, { force: true })
  }

  async resume(worktreeId: string, historyId: string): Promise<RoomHarnessBinding> {
    const session = await this.runtime.resolveRoomHistoricalSession(
      worktreeId,
      this.agent,
      historyId
    )
    return this.restore({ worktreeId, terminalHandle: '', paneKey: '', providerSession: session })
  }

  /** Foreground-verified lookup of the live pane hosting this binding's agent.
   *  Provider session survives pane replacement; pane identity is the fallback
   *  before the provider has assigned one. */
  async locate(binding: RoomHarnessBinding): Promise<RoomHarnessBinding | null> {
    const current = (await this.runtime.listRoomAttachableAgents(binding.worktreeId)).find(
      (candidate) =>
        candidate.agent === this.agent &&
        candidate.worktreeId === binding.worktreeId &&
        (binding.providerSession
          ? candidate.providerSession?.key === binding.providerSession.key &&
            candidate.providerSession.id === binding.providerSession.id
          : Boolean(binding.paneKey && candidate.paneKey === binding.paneKey))
    )
    if (!current) {
      return null
    }
    return {
      worktreeId: current.worktreeId,
      terminalHandle: current.terminalHandle,
      paneKey: current.paneKey,
      providerSession: current.providerSession,
      disposition: 'attached'
    }
  }

  async restore(
    binding: RoomHarnessBinding,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    const current = await this.locate(binding)
    if (current) {
      return current
    }
    if (!binding.providerSession) {
      return this.launch(binding.worktreeId, preferences)
    }
    return this.ensureLiveSession(binding.worktreeId, binding.providerSession, preferences)
  }

  /** Provider-session claims outlive their process: ensureAgentSession happily
   *  adopts a pane where the agent already died and only a shell remains. Any
   *  adoption must prove a live agent process; dead claim holders are killed
   *  and the session is re-ensured until it relaunches for real. */
  private async ensureLiveSession(
    worktreeId: string,
    providerSession: NonNullable<RoomHarnessBinding['providerSession']>,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    // Bounded by the realistic number of stale claim holders per thread.
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${worktreeId}`,
        agent: this.agent,
        providerSession,
        extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
        launchPreferences: preferences,
        presentation: 'background'
      })
      if (result.disposition !== 'adopted') {
        return this.binding(worktreeId, result.terminal, providerSession, 'created')
      }
      const status = await this.runtime
        .getTerminalAgentStatus(result.terminal.handle, { confirmForeground: true })
        .catch(() => null)
      if (status?.isRunningAgent) {
        return this.binding(worktreeId, result.terminal, providerSession, 'adopted')
      }
      await this.runtime.closeTerminal(result.terminal.handle, { force: true }).catch(() => {})
    }
    throw new Error('room_agent_session_unrecoverable')
  }

  async reconfigure(
    binding: RoomHarnessBinding,
    preferences: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    // A stale handle (hibernated participant) means the process is already gone.
    await this.stop(binding).catch(() => {})
    if (!binding.providerSession) {
      const result = await this.runtime.createAgentSession({
        clientOperationId: `${Date.now()}-${randomBytes(16).toString('hex')}`,
        worktree: `id:${binding.worktreeId}`,
        agent: this.agent,
        extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
        launchPreferences: preferences,
        presentation: 'background',
        viewMode: 'chat'
      })
      return this.binding(binding.worktreeId, result.terminal, null, 'created')
    }
    const ensured = await this.ensureLiveSession(
      binding.worktreeId,
      binding.providerSession,
      preferences
    )
    // Reconfiguration always requires readiness proof.
    return { ...ensured, disposition: 'created' }
  }

  status(binding: RoomHarnessBinding): Promise<RuntimeTerminalAgentStatus> {
    // Rooms paste prompts and block deliveries based on this status: title and
    // screen text survive an agent's death, so demand live-process evidence.
    return this.runtime.getTerminalAgentStatus(binding.terminalHandle, {
      confirmForeground: true
    })
  }

  incarnation(binding: RoomHarnessBinding): string | null {
    return this.runtime.getTerminalProcessIncarnation(binding.terminalHandle)
  }

  awaitReady(binding: RoomHarnessBinding): Promise<RuntimeTerminalWait> {
    return this.runtime.waitForTerminal(binding.terminalHandle, { condition: 'tui-idle' })
  }

  awaitInputReady(binding: RoomHarnessBinding): Promise<boolean> {
    return this.runtime.waitForTerminalAgentInputReady(binding.terminalHandle, this.agent)
  }

  context(binding: RoomHarnessBinding, current: RoomContextSnapshot): Promise<RoomContextSnapshot> {
    return binding.providerSession
      ? readRoomContext(this.agent, binding.providerSession, current)
      : Promise.resolve(current)
  }

  lastTranscriptActivityAt(binding: RoomHarnessBinding): Promise<number | null> {
    return binding.providerSession
      ? readRoomTranscriptMtime(this.agent, binding.providerSession)
      : Promise.resolve(null)
  }

  compact(binding: RoomHarnessBinding): Promise<RuntimeTerminalSend> {
    return this.runtime.compactTerminalAgentSession(binding.terminalHandle)
  }

  stageAttachment(
    binding: RoomHarnessBinding,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string> {
    return this.runtime.stageRoomAttachment(binding.worktreeId, binding.terminalHandle, attachment)
  }

  statusEvent(
    event: AgentHookEventPayload & { receivedAt: number }
  ): RoomHarnessLifecycleEvent | null {
    return roomHarnessStatusEvent(event)
  }

  subscribe(
    binding: RoomHarnessBinding,
    callbacks: RoomHarnessSubscriptionCallbacks
  ): Promise<NativeChatTranscriptSubscription> {
    return subscribeRoomHarnessTranscript(this.agent, binding, callbacks)
  }

  private binding(
    worktreeId: string,
    terminal: RuntimeCreateAgentSessionResult['terminal'],
    providerSession: RoomProviderSession | null,
    disposition: RoomHarnessBinding['disposition']
  ): RoomHarnessBinding {
    if (!terminal.paneKey) {
      throw new Error('room_agent_pane_unavailable')
    }
    return {
      worktreeId,
      terminalHandle: terminal.handle,
      paneKey: terminal.paneKey,
      providerSession,
      disposition
    }
  }
}

export function createRoomHarnessAdapters(
  runtime: RoomHarnessRuntime
): Record<RoomHarnessAgent, RoomHarnessAdapter> {
  return {
    claude: new PtyRoomHarnessAdapter('claude', runtime),
    openclaude: new PtyRoomHarnessAdapter('openclaude', runtime),
    codex: new PtyRoomHarnessAdapter('codex', runtime),
    grok: new PtyRoomHarnessAdapter('grok', runtime)
  }
}
