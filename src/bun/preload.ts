/**
 * Pre-loading a step's first turn — the effectful half of
 * src/shared/preload.ts: read the card's file map, the worktree and the
 * branch's diff when a Build or Review is launched, and write Review's
 * bundle file. Read-only towards git and the working tree; the one file it
 * writes is `<git dir>/agetor/review-bundle.md`, beside the file map and
 * outside the working tree.
 *
 * Nothing here may fail a launch: `stepPreload` answers null when anything
 * it needs cannot be read, and the step starts as it always did.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PipelineGraph, PipelineStep, Task } from "../shared/types.ts";
import {
  PRELOAD_LIMITS, bounceDiffSection, buildSlices, diffSelection, fileMapSection, fitDiff, looksBinary, mapHeadMatches, parseFileMap,
  parseNumstat, planSlices, preloadKind, preloadReference, renderReviewBundle, reviewBundleSections, slicesSection, splitDiff, staleMapNote,
  type DiffFile, type DiffStat, type FileRead, type Named, type PreloadKind, type PreloadSections,
} from "../shared/preload.ts";
import { checkDeps } from "./check-runner.ts";

/** Git, the base branch and the clock — the checks' own, so one test setup
 *  covers both; replaceable in tests. */
export const preloadDeps = {
  git: (args: string[], cwd: string) => checkDeps.git(args, cwd),
  base: (checkout: string): Promise<string> => checkDeps.base(checkout),
  now: (): number => Date.now(),
};

/** A map larger than this is not a map. */
const MAP_MAX_BYTES = 512_000;
/** Files of one diff asked of git by name; beyond it the rest are named. */
const DIFF_MAX_FILES = 300;
/** The bundle file holds the diff whole, short of a file or a change that
 *  would make it unreadable. */
const BUNDLE_FILE_CHARS = 200_000;
const BUNDLE_DIFF_CHARS = 2_000_000;

export const FILE_MAP_NAME = "file-map.md";
export const REVIEW_BUNDLE_NAME = "review-bundle.md";

/** `<git dir>/agetor` of a checkout: where Understand writes the file map. */
async function agetorDir(checkout: string): Promise<string | null> {
  const r = await preloadDeps.git(["rev-parse", "--absolute-git-dir"], checkout);
  return r.ok && r.stdout ? join(r.stdout, "agetor") : null;
}

function readSmall(path: string, maxBytes: number): string | null {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= maxBytes ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** A file of the worktree as a slice may use it. A path that leaves the
 *  worktree (`..`, a link out of it) is never read. */
function readForSlice(checkout: string, path: string): FileRead {
  try {
    const root = realpathSync(checkout);
    const full = resolve(root, path);
    if (!existsSync(full)) return { kind: "missing" };
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + sep)) return { kind: "outside" };
    const st = statSync(real);
    if (!st.isFile()) return { kind: "outside" };
    if (st.size > PRELOAD_LIMITS.maxFileBytes) return { kind: "too-large", bytes: st.size };
    const text = readFileSync(real, "utf8");
    return looksBinary(text) ? { kind: "binary" } : { kind: "text", text };
  } catch {
    return { kind: "missing" };
  }
}

interface BranchDiff {
  /** The base as a step would write it: `origin/develop`. */
  base: string;
  baseTip: string | null;
  stats: DiffStat[];
  files: DiffFile[];
  named: Named[];
}

/** `git diff -U<context> <base>...HEAD` without the files that are never
 *  inlined, which are named instead. Null when there is no base to diff against. */
async function branchDiff(task: Task, checkout: string, context: number): Promise<BranchDiff | null> {
  // Paths as they are, not octal-quoted: they are compared and passed back.
  const git = (args: string[]) => preloadDeps.git(["-c", "core.quotePath=false", ...args], checkout);
  const base = await preloadDeps.base(checkout).catch(() => null);
  let ref: string | null = null;
  let baseTip: string | null = null;
  // The base as the checks resolve it (`readWorktree`, src/bun/check-runner.ts): as last fetched, nothing is fetched here.
  for (const candidate of [base ? `refs/remotes/origin/${base}` : null, task.baseRef ?? null, base ? `refs/heads/${base}` : null]) {
    if (!candidate) continue;
    const tip = await git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    if (tip.ok && tip.stdout) {
      ref = candidate;
      baseTip = tip.stdout;
      break;
    }
  }
  if (!ref) return null;
  const numstat = await git(["diff", "--numstat", "--no-renames", `${ref}...HEAD`]);
  if (!numstat.ok) return null;
  const stats = parseNumstat(numstat.stdout);
  const selection = diffSelection(stats);
  const asked = selection.paths.slice(0, DIFF_MAX_FILES);
  const named = [...selection.named];
  for (const path of selection.paths.slice(DIFF_MAX_FILES)) named.push({ what: path, why: `the change touches more than ${DIFF_MAX_FILES} files`, trimmed: true });
  let files: DiffFile[] = [];
  if (asked.length > 0) {
    const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-renames", `-U${context}`, `${ref}...HEAD`, "--", ...asked.map((p) => `:(literal)${p}`)]);
    if (!diff.ok) return null;
    files = splitDiff(diff.stdout);
  }
  return { base: ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, ""), baseTip, stats, files, named };
}

