import { describe, expect, it } from 'vitest'
import {
  canonicalNativeChatToolName,
  isSubagentToolName,
  nativeChatToolLabel
} from './native-chat-tool-name'

describe('native chat tool names', () => {
  it('uses the same label for transcript and namespaced hook tools', () => {
    expect(canonicalNativeChatToolName('spawn_agent')).toBe('spawnagent')
    expect(canonicalNativeChatToolName('collaborationspawn_agent')).toBe('spawnagent')
    expect(nativeChatToolLabel('collaborationspawn_agent')).toBe('Spawn subagent')
    expect(isSubagentToolName('collaborationwait_agent')).toBe(true)
  })

  it('labels provider tools and keeps dynamic tools readable', () => {
    expect(nativeChatToolLabel('webrun')).toBe('Search the web')
    expect(nativeChatToolLabel('WebSearch')).toBe('Search the web')
    expect(nativeChatToolLabel('mcp__sentry__find_issues')).toBe('Find issues')
  })
})
