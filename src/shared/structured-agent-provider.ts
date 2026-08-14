import type { SessionOptionDescriptor } from './native-chat-session-options'

export const STRUCTURED_MACHINE_AGENTS = ['claude', 'codex', 'grok', 'omp'] as const
export type StructuredMachineAgent = (typeof STRUCTURED_MACHINE_AGENTS)[number]

export function isStructuredMachineAgent(agent: string): agent is StructuredMachineAgent {
  return (STRUCTURED_MACHINE_AGENTS as readonly string[]).includes(agent)
}

export type StructuredProviderPermission = {
  id: string
  itemId?: string
  revision?: number
  title: string
  detail?: string
  options: { id: string; label: string; kind: 'allow-once' | 'allow-always' | 'reject' }[]
}

export type StructuredProviderInput = {
  id: string
  itemId?: string
  revision?: number
  questions: {
    id: string
    header: string
    question: string
    options?: { label: string; description?: string }[]
    allowOther?: boolean
    secret?: boolean
    multiSelect?: boolean
  }[]
}

export type StructuredProviderConfiguration = {
  commands: { name: string; description?: string; inputHint?: string }[]
  options: SessionOptionDescriptor[]
  canCompact: boolean
  canFork: boolean
}
