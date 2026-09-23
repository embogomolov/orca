import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  hostTestAttachParams,
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from './structured-agent-session-host-test-data'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-provider-handle'

it.each(['codex', 'claude', 'omp'] as const)(
  'captures supplied %s metadata without an additional startup history probe',
  async (agent) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transcript-capture-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const handle: AgentSessionProviderHandle =
      agent === 'codex'
        ? { provider: 'codex', threadId: 'thread' }
        : agent === 'claude'
          ? { provider: 'claude', sessionId: 'thread', leafUuid: null }
          : { provider: 'acp', agent, sessionId: 'thread' }
    const historyFilePath = vi
      .fn<NonNullable<StructuredAgentSessionAdapter['historyFilePath']>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValue(new Error('unexpected extra filesystem lookup'))
    const adapter: StructuredAgentSessionAdapter = {
      acquire: async ({ fence }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: HOST_TEST_NOW - 1,
          spawnToken: 'spawn'
        },
        link: {
          linkId: 'link',
          handle,
          origin: 'created',
          mintedAtFence: fence,
          observedAt: HOST_TEST_NOW
        },
        ...(agent === 'omp' ? { transcriptPath: join(root, 'custom', 'parent.jsonl') } : {})
      }),
      historyFilePath,
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    }
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: root,
      claimKeyId: 'key',
      mintSpawnToken: () => 'spawn',
      now: () => HOST_TEST_NOW
    })
    try {
      const params = hostTestAttachParams(null, {
        agent,
        provider: handle.provider,
        providerHandle: undefined,
        accountHome: {
          variable:
            agent === 'codex' ? 'CODEX_HOME' : agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'HOME',
          path: root
        }
      })
      expect(await host.attach({ callerKey: 'client' }, params)).toMatchObject({ ok: true })
      expect(historyFilePath).toHaveBeenCalledTimes(1)
      expect(store.getRecord(HOST_TEST_SESSION)?.providerTranscript?.path).toBe(
        agent === 'omp' ? join(root, 'custom', 'parent.jsonl') : undefined
      )
    } finally {
      await host.flushAllStreamedEvents()
      await rm(root, { recursive: true, force: true })
    }
  }
)
