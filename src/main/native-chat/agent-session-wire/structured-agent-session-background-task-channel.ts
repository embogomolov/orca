import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import { scopeStructuredSessionTranscript } from './structured-agent-session-transcript-scope'
import type {
  AgentSessionSubscribers,
  AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export class StructuredAgentSessionBackgroundTaskChannel {
  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    private readonly subscribers: AgentSessionSubscribers,
    private readonly requireSession: (sessionId: string) => StructuredAgentSessionHostSession,
    /** Task edges change the status summary too; the feed's equality check
     *  keeps a no-op re-projection from reaching subscribers. */
    private readonly onPublished: (sessionId: string) => void
  ) {}

  history(request: AgentSessionHistoryRequest): AgentSessionHistoryResult {
    const result = readStructuredAgentSessionHistoryResult({
      journal: this.requireSession(request.sessionId).journal,
      record: this.deps.store.getRecord(request.sessionId),
      request
    })
    const backgroundTasks = this.state(request.sessionId)
    const hostNow = this.deps.now?.() ?? Date.now()
    return {
      ...result,
      page: {
        ...result.page,
        hostNow,
        ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
      }
    }
  }

  subscribe(input: AgentSessionSubscribeInput): () => void {
    const session = this.requireSession(input.sessionId)
    const backgroundTasks = this.state(input.sessionId)
    return this.subscribers.open({
      ...input,
      emit: (event) => {
        if (event.type === 'end') {
          input.emit(event)
          return
        }
        const record = this.deps.store.getRecord(input.sessionId)
        input.emit(
          event.type === 'batch'
            ? {
                ...event,
                batch: {
                  ...event.batch,
                  items: scopeStructuredSessionTranscript(event.batch.items, record)
                }
              }
            : {
                ...event,
                page: {
                  ...event.page,
                  items: scopeStructuredSessionTranscript(event.page.items, record)
                }
              }
        )
      },
      journal: session.journal,
      fence: this.deps.store.getRecord(input.sessionId)?.lease.runtimeFence ?? 0,
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
    })
  }

  publish(sessionId: string, publishedState?: AgentSessionBackgroundTaskState | null): void {
    const session = this.sessions.get(sessionId)
    const state = publishedState !== undefined ? publishedState : this.state(sessionId)
    if (session && state !== undefined) {
      this.subscribers.backgroundTasks(sessionId, state, session.fence)
      this.onPublished(sessionId)
    }
  }

  private state(sessionId: string): AgentSessionBackgroundTaskState | null | undefined {
    return this.deps.adapter.backgroundTaskState?.(sessionId)
  }
}
