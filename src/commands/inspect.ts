import { inspectRepository } from "../policy/inspect";
import { loadTrustedSessionContext } from "../state/session";

export async function inspectLocal(cwd: string) {
  const context = await loadTrustedSessionContext(cwd);
  return inspectRepository({
    git: context.git,
    baselineCommit: context.session.baselineCommit,
    policySourceCommit: context.session.policySourceCommit,
    trustedPolicyHash: context.session.trustedPolicyHash,
    config: context.config,
    mode: "local",
  });
}
