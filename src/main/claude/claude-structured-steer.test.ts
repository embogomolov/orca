import { describe, expect, it, vi } from 'vitest'
import {
  cancelPendingClaudeSteers,
  dispatchClaudeTurn,
  resolveClaudeReplayTurn
} from './claude-structured-dispatch'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import {
  childExited,
  sessionFor,
  userMessage,
  userReplayFrame
} from './claude-structured-dispatch-test-support'

function activeSession(send = vi.fn(async () => {})) {
  const session = sessionFor(send)
  session.translator = createClaudeJournalTranslator({
    sink: { appendItem: vi.fn(), appendTombstone: vi.fn(), publish: vi.fn() }
  })
  session.translator.handle({
    type: 'message',
    sessionId: 'session-1',
    startsTurn: true,
    message: userReplayFrame('root-1', 'work')
  })
  return session
}

const input = {
  turnId: 'root-1',
  clientMessageId: 'steer-1',
  body: userMessage([{ type: 'text', text: 'continue' }])
}

describe('Claude steer acknowledgement', () => {
  it('waits for replay and keeps the active turn identity', async () => {
    const send = vi.fn(async () => {})
    const session = activeSession(send)
    const settled = vi.fn()
    const pending = dispatchClaudeTurn(session, input).then(settled)
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ priority: 'next' }))
    expect(settled).not.toHaveBeenCalled()
    const uuid = session.dispatchWaiters[0]!.sentUuid
    expect(resolveClaudeReplayTurn(session, userReplayFrame(uuid, 'continue'))).toMatchObject({
      turn: { turnId: 'root-1' }
    })
    await pending
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'accepted',
        providerIdentity: expect.objectContaining({ turn: { turnId: 'root-1' } })
      })
    )
    expect(session.dispatchSequence).toBe(0)
  })

  it('opens a new root when the provider delivers after the targeted turn ended', async () => {
    const session = activeSession()
    const pending = dispatchClaudeTurn(session, input)
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    session.translator!.handle({
      type: 'ended',
      sessionId: 'session-1',
      cause: 'unexpected-exit',
      reason: 'test exit'
    })
    const uuid = session.dispatchWaiters[0]!.sentUuid
    expect(resolveClaudeReplayTurn(session, userReplayFrame(uuid, 'continue'))).toMatchObject({
      turn: { turnId: uuid, root: true }
    })
    await expect(pending).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { turn: { turnId: uuid, root: true } }
    })
  })

  it.each(['cancel', 'exit'])(
    'releases a pending steer on %s without claiming delivery',
    async (reason) => {
      const session = activeSession()
      const pending = dispatchClaudeTurn(session, input)
      await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
      if (reason === 'cancel') {
        cancelPendingClaudeSteers(session, 'root-1')
      } else {
        childExited(session)
      }
      await expect(pending).resolves.toMatchObject({ state: 'unknown' })
      expect(session.dispatchWaiters).toHaveLength(0)
    }
  )

  it('rejects stale turns without writing', async () => {
    const send = vi.fn(async () => {})
    const session = activeSession(send)
    await expect(dispatchClaudeTurn(session, { ...input, turnId: 'old' })).resolves.toEqual({
      state: 'rejected',
      reason: 'conversation_turn_mismatch'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps a late steer on its own turn (retired: %s)', async (retired) => {
    const session = activeSession()
    const settled = vi.fn()
    const pending = dispatchClaudeTurn(session, input)
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const uuid = session.dispatchWaiters[0]!.sentUuid
    if (retired) {
      cancelPendingClaudeSteers(session, 'root-1')
    }
    session.translator!.handle({
      type: 'message',
      sessionId: 'session-1',
      startsTurn: true,
      message: userReplayFrame('root-2', 'new work')
    })
    const turn = resolveClaudeReplayTurn(session, userReplayFrame(uuid, 'continue'), settled)
    expect(turn).toMatchObject({ turn: { turnId: 'root-1' } })
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIdentity: expect.objectContaining({ turn: { turnId: 'root-1' } })
      })
    )
    session.translator!.handle({
      type: 'message',
      sessionId: 'session-1',
      message: userReplayFrame(uuid, 'continue'),
      turn: turn?.turn
    })
    expect(session.translator!.currentTurnId).toBe('root-2')
    await expect(pending).resolves.toMatchObject({ state: retired ? 'unknown' : 'accepted' })
  })
})