export interface StepPreload {
  kind: PreloadKind;
  /** The sections for a prompt that can be as long as it needs to be. */
  inline: PreloadSections;
  /** What a harness with a short prompt gets instead: where the files are. */
  reference: PreloadSections;
  /** Review's bundle file, when one was written. */
  bundlePath: string | null;
}

/**
 * What to add to the prompt of this launch of `step`, or null: not a Build
 * or Review of a reviewed pipeline, nothing to add, or something that could
 * not be read. `history` is the run's history before this launch. Whether
 * the card is covered (`pipeline_gates`) is the caller's question.
 */
export async function stepPreload(input: {
  parent: Task;
  graph: PipelineGraph;
  step: PipelineStep;
  history: readonly { stepId: string }[];
  stepNumber: number;
}): Promise<StepPreload | null> {
  const kind = preloadKind(input.graph, input.step, input.history);
  const checkout = input.parent.worktreePath ?? input.parent.workdir;
  if (!kind || !checkout) return null;
  const dir = await agetorDir(checkout);
  const headRead = await preloadDeps.git(["rev-parse", "--verify", "--quiet", "HEAD"], checkout);
  const head = headRead.ok && headRead.stdout ? headRead.stdout : null;
  if (!dir || !head) return null;
  const mapPath = join(dir, FILE_MAP_NAME);
  const mapText = readSmall(mapPath, MAP_MAX_BYTES);

  if (kind === "build-first") {
    // Without a map there is nothing to point at: the step explores as before.
    if (mapText === null) return null;
    const map = parseFileMap(mapText);
    if (!mapHeadMatches(map.head, head)) {
      return {
        kind, bundlePath: null, reference: preloadReference({ mapPath, bundlePath: null }),
        inline: { card: fileMapSection({ mapPath, text: mapText, note: staleMapNote(map.head, head) }), visit: null },
      };
    }
    const plan = planSlices(map);
    const files = new Map<string, FileRead>();
    for (const path of new Set([...plan.requests.map((r) => r.path), ...plan.unranged.map((u) => u.path)])) files.set(path, readForSlice(checkout, path));
    const built = buildSlices(plan, files);
    return {
      kind, bundlePath: null, reference: preloadReference({ mapPath, bundlePath: null }),
      inline: { card: fileMapSection({ mapPath, text: mapText }), visit: slicesSection({ head, slices: built.slices, named: built.named }) },
    };
  }

  if (kind === "build-bounce") {
    const diff = await branchDiff(input.parent, checkout, 10);
    const fitted = diff ? fitDiff(diff.files) : null;
    const card = mapText === null ? null : fileMapSection({
      mapPath, text: mapText,
      note: "Its line numbers were right for the commit its header names and may have moved since: no code is inlined by them on this visit.",
    });
    const visit = diff && fitted ? bounceDiffSection({ base: diff.base, head, files: fitted.files, named: [...diff.named, ...fitted.named] }) : null;
    if (card === null && visit === null) return null;
    return { kind, bundlePath: null, inline: { card, visit }, reference: preloadReference({ mapPath: mapText === null ? null : mapPath, bundlePath: null }) };
  }

  // Review: one bundle, written for this visit, whatever sent the work here
  // — Build, or Understand's trivial change with no Build at all.
  const diff = await branchDiff(input.parent, checkout, 5);
  const whole = diff ? fitDiff(diff.files, { budgetChars: BUNDLE_DIFF_CHARS, fileChars: BUNDLE_FILE_CHARS }) : null;
  const bundle = {
    cardTitle: input.parent.title, goal: input.parent.prompt, issueUrl: input.parent.issueUrl ?? null, stepNumber: input.stepNumber,
    writtenAt: new Date(preloadDeps.now()).toISOString(), head, base: diff?.base ?? "the base", baseTip: diff?.baseTip ?? null,
    mapPath, map: mapText, stats: diff?.stats ?? [], files: whole?.files ?? [],
    named: diff && whole ? [...diff.named, ...whole.named] : [{ what: "the diff", why: "no local ref for the base branch, or git could not diff against it", trimmed: false }],
  };
  let bundlePath: string | null = join(dir, REVIEW_BUNDLE_NAME);
  try {
    mkdirSync(dir, { recursive: true });
    // Written beside and renamed: a reader never sees half a bundle.
    writeFileSync(`${bundlePath}.tmp`, renderReviewBundle(bundle));
    renameSync(`${bundlePath}.tmp`, bundlePath);
  } catch {
    bundlePath = null;
  }
  return {
    kind, bundlePath, inline: reviewBundleSections({ ...bundle, bundlePath }),
    reference: preloadReference({ mapPath: mapText === null ? null : mapPath, bundlePath }),
  };
}
