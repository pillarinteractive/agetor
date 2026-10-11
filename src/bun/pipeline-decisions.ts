import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, tasks } from "./db.ts";
import { createGitHubIssue, repoForDir, updateGitHubIssue, type GitHubRepo } from "./github.ts";
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
  publicationDirty?: boolean;
  /** Frozen at first record, including before a repository lookup fails. */
  sourceIssue?: string | null;
  /** Frozen before the first remote mutation; never rebound from task metadata. */
  repository?: Readonly<GitHubRepo>;
  reconciliationRequired?: string;
  issueNumber?: number;
  issueUrl?: string;
}
const claims = new Set<string>();
function githubIssueIdentity(url: string | null | undefined): string | null {
  const issue = parseIssueUrl(url);
  return issue?.provider === "github" && issue.host === "github.com" && Number.isSafeInteger(issue.number)
    ? `https://github.com/${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}/issues/${issue.number}` : null;
}
function sameRepository(a: Readonly<GitHubRepo>, b: Readonly<GitHubRepo>): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
    && a.remoteHost.toLowerCase() === b.remoteHost.toLowerCase();
}
function belongsToRepository(url: string | null | undefined, repo: Readonly<GitHubRepo>, number?: number): boolean {
  const issue = parseIssueUrl(githubIssueIdentity(url));
  return !!issue && issue.owner === repo.owner.toLowerCase() && issue.repo === repo.name.toLowerCase()
    && (number === undefined || issue.number === number);
}
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
    const ledger: Ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
      capturedAt: record.capturedAt, runStartedAt: run.startedAt ?? record.capturedAt, records: [], publication: "not-attempted",
      sourceIssue: githubIssueIdentity(parent.issueUrl),
    };
    const reconcile = (reason: string, recorded = false): Record<string, unknown> => {
      ledger.reconciliationRequired = reason;
      save(file, ledger);
      return { error: `decision follow-up requires reconciliation: ${reason}`, recorded, path: file, issueUrl: ledger.issueUrl, publication: ledger.publication, reconciliationRequired: reason, approvalGranted: false };
    };
    if (ledger.reconciliationRequired) return reconcile(ledger.reconciliationRequired);
    if (ledger.runStartedAt !== (run.startedAt ?? record.capturedAt)) return reconcile("ledger belongs to another run");
    // Legacy ledgers cannot prove their original source issue. Do not infer
    // ownership from current mutable metadata, even for an unpublished retry.
    if (!Object.hasOwn(ledger, "sourceIssue")) return reconcile("ledger source ownership is missing");
    if (ledger.sourceIssue !== githubIssueIdentity(parent.issueUrl)) return reconcile("task source issue changed");
    if (ledger.repository && !belongsToRepository(ledger.sourceIssue, ledger.repository)) return reconcile("ledger repository does not own its source issue");
    if ((ledger.issueUrl !== undefined || ledger.publication === "published") && ledger.issueNumber === undefined) return reconcile("follow-up identity is incomplete");
    if (ledger.issueNumber !== undefined && ledger.publication === "not-attempted") return reconcile("follow-up publication state is inconsistent");
    if (ledger.issueNumber !== undefined && (!Number.isSafeInteger(ledger.issueNumber) || ledger.issueNumber <= 0 || !ledger.repository || !belongsToRepository(ledger.issueUrl, ledger.repository, ledger.issueNumber))) return reconcile("follow-up identity does not match ledger ownership");
    const key = createHash("sha256").update(record.question.toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 24);
    const prior = ledger.records.find((r) => r.id === key);
    // Record deduplication is separate from publication. A lookup that failed
    // before any mutation can safely retry; pending/uncertain writes cannot.
    const comparable = (r: DecisionRecord) => JSON.stringify([r.question, r.recommendation, r.rationale, r.evidence, r.affectedArtifacts, r.category]);
    const deduplicated = !!prior && comparable(prior) === comparable(record);
    const result = () => ({ recorded: true, deduplicated, path: file, issueUrl: ledger.issueUrl, publication: ledger.publication, reconciliationRequired: ledger.reconciliationRequired, approvalGranted: false });
    if (prior && !deduplicated) {
      if ((prior.revisions?.length ?? 0) >= 8) return { error: "decision revision limit reached; no additional publication attempted" };
      const previous: DecisionRecord = { question: prior.question, recommendation: prior.recommendation, rationale: prior.rationale, evidence: prior.evidence, affectedArtifacts: prior.affectedArtifacts, category: prior.category, capturedAt: prior.capturedAt };
      ledger.records[ledger.records.indexOf(prior)] = { ...record, id: key, recordedAt: Date.now(), revisions: [...(prior.revisions ?? []), previous] };
    } else if (!prior) {
      if (ledger.records.length >= 64) return { error: "decision ledger limit reached; no additional publication attempted" };
      ledger.records.push({ ...record, id: key, recordedAt: Date.now() });
    }
    if (!deduplicated) {
      ledger.publicationDirty = true;
      save(file, ledger);
      recordActivity(id, { kind: "auto", text: `Recorded planner decision ${key} for human follow-up (${record.category}); no permission granted`, tone: "info" });
    }
    if (ledger.publication !== "not-attempted" && ledger.publication !== "unavailable" && !(ledger.publication === "published" && ledger.issueNumber && ledger.publicationDirty)) return result();
    const origin = parseIssueUrl(ledger.sourceIssue);
    let repo;
    try { repo = origin?.provider === "github" && origin.host === "github.com" ? await deps.repo(parent.workdir) : null; }
    catch {
      if (githubIssueIdentity(tasks.get(id)?.issueUrl) !== ledger.sourceIssue) return reconcile("task source issue changed during repository lookup", true);
      return result(); // No mutation attempted; the same record can retry.
    }
    // Repository lookup yields. Recheck the source and run before claiming a
    // mutation; neither an old run nor a changed source can inherit the write.
    const current = tasks.get(id);
    if (githubIssueIdentity(current?.issueUrl) !== ledger.sourceIssue) return reconcile("task source issue changed during repository lookup", true);
    if (!current || current.archivedAt != null || current.workdir !== parent.workdir || current.pipelineRun?.startedAt !== run.startedAt || current.pipelineRun.snapshot?.capturedAt !== record.capturedAt || current.pipelineRun.status !== "running" || !current.pipelineRun.active.length) return { ...result(), error: "run changed before follow-up publication; no mutation attempted" };
    if (!origin || !repo || origin.owner.toLowerCase() !== repo.owner.toLowerCase() || origin.repo.toLowerCase() !== repo.name.toLowerCase() || (ledger.repository && !sameRepository(repo, ledger.repository))) {
      ledger.publication = "unavailable";
    } else {
      // Persist ownership with the pending claim. Subsequent updates use this
      // original identity, never the newly resolved repository's issue number.
      ledger.repository ??= Object.freeze({ owner: repo.owner, name: repo.name, remoteHost: repo.remoteHost });
      const verifiedRepo = Object.freeze({ ...ledger.repository });
      const update = !!ledger.issueNumber;
      ledger.publication = "pending";
      save(file, ledger); // durable claim before any remote mutation
      const body = decisionIssueBody(id, ledger.sourceIssue!, ledger);
      try {
        const result = update
          ? await deps.update({ dir: parent.workdir, number: ledger.issueNumber!, body }, verifiedRepo)
          : await deps.create({ dir: parent.workdir, title: `Human follow-up: planner decisions for #${origin.number} (${id.slice(0, 8)})`, body }, verifiedRepo);
        if (result.ok) {
          if (!Number.isSafeInteger(result.item.number) || result.item.number <= 0 || !belongsToRepository(result.item.htmlUrl, verifiedRepo, result.item.number) || (update && result.item.number !== ledger.issueNumber)) {
            ledger.publication = "uncertain";
            return reconcile("remote response does not match the bound follow-up identity", true);
          }
          ledger.issueNumber = result.item.number; ledger.issueUrl = githubIssueIdentity(result.item.htmlUrl)!; ledger.publication = "published"; ledger.publicationDirty = false;
        } else ledger.publication = "uncertain";
      } catch { ledger.publication = "uncertain"; }
      if (githubIssueIdentity(tasks.get(id)?.issueUrl) !== ledger.sourceIssue) return reconcile("task source issue changed during publication", true);
    }
    save(file, ledger);
    return result();
  } finally { claims.delete(id); }
}
