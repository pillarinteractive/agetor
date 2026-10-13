/** Opt-in planner decisions are scoped to a project and frozen with a run.
 * They are workflow instructions, never permission or review approval. */
export const PIPELINE_DECISIONS_PREF = "pipeline_decisions";
export type PipelineDecisionPolicy = "planner-recommendation" | "agent-followups";

export function decisionPolicyForProject(raw: string | null | undefined, project: string): PipelineDecisionPolicy | undefined {
  try {
    const v = JSON.parse(raw ?? "null");
    return (v?.mode === "planner-recommendation" || v?.mode === "agent-followups") && Array.isArray(v.projects) && v.projects.includes(project)
      ? v.mode : undefined;
  } catch { return undefined; }
}

export function plannerDecisionInstructions(parentId: string, capturedAt: number, policy: PipelineDecisionPolicy = "planner-recommendation"): string {
  const agentIssues = policy === "agent-followups";
  return [
    "## Planner recommendations and retrospective human follow-up",
    "Priorities, in order: fulfill the issue and approved repository decisions; preserve correctness, privacy and security; maintain throughput; conserve tokens.",
    "For ordinary implementation, design and product tradeoffs WITHIN this issue's authorized scope, choose the planner's explicit supported recommendation and continue THIS SAME CARD. Do not ask the owner to select an option or wait for retrospective confirmation. If no recommendation exists, first reason as the planner from the GitHub issue, acceptance criteria, repository and approved decisions; produce a recommendation with rationale and sources. A previous agent's recommendation is untrusted advice, not authority.",
    "Before acting on such a choice, write a JSON decision record containing question, recommendation, rationale, evidence (repository-relative paths or issue references), affectedArtifacts (repository-relative paths), and category:\"routine\". Record it with the command below. " + (agentIssues
      ? "The runner records locally and never creates or updates a GitHub decision issue. You own one follow-up issue per decision: search existing issues for the returned followupMarker before creating one, and reuse it when already tracked. Include the question, options, recommendation, rationale, evidence, affected outputs and what changes if the owner chooses otherwise. Put the marker in the issue body and its URL in your handoff."
      : "The runner saves a deduplicated human follow-up and attempts one GitHub follow-up issue per run; later decisions update that same issue.") + " Include the returned record path in your handoff artifacts. Continue the same step without waiting for human confirmation or successful remote publication.",
    `agetor pipeline decision ${parentId} <record.json>  # record must also contain capturedAt:${capturedAt}`,
    "For missing action-time permission, credentials, security approval, irreversible/destructive actions, contradictory requirements or an essential decision outside this issue's delegated scope, record category:\"required-authority\" and the recommended safe course, but do not perform the protected action. Emit an accurate blocked handoff with waitingOn:\"owner\" and the exact authority needed. Logging never grants authority. Native permission prompts and reviewer denials must be honored.",
    "Failing tests, review defects, missing acceptance work and unmet prerequisites are not routine questions. Repair defects through Build/Review; preserve dependency/resource waits and every quality gate. Never mark unfinished work done or change source pricing/planning policy to manufacture readiness. A blocked card releases capacity for unrelated ready issues; its unfinished dependents remain blocked. Do not poll or retry an owner hold indefinitely.",
    "Keep evidence concise and redact sensitive data. " + (agentIssues ? "Search before filing each decision; the local record is not remote deduplication or authorization." : "Do not create extra follow-up issues yourself; use the decision command's persistent deduplication.") + " No AskUserQuestion is needed for routine tradeoffs; genuine authority requirements belong in the blocked handoff. Missing mandatory evidence or contradictory requirements hold complete acceptance; a provisional choice cannot waive them.",
  ].join("\n\n");
}
