import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSubagentSnapshot } from '../../shared/agent-status-types'
import type { HarnessConversationDriverSink } from './driver'

export class ClaudeConversationActivity {
  private readonly subagents = new Map<string, AgentSubagentSnapshot>()
  private currentModel: string | null = null
  private currentEffort: string | null = null
  private fastMode: boolean | null = null
  private usedTokens: number | null = null
  private maxTokens: number | null = null

  constructor(private readonly sink: HarnessConversationDriverSink) {}

  setInitialFastMode(state: string | undefined): void {
    this.fastMode = state === undefined ? null : state === 'on'
    this.publishContext()
  }

  setModel(model: string): void {
    this.currentModel = model
    this.publishContext()
  }

  setEffort(effort: string): void {
    this.currentEffort = effort
    this.publishContext()
  }

  observe(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.currentModel = message.model
      this.fastMode =
        message.fast_mode_state === undefined ? null : message.fast_mode_state === 'on'
      this.publishContext()
    } else if (message.type === 'assistant') {
      const usage = message.message.usage
      if ('effort' in message && typeof message.effort === 'string') {
        this.currentEffort = message.effort
      }
      if (message.message.model) {
        this.currentModel = message.message.model
      }
      if (usage) {
        this.usedTokens =
          usage.input_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
      }
      this.publishContext()
    } else if (message.type === 'system' && message.subtype === 'task_started') {
      this.updateTaskStarted(message)
    } else if (message.type === 'system' && message.subtype === 'task_progress') {
      this.updateTaskProgress(message)
    } else if (message.type === 'system' && message.subtype === 'task_updated') {
      this.updateTaskStatus(message.task_id, message.patch.status, message.patch.description)
    } else if (message.type === 'system' && message.subtype === 'task_notification') {
      this.updateTaskStatus(message.task_id, message.status)
    } else if (message.type === 'result') {
      this.publishUsage(message)
    }
  }

  private updateTaskStarted(message: {
    task_id: string
    description: string
    subagent_type?: string
    task_type?: string
  }): void {
    if (!message.subagent_type && message.task_type !== 'local_agent') {
      return
    }
    this.subagents.set(message.task_id, {
      id: message.task_id,
      agentType: message.subagent_type ?? 'agent',
      description: message.description,
      state: 'working',
      startedAt: Date.now()
    })
    this.publishSubagents()
  }

  private updateTaskProgress(message: {
    task_id: string
    description: string
    subagent_type?: string
  }): void {
    const current = this.subagents.get(message.task_id)
    if (!current && !message.subagent_type) {
      return
    }
    this.subagents.set(message.task_id, {
      id: message.task_id,
      ...(message.subagent_type || current?.agentType
        ? { agentType: message.subagent_type ?? current?.agentType }
        : {}),
      description: message.description || current?.description,
      state: 'working',
      startedAt: current?.startedAt ?? Date.now()
    })
    this.publishSubagents()
  }

  private updateTaskStatus(taskId: string, status?: string, description?: string): void {
    const current = this.subagents.get(taskId)
    if (!current) {
      return
    }
    this.subagents.set(taskId, {
      ...current,
      ...(description ? { description } : {}),
      state:
        status === 'failed'
          ? 'blocked'
          : status === 'pending' || status === 'paused'
            ? 'waiting'
            : status === 'running'
              ? 'working'
              : 'idle'
    })
    this.publishSubagents()
  }

  private publishSubagents(): void {
    this.sink.setSubagents([...this.subagents.values()])
  }

  private publishUsage(message: Extract<SDKMessage, { type: 'result' }>): void {
    this.maxTokens = this.currentModel
      ? (message.modelUsage[this.currentModel]?.contextWindow ?? this.maxTokens)
      : this.maxTokens
    this.publishContext()
  }

  private publishContext(): void {
    this.sink.setContext({
      model: this.currentModel,
      effort: this.currentEffort,
      fastMode: this.fastMode,
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      remainingTokens:
        this.maxTokens === null || this.usedTokens === null
          ? null
          : Math.max(0, this.maxTokens - this.usedTokens),
      usedPercent:
        this.maxTokens && this.usedTokens !== null
          ? Math.min(100, (this.usedTokens / this.maxTokens) * 100)
          : null,
      source: 'provider',
      observedAt: Date.now(),
      compaction: 'idle',
      compactionUpdatedAt: null
    })
  }
}
