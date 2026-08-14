import type { StructuredMachineAgent } from '../../../shared/structured-agent-provider'
import { getAgentCatalog } from '@/lib/agent-catalog'

export function structuredAgentLabel(agent: StructuredMachineAgent): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}
