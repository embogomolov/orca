import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { RoomDatabase } from './database'
import { RoomTranscriptTurnState, selectRoomTranscriptFinal } from './transcript-turn-state'

function assistant(id: string, phase: 'commentary' | 'final', text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    assistantPhase: phase,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'stream'
  }
}

describe('selectRoomTranscriptFinal', () => {
  it('publishes only an explicitly confirmed final when phases are available', () => {
    const commentary = {
      message: assistant('commentary', 'commentary', 'Checking'),
      publishable: true
    }
    expect(selectRoomTranscriptFinal([commentary], 'Checking')).toEqual({
      candidate: null,
      body: null
    })

    const final = { message: assistant('final', 'final', 'Done'), publishable: true }
    expect(selectRoomTranscriptFinal([commentary, final], null)).toEqual({
      candidate: final,
      body: 'Done'
    })
  })

  it('selects only a response after the last same-turn steer', () => {
    const earlyFinal = { message: assistant('early', 'final', 'Early'), publishable: true }
    const steer: NativeChatMessage = {
      id: 'steer',
      role: 'user',
      blocks: [{ type: 'text', text: 'Change course' }],
      timestamp: 2,
      source: 'stream'
    }
    const afterSteer: NativeChatMessage = {
      id: 'after',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Changed' }],
      timestamp: 3,
      source: 'stream'
    }
    const pending = [
      earlyFinal,
      { message: steer, publishable: true },
      { message: afterSteer, publishable: true }
    ]

    expect(selectRoomTranscriptFinal(pending, 'Changed')).toEqual({
      candidate: pending[2],
      body: 'Changed'
    })
  })

  it('uses the terminal body instead of an unrelated unclassified response', () => {
    const checking = {
      message: {
        id: 'checking',
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'Checking' }],
        timestamp: 1,
        source: 'stream' as const
      },
      publishable: true
    }

    expect(selectRoomTranscriptFinal([checking], 'Done')).toEqual({
      candidate: null,
      body: 'Done'
    })
    expect(selectRoomTranscriptFinal([checking], null)).toEqual({
      candidate: checking,
      body: 'Checking'
    })
  })

  it('does not reuse a matching unclassified response from before a steer', () => {
    const early = {
      message: {
        id: 'early',
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'Done' }],
        timestamp: 1,
        source: 'stream' as const
      },
      publishable: true
    }
    const steer = {
      message: {
        id: 'steer',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Change course' }],
        timestamp: 2,
        source: 'stream' as const
      },
      publishable: true
    }

    expect(selectRoomTranscriptFinal([early, steer], 'Done')).toEqual({
      candidate: null,
      body: 'Done'
    })
  })
})

it('does not restore a settled activity as the next turn', () => {
  const database = new RoomDatabase(':memory:')
  try {
    const room = database.createRoom({ projectId: 'project', name: 'room' })
    const participant = database.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    database.activities.upsert({
      participantId: participant.id,
      identity: participant.identity,
      state: 'interrupted',
      kind: 'working',
      messages: [],
      startedAt: 100,
      updatedAt: 200,
      anchorSequence: null
    })
    const state = new RoomTranscriptTurnState(database, () => undefined)

    state.restore(participant)

    expect(state.entries(participant.id)).toEqual([])
    expect(database.activities.get(participant.id)).toBeNull()
  } finally {
    database.close()
  }
})
