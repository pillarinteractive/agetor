import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, tasks } from "./db.ts";
import { createGitHubIssue, repoForDir, updateGitHubIssue } from "./github.ts";
import { parseIssueUrl } from "../shared/issue-task.ts";
import { recordActivity } from "./activity.ts";

export interface DecisionRecord {
  question: string;
  recommendation: string;
  rationale: string;
  evidence: string[];
  affectedArtifacts: string[];
  category: "routine" | "required-authority";
  capturedAt: number;
}
interface Ledger {
  capturedAt: number;
  runStartedAt: number;
  records: Array<DecisionRecord & { id: string; recordedAt: number; revisions?: DecisionRecord[] }>;
  publication: "not-attempted" | "pending" | "published" | "uncertain" | "unavailable";
  issueNumber?: number;
  issueUrl?: string;
}
const claims = new Set<string>();
export function redactDecisionText(s: string): string {
  return s.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})/g, "[redacted]")
    .replace(/\b(?:password|secret|token|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, "[redacted]");
}
export function parseDecisionRecord(input: unknown): DecisionRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.category !== "routine" && o.category !== "required-authority") return null;
  if (!Number.isSafeInteger(o.capturedAt) || (o.capturedAt as number) <= 0) return null;
  const fields = ["question", "recommendation", "rationale"] as const;
  if (fields.some((f) => typeof o[f] !== "string" || !(o[f] as string).trim() || (o[f] as string).length > 4000)) return null;
  if (!Array.isArray(o.evidence) || !o.evidence.length || o.evidence.length > 16 || !Array.isArray(o.affectedArtifacts) || o.affectedArtifacts.length > 32) return null;
  if ([...o.evidence, ...o.affectedArtifacts].some((x) => typeof x !== "string" || !x.trim() || x.length > 300)) return null;
  return {
    question: redactDecisionText((o.question as string).trim()), recommendation: redactDecisionText((o.recommendation as string).trim()),
    rationale: redactDecisionText((o.rationale as string).trim()), evidence: o.evidence.map((x) => redactDecisionText(x.trim())),
    affectedArtifacts: o.affectedArtifacts.map((x) => redactDecisionText(x.trim())), category: o.category, capturedAt: o.capturedAt as number,
  };
}

/** Publish only runner-generated metadata, never arbitrary agent prose,
 * captured panes, credentials or private/local file content. Full redacted
 * recommendation/rationale/evidence remain in the local decision ledger. */
