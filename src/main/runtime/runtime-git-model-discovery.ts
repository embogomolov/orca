import type { TuiAgent } from '../../shared/tui-agent'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  type DiscoverCommitMessageModelsResult
} from '../text-generation/commit-message-text-generation'
import {
  localAgentRuntimeTargetForTarget,
  type RuntimeCommitMessageSettingsOverride
} from './runtime-git-generation-context'
import { localGitOptionsForTarget, type RuntimeGitCommandHost } from './runtime-git-command-target'

export async function discoverRuntimeCommitMessageModels(
  host: RuntimeGitCommandHost,
  worktreeSelector: string,
  agentId: string,
  settingsOverride?: Pick<RuntimeCommitMessageSettingsOverride, 'agentCmdOverrides'>,
  includeSessionDefaults?: boolean
): Promise<DiscoverCommitMessageModelsResult> {
  const target = await host.resolveRuntimeGitTarget(worktreeSelector)
  const typedAgentId = agentId as TuiAgent
  const agentCommandOverride =
    settingsOverride?.agentCmdOverrides?.[typedAgentId] ??
    host.getRuntimeSettings().agentCmdOverrides?.[typedAgentId]
  if (target.connectionId) {
    const provider = getSshGitProvider(target.connectionId)
    if (!provider) {
      return { success: false, error: `No git provider for connection "${target.connectionId}"` }
    }
    return discoverCommitMessageModelsRemote(
      typedAgentId,
      target.worktree.path,
      (plan, cwd, timeoutMs) => provider.executeCommitMessagePlan(plan, cwd, timeoutMs),
      agentCommandOverride
    )
  }
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    typedAgentId,
    host.getCommitMessageAgentEnvironment?.(),
    localAgentRuntimeTargetForTarget(target)
  )
  if (!localEnv.ok) {
    return { success: false, error: localEnv.error }
  }
  const localOptions = localGitOptionsForTarget(target)
  return discoverCommitMessageModelsLocal(typedAgentId, localEnv.env, agentCommandOverride, {
    ...(localOptions.wslDistro
      ? { cwd: target.worktree.path, wslDistro: localOptions.wslDistro }
      : {}),
    includeSessionDefaults
  })
}