export function decisionIssueBody(parentId: string, issueUrl: string, ledger: Ledger): string {
  return [
    `Human follow-up for ${issueUrl}.`,
    "These are retrospective confirmations of planner recommendations, or requests for required authority. This issue does not block ordinary authorized choices and is not approval of protected actions.",
    `Inspect the recommendations, rationale, sources and affected artifacts on the owning Mac: \`agetor pipeline decisions ${parentId}\`.`,
    ...ledger.records.map((r) => `- Decision ${r.id}: ${r.category === "routine" ? "planner recommendation selected; human confirmation optional" : "required authority; protected action must remain blocked"}.`),
    `<!-- agetor-decision-followup:${parentId}:${ledger.runStartedAt} -->`,
  ].join("\n\n");
}
const ledgerPath = (id: string, at: number) => join(dataDir, "pipeline-runs", id, `decisions-${at}.json`);
function save(file: string, ledger: Ledger): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}
export function readPipelineDecisions(id: string): { path: string; ledger: Ledger | null } | { error: string } {
  const parent = tasks.get(id);
  if (!parent?.pipelineRun?.snapshot) return { error: "pipeline run not found" };
  const file = ledgerPath(parent.id, parent.pipelineRun.startedAt ?? parent.pipelineRun.snapshot.capturedAt);
  return { path: file, ledger: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
}
export interface DecisionDeps {
  repo: typeof repoForDir;
  create: typeof createGitHubIssue;
  update: typeof updateGitHubIssue;
}
const realDeps: DecisionDeps = { repo: repoForDir, create: createGitHubIssue, update: updateGitHubIssue };

/** Recording does not answer a modal, retry a task, approve a handoff or
 * modify pipeline state. A durable pending claim prevents duplicate remote
 * creates after crashes/timeouts; uncertainty requires reconciliation. */
export async function recordPipelineDecision(id: string, input: unknown, deps = realDeps): Promise<Record<string, unknown>> {
  const parent = tasks.get(id);
  const run = parent?.pipelineRun;
  const record = parseDecisionRecord(input);
  if (!record) return { error: "decision requires category, capturedAt, question, explicit recommendation, rationale, evidence and affectedArtifacts" };
  if (!parent || parent.archivedAt != null || run?.snapshot?.decisionPolicy !== "planner-recommendation") return { error: "planner decisions are not enabled for this run" };
  if (record.capturedAt !== run.snapshot.capturedAt || run.status !== "running" || run.active.length === 0) return { error: "run changed or is not executing; no decision recorded" };
  if (claims.has(id)) return { error: "a decision is already being recorded; retry this same record" };
  claims.add(id);
  try {
    const file = ledgerPath(id, run.startedAt ?? record.capturedAt);
    const ledger: Ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { capturedAt: record.capturedAt, runStartedAt: run.startedAt ?? record.capturedAt, records: [], publication: "not-attempted" };
    const key = createHash("sha256").update(record.question.toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 24);
    const prior = ledger.records.find((r) => r.id === key);
    // An identical request is a read, including after an uncertain network
    // result. Never replay a remote create or repeatedly update the issue.
    const comparable = (r: DecisionRecord) => JSON.stringify([r.question, r.recommendation, r.rationale, r.evidence, r.affectedArtifacts, r.category]);
    if (prior && comparable(prior) === comparable(record)) return { recorded: true, deduplicated: true, path: file, issueUrl: ledger.issueUrl, publication: ledger.publication, approvalGranted: false };
    if (prior) {
      if ((prior.revisions?.length ?? 0) >= 8) return { error: "decision revision limit reached; no additional publication attempted" };
      const previous: DecisionRecord = { question: prior.question, recommendation: prior.recommendation, rationale: prior.rationale, evidence: prior.evidence, affectedArtifacts: prior.affectedArtifacts, category: prior.category, capturedAt: prior.capturedAt };
      ledger.records[ledger.records.indexOf(prior)] = { ...record, id: key, recordedAt: Date.now(), revisions: [...(prior.revisions ?? []), previous] };
    } else {
      if (ledger.records.length >= 64) return { error: "decision ledger limit reached; no additional publication attempted" };
      ledger.records.push({ ...record, id: key, recordedAt: Date.now() });
    }
    save(file, ledger);
    recordActivity(id, { kind: "auto", text: `Recorded planner decision ${key} for human follow-up (${record.category}); no permission granted`, tone: "info" });
    const origin = parseIssueUrl(parent.issueUrl);
    const repo = origin?.provider === "github" && origin.host === "github.com" ? await deps.repo(parent.workdir) : null;
    if (!origin || !repo || origin.owner.toLowerCase() !== repo.owner.toLowerCase() || origin.repo.toLowerCase() !== repo.name.toLowerCase()) {
      ledger.publication = "unavailable";
    } else if (ledger.publication === "not-attempted" || (ledger.publication === "published" && ledger.issueNumber)) {
      const update = ledger.publication === "published";
      ledger.publication = "pending";
      save(file, ledger); // durable claim before any remote mutation
      const body = decisionIssueBody(id, `https://github.com/${origin.owner}/${origin.repo}/issues/${origin.number}`, ledger);
      try {
        const result = update
          ? await deps.update({ dir: parent.workdir, number: ledger.issueNumber!, body })
          : await deps.create({ dir: parent.workdir, title: `Human follow-up: planner decisions for #${origin.number} (${id.slice(0, 8)})`, body });
        if (result.ok) {
          ledger.issueNumber = result.item.number; ledger.issueUrl = result.item.htmlUrl; ledger.publication = "published";
        } else ledger.publication = "uncertain";
      } catch { ledger.publication = "uncertain"; }
    }
    save(file, ledger);
    return { recorded: true, deduplicated: false, path: file, issueUrl: ledger.issueUrl, publication: ledger.publication, approvalGranted: false };
  } finally { claims.delete(id); }
}
