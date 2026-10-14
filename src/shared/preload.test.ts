import { describe, expect, test } from "bun:test";
import type { PipelineGraph } from "./types.ts";
import { newStep } from "./pipeline.ts";
import {
  PRELOAD_LIMITS, bounceDiffSection, buildSlices, diffSelection, estimateTokens, excludedPath, fenceFor, fileMapSection, fitDiff, fitLargestFirst,
  looksBinary, mapHeadMatches, parseFileMap, parseNumstat, planSlices, preloadKind, preloadReference, printable, slicesSection, splitDiff,
  staleMapNote,
  type FileRead, type SlicePlan,
} from "./preload.ts";

const HEAD = "98301de7e9bd90e34b310425e45244ef2c25a359";
const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
const text = (t: string): FileRead => ({ kind: "text", text: t });

describe("excludedPath", () => {
  const cases: [string, string | null][] = [
    ["src/bun/pipeline-runner.ts", null],
    ["docs/README.md", null],
    ["package.json", null],
    ["docs/plans/storage-journey-artifact-registry.json", null],
    ["pnpm-lock.yaml", "a lockfile"],
    ["apps/web/package-lock.json", "a lockfile"],
    ["bun.lock", "a lockfile"],
    ["go.sum", "a lockfile"],
    ["Cargo.lock", "a lockfile"],
    ["src/__snapshots__/cart.test.ts.snap", "a snapshot"],
    ["assets/logo.png", "a binary file"],
    ["native/libfoo.dylib", "a binary file"],
    ["packages/core-go/wire/journey/zz.pb.go", "generated"],
    ["web/static/app.min.js", "generated"],
    ["src/schema.generated.ts", "generated"],
    ["dist/index.js", "generated or vendored"],
    ["node_modules/react/index.js", "generated or vendored"],
    ["packages/schema/fixtures/wait-source/cases/a.json", "a JSON fixture"],
    ["packages/core-go/sanitize/testdata/dictionary.v2.json", "a JSON fixture"],
    ["packages/schema/fixtures/loader.ts", null],
  ];
  for (const [path, want] of cases) test(`${path} → ${want ?? "inlined"}`, () => expect(excludedPath(path)).toBe(want));
});

test("printable, looksBinary, fenceFor, estimateTokens", () => {
  expect(printable("a\r\nb\rc\x1b[31m\x00\td")).toBe("a\nb\nc[31m\td");
  expect(looksBinary("abc\x00def")).toBe(true);
  expect(looksBinary("plain")).toBe(false);
  expect(fenceFor("no ticks")).toBe("```");
  expect(fenceFor("a ``` b")).toBe("````");
  expect(fenceFor("a ````` b `` c")).toBe("``````");
  expect(estimateTokens("x".repeat(9))).toBe(3);
});

describe("parseFileMap", () => {
  test("the exact format: a header with HEAD, the five sections, every entry `path:L<start>-L<end>`", () => {
    const map = parseFileMap([
      "# File map — issue #974",
      "",
      "## Header",
      "- Issue: #974",
      `- HEAD: \`${HEAD}\``,
      "- Date: 2026-10-13",
      "",
      "## Touch points",
      "- `src/cart/total.ts:L12-L40` — the rounding",
      "- `src/cart/total.ts:L44-L60` and `src/cart/tax.ts:L1-L9`",
      "",
      "## Read for context",
      "- `src/cart/types.ts:L5-L30`",
      "",
      "## Registries and inventories",
      "- `docs/registry.json:L3-L3`",
      "",
      "## Tests",
      "- `src/cart/total.test.ts:L1-L80`",
      "",
      "## Ruled out",
      "- `src/cart/legacy.ts:L1-L20` — not on this path",
    ].join("\n"));
    expect(map.head).toBe(HEAD);
    expect(map.sections.map((s) => s.kind)).toEqual(["header", "header", "touch", "context", "registries", "tests", "ruled-out"]);
    const touch = map.sections[2]!;
    expect(touch.entries).toEqual([
      { path: "src/cart/total.ts", bare: false, ranges: [{ start: 12, end: 40, must: 40 }] },
      { path: "src/cart/total.ts", bare: false, ranges: [{ start: 44, end: 60, must: 60 }] },
      { path: "src/cart/tax.ts", bare: false, ranges: [{ start: 1, end: 9, must: 9 }] },
    ]);
  });

  describe("the header's commit, as today's maps write it", () => {
    const cases: [string, string, string | null][] = [
      ["a bullet with the full sha", `## Header\n- Branch: \`feature/x\`\n- HEAD: \`${HEAD}\` (remote merge)`, HEAD],
      ["no heading, a short sha", "Header: commit `edd6b51a` on `feature/issue-1454`.\n\n## Touch points", "edd6b51a"],
      ["`commit:` under the heading", `## Header\ncommit: ${HEAD} (Build round 6)`, HEAD],
      ["`Build HEAD:` before any heading", `Build HEAD: \`${HEAD}\`. Implementation commit \`76c8c790\`.`, HEAD],
      ["the sha on the next line", `Every range is as of HEAD\n\`${HEAD}\`.\n\n## Header\n- Branch: \`x\``, HEAD],
      ["a plain `Header` line", `Header\n- HEAD: \`${HEAD}\`\n\nTouch points (card scope)\n- \`a/b.go:1-9\``, HEAD],
      ["HEAD wins over an earlier commit", `- Predecessor commit \`4b0afce3\`\n- HEAD: \`${HEAD}\``, HEAD],
      ["a commit named only in a later section is not the header's", `## Header\n- Branch: \`x\`\n\n## Round 8 (HEAD ${HEAD})`, null],
      ["a word of hex letters is not a commit", "## Header\nHEAD: defaced", null],
      ["none", "## Header\n- Issue: #1\n", null],
    ];
    for (const [name, map, want] of cases) test(name, () => expect(parseFileMap(map).head).toBe(want));
  });

  describe("entries, as today's maps write them", () => {
    const one = (item: string) => parseFileMap(`## Touch points\n${item}`).sections[1]!.entries;
    const cases: { name: string; item: string; want: unknown }[] = [
      {
        name: "ranges inside the quotes, with an en dash and several stretches",
        item: "- `apps/cli/install.go:375–380,463–471` — Agent-only",
        want: [{ path: "apps/cli/install.go", bare: false, ranges: [{ start: 375, end: 380, must: 380 }, { start: 463, end: 471, must: 471 }] }],
      },
      {
        name: "`path:L12-40` and `path:L12`",
        item: "- `src/a.ts:L12-40`, `src/b.ts:L12`",
        want: [
          { path: "src/a.ts", bare: false, ranges: [{ start: 12, end: 40, must: 40 }] },
          { path: "src/b.ts", bare: false, ranges: [{ start: 7, end: 52, must: 12, around: 12 }] },
        ],
      },
      {
        name: "a range after the quotes",
        item: "- `.github/scripts/ci_policy.py` :277–279 web contract",
        want: [{ path: ".github/scripts/ci_policy.py", bare: false, ranges: [{ start: 277, end: 279, must: 279 }] }],
      },
      {
        name: "`(new, 1–496)` and lines named beside symbols belong to the path before them",
        item: "- `.github/scripts/validate.py` (new, 1–496): the validator. `PROFILE` at :27, `evaluate` :88.",
        want: [{
          path: ".github/scripts/validate.py", bare: false,
          ranges: [{ start: 1, end: 496, must: 496 }, { start: 22, end: 67, must: 27, around: 27 }, { start: 83, end: 128, must: 88, around: 88 }],
        }],
      },
      {
        name: "single lines in brackets, and `(~:595)`",
        item: "- `docs/README.md` (modified, :96) and `.github/scripts/test_ci_policy.py` (~:595)",
        want: [
          { path: "docs/README.md", bare: false, ranges: [{ start: 91, end: 136, must: 96, around: 96 }] },
          { path: ".github/scripts/test_ci_policy.py", bare: false, ranges: [{ start: 590, end: 635, must: 595, around: 595 }] },
        ],
      },
      {
        name: "a path with no range, a symbol, a branch name, a glob and a command are told apart",
        item: "- `docs/guide.md` documents `FILE_CONTRACTS` on `feature/issue-974-x`; see `cases/*.json`, `pnpm schema:generate`, `ci_policy.select`",
        want: [{ path: "docs/guide.md", bare: false, ranges: [] }, { path: "ci_policy.select", bare: true, ranges: [] }],
      },
      {
        name: "paths without quotes, when they have a directory and an extension",
        item: "- packages/schema/src/vocabulary.ts — COMPONENTS gains `desktop`. Regenerated: packages/schema/wire.v1.json, see src/a.ts:L3-L9.",
        want: [
          { path: "packages/schema/src/vocabulary.ts", bare: false, ranges: [] },
          { path: "packages/schema/wire.v1.json", bare: false, ranges: [] },
          { path: "src/a.ts", bare: false, ranges: [{ start: 3, end: 9, must: 9 }] },
        ],
      },
      {
        name: "what is not a range: a hash, a time, an issue, a version",
        item: "- `src/a.ts` sha256:12 at 10:30 for #812: v1:2, TS2322",
        want: [{ path: "src/a.ts", bare: false, ranges: [] }],
      },
      {
        name: "a reversed range and line 0 are dropped; a path that leaves the worktree is not a path",
        item: "- `src/a.ts:40-12`, `src/b.ts:0`, `../secrets/key.pem:1-3`, `/etc/passwd:1-3`",
        want: [{ path: "src/a.ts", bare: false, ranges: [] }, { path: "src/b.ts", bare: false, ranges: [] }],
      },
      {
        name: "a wrapped bullet is one item",
        item: "- `src/a.ts` holds the parser,\n  whose entry point is at :14",
        want: [{ path: "src/a.ts", bare: false, ranges: [{ start: 9, end: 54, must: 14, around: 14 }] }],
      },
    ];
    for (const c of cases) test(c.name, () => expect(one(c.item)).toEqual(c.want as never));
  });

  test("sections are told by their first words; unknown ones are kept apart", () => {
    const kinds = (title: string) => parseFileMap(`## ${title}\n- \`a/b.ts\``).sections[1]!.kind;
    const cases: [string, string][] = [
      ["Touch points (all done)", "touch"], ["Additional touch points confirmed by Review", "touch"], ["Touch points — code changed this round", "touch"],
      ["Read for context", "context"], ["Registries and inventories (updated)", "registries"], ["Tests changed", "tests"],
      ["Ruled out / corrected", "ruled-out"], ["Round 5", "other"], ["Known unrelated state", "other"], ["Header", "header"],
    ];
    for (const [title, want] of cases) expect(`${title}: ${kinds(title)}`).toBe(`${title}: ${want}`);
  });
});

test("mapHeadMatches: the full sha or a prefix of at least seven characters, in any case", () => {
  const cases: [string | null, string | null, boolean][] = [
    [HEAD, HEAD, true], [HEAD.slice(0, 8), HEAD, true], [HEAD.slice(0, 7).toUpperCase(), HEAD, true], [HEAD.slice(0, 6), HEAD, false],
    ["0000000", HEAD, false], [null, HEAD, false], [HEAD, null, false], [`${HEAD.slice(0, 39)}0`, HEAD, false],
  ];
  for (const [map, head, want] of cases) expect(mapHeadMatches(map, head)).toBe(want);
});

describe("planSlices", () => {
  const map = (body: string) => parseFileMap(`## Header\n- HEAD: \`${HEAD}\`\n\n${body}`);

  test("touch points first, then context; stretches that touch are one; context a touch point covers is not asked for twice", () => {
    const plan = planSlices(map([
      "## Read for context", "- `src/types.ts:L1-L20`", "- `src/total.ts:L15-L30` — the caller",
      "## Touch points", "- `src/total.ts:L10-L40`", "- `src/total.ts:L42-L50`", "- `src/tax.ts:L5`",
    ].join("\n")));
    expect(plan.requests).toEqual([
      { path: "src/total.ts", bare: false, section: "touch", start: 10, end: 50, must: 50 },
      { path: "src/tax.ts", bare: false, section: "touch", start: 1, end: 45, must: 5, around: 5 },
      { path: "src/types.ts", bare: false, section: "context", start: 1, end: 20, must: 20 },
    ]);
  });

  test("a path under Ruled out is never asked for, wherever else the map lists it", () => {
    const plan = planSlices(map([
      "## Touch points", "- `docs/README.md:L90-L99`", "- `src/a.ts:L1-L5`",
      "## Read for context", "- `src/legacy.ts:L1-L50`",
      "## Ruled out", "- `docs/README.md` is read by other validators only", "- `src/legacy.ts:L1-L50` — dead code",
    ].join("\n")));
    expect(plan.requests.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(plan.ruledOut).toEqual(["docs/README.md", "src/legacy.ts"]);
  });

  test("entries without a range are listed, not sliced; tests and registries are never sliced", () => {
    const plan = planSlices(map(["## Touch points", "- `src/new-file.ts` (new)", "## Tests", "- `src/a.test.ts:L1-L80`", "## Registries and inventories", "- `docs/reg.json:L1-L9`"].join("\n")));
    expect(plan.requests).toEqual([]);
    expect(plan.unranged).toEqual([{ path: "src/new-file.ts", section: "touch" }]);
  });
});

describe("buildSlices", () => {
  const plan = (requests: Partial<SlicePlan["requests"][number]>[], more: Partial<SlicePlan> = {}): SlicePlan => ({
    requests: requests.map((r) => ({ path: "src/a.ts", bare: false, section: "touch", start: 1, end: 3, must: r.end ?? 3, ...r })),
    ruledOut: [], unranged: [], ...more,
  });

  test("a range inside the file is inlined exactly; the heading's numbers are the lines read", () => {
    const got = buildSlices(plan([{ start: 2, end: 4 }]), new Map([["src/a.ts", text(`${numbered(10)}\n`)]]));
    expect(got).toEqual({ slices: [{ path: "src/a.ts", section: "touch", start: 2, end: 4, text: "line 2\nline 3\nline 4" }], named: [] });
  });

  describe("what is named instead of inlined", () => {
    const cases: { name: string; plan: SlicePlan; file?: FileRead; path?: string; want: { what: string; why: RegExp; trimmed: boolean }[] }[] = [
      { name: "the file is not there", plan: plan([{}]), file: { kind: "missing" }, want: [{ what: "src/a.ts", why: /not in the worktree/, trimmed: false }] },
      { name: "a bare name that is no file was a symbol: nothing is said", plan: plan([{ path: "ci_policy.select", bare: true }]), path: "ci_policy.select", file: { kind: "missing" }, want: [] },
      { name: "the range runs past the end of the file", plan: plan([{ start: 8, end: 14 }]), want: [{ what: "src/a.ts:L8-L14", why: /past the end of the file \(10 lines\) — the map is out of date/, trimmed: false }] },
      { name: "the one line the map names is past the end", plan: plan([{ start: 15, end: 60, must: 20, around: 20 }]), want: [{ what: "src/a.ts:L20", why: /past the end/, trimmed: false }] },
      { name: "a binary file", plan: plan([{}]), file: { kind: "binary" }, want: [{ what: "src/a.ts", why: /binary/, trimmed: false }] },
      { name: "a link out of the worktree", plan: plan([{}]), file: { kind: "outside" }, want: [{ what: "src/a.ts", why: /not a regular file inside the worktree/, trimmed: false }] },
      { name: "a file too large to read", plan: plan([{}]), file: { kind: "too-large", bytes: 2_500_000 }, want: [{ what: "src/a.ts", why: /2,500,000 bytes/, trimmed: true }] },
      { name: "a lockfile, whatever range the map gives", plan: plan([{ path: "pnpm-lock.yaml" }]), path: "pnpm-lock.yaml", want: [{ what: "pnpm-lock.yaml", why: /a lockfile/, trimmed: false }] },
      { name: "a JSON fixture", plan: plan([{ path: "pkg/fixtures/case.json" }]), path: "pkg/fixtures/case.json", want: [{ what: "pkg/fixtures/case.json", why: /JSON fixture/, trimmed: false }] },
      { name: "a path under Ruled out", plan: plan([], { ruledOut: ["docs/README.md"] }), want: [{ what: "docs/README.md", why: /Ruled out/, trimmed: false }] },
      { name: "an entry with no range", plan: plan([], { unranged: [{ path: "src/a.ts", section: "touch" }] }), want: [{ what: "src/a.ts", why: /no line range/, trimmed: false }] },
    ];
    for (const c of cases) {
      test(c.name, () => {
        const got = buildSlices(c.plan, new Map([[c.path ?? "src/a.ts", c.file ?? text(numbered(10))]]));
        expect(got.slices).toEqual([]);
        expect(got.named.map((n) => ({ what: n.what, trimmed: n.trimmed }))).toEqual(c.want.map((w) => ({ what: w.what, trimmed: w.trimmed })));
        c.want.forEach((w, i) => expect(got.named[i]!.why).toMatch(w.why));
      });
    }
  });

  test("a window around one line is cut at the end of the file; a slice over the line cap is named", () => {
    const files = new Map([["src/a.ts", text(numbered(30))], ["src/big.ts", text(numbered(900))]]);
    const got = buildSlices(plan([{ start: 15, end: 60, must: 20, around: 20 }, { path: "src/big.ts", start: 1, end: 629, must: 629 }]), files);
    expect(got.slices.map((s) => `${s.path}:${s.start}-${s.end}:${s.around}`)).toEqual(["src/a.ts:15-30:20"]);
    expect(got.named).toEqual([{ what: "src/big.ts:L1-L629", why: "629 lines, over the 400-line cap for one slice", trimmed: true }]);
  });

  test("over the budget the largest slices go first, context before any touch point, and each is named", () => {
    const files = new Map([["a.ts", text(numbered(100, "aaaaaaaa"))], ["b.ts", text(numbered(100, "bbbbbbbb"))], ["c.ts", text(numbered(100, "cccccccc"))], ["d.ts", text(numbered(100, "dddddddd"))]]);
    const requests = plan([
      { path: "a.ts", start: 1, end: 10, must: 10 }, { path: "b.ts", start: 1, end: 60, must: 60 }, { path: "c.ts", start: 1, end: 20, must: 20 },
      { path: "d.ts", section: "context", start: 1, end: 5, must: 5 }, { path: "d.ts", section: "context", start: 50, end: 80, must: 80 },
    ]);
    const size = (path: string) => buildSlices(plan([requests.requests.find((r) => r.path === path)!]), files).slices[0]!.text.length;
    // Room for a, c and the small context range; not for b, nor for the large context range.
    const got = buildSlices(requests, files, { budgetChars: size("a.ts") + size("c.ts") + 70 });
    expect(got.slices.map((s) => `${s.path}:L${s.start}-L${s.end}`)).toEqual(["a.ts:L1-L10", "c.ts:L1-L20", "d.ts:L1-L5"]);
    expect(got.named.map((n) => n.what)).toEqual(["b.ts:L1-L60", "d.ts:L50-L80"]);
    expect(got.named.every((n) => n.trimmed && /over what is left of the .*-token budget for slices/.test(n.why))).toBe(true);
    // The budget is a ceiling on what is inlined.
    expect(got.slices.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThanOrEqual(size("a.ts") + size("c.ts") + 70);
    // With the whole budget every one of them fits.
    expect(buildSlices(requests, files).named).toEqual([]);
  });
});

test("fitLargestFirst keeps the order given, drops the largest until the rest fits, and drops nothing that fits", () => {
  const items = ["bb", "aaaaa", "c", "dddd"];
  const size = (s: string) => s.length;
  const cases: [number, string[], string[]][] = [
    [100, items, []], [12, items, []], [11, ["bb", "c", "dddd"], ["aaaaa"]], [3, ["bb", "c"], ["aaaaa", "dddd"]], [0, [], items],
  ];
  for (const [budget, kept, dropped] of cases) expect(fitLargestFirst(items, size, budget)).toEqual({ kept, dropped });
});

const DIFF = [
  "diff --git a/src/total.ts b/src/total.ts",
  "index 1111111..2222222 100644",
  "--- a/src/total.ts",
  "+++ b/src/total.ts",
  "@@ -10,7 +10,8 @@ export function total(cart: Cart): number {",
  "   const sum = cart.items.reduce(add, 0);",
  "-  return sum;",
  "+  const rounded = round(sum);",
  "+  return rounded;",
  " }",
  "@@ -40 +41,2 @@ class Tax",
  "+  rate = 0.2;",
  "diff --git a/docs/notes.md b/docs/notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+Rounded.",
].join("\n");

describe("the diff", () => {
  test("parseNumstat reads counts, binaries and renames", () => {
    expect(parseNumstat("3\t1\tsrc/total.ts\n-\t-\tassets/logo.png\n2\t0\tsrc/{old => new}/a.ts\n0\t0\told.md => new.md\nnot a row")).toEqual([
      { path: "src/total.ts", added: 3, deleted: 1, binary: false },
      { path: "assets/logo.png", added: 0, deleted: 0, binary: true },
      { path: "src/new/a.ts", added: 2, deleted: 0, binary: false },
      { path: "new.md", added: 0, deleted: 0, binary: false },
    ]);
  });

  test("diffSelection asks git only for what is inlined, and names the rest with the reason", () => {
    const got = diffSelection(parseNumstat("3\t1\tsrc/total.ts\n900\t880\tpnpm-lock.yaml\n-\t-\tassets/logo.png\n40\t0\tsrc/__snapshots__/a.snap\n12\t3\tpkg/fixtures/case.json\n5\t5\tsrc/api.generated.ts"));
    expect(got.paths).toEqual(["src/total.ts"]);
    expect(got.named).toEqual([
      { what: "pnpm-lock.yaml", why: "a lockfile (+900 −880)", trimmed: false },
      { what: "assets/logo.png", why: "a binary file", trimmed: false },
      { what: "src/__snapshots__/a.snap", why: "a snapshot (+40 −0)", trimmed: false },
      { what: "pkg/fixtures/case.json", why: "a JSON fixture (+12 −3)", trimmed: false },
      { what: "src/api.generated.ts", why: "generated (+5 −5)", trimmed: false },
    ]);
  });

  test("splitDiff gives each file its text and each hunk its lines and what git says it is inside", () => {
    const files = splitDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/total.ts", "docs/notes.md"]);
    expect(files.map((f) => f.text).join("\n")).toBe(DIFF);
    expect(files[0]!.hunks).toEqual([
      { start: 10, end: 17, inside: "export function total(cart: Cart): number {" },
      { start: 41, end: 42, inside: "class Tax" },
    ]);
    expect(files[1]!.hunks).toEqual([{ start: 1, end: 2, inside: "" }]);
    expect(splitDiff("")).toEqual([]);
    expect(splitDiff('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"\n+x').map((f) => f.path)).toEqual(['"a/caf\\303\\251.md" "b/caf\\303\\251.md"']);
  });

  test("fitDiff names a file over the per-file cap, then the largest until the rest fits", () => {
    const file = (path: string, size: number) => ({ path, text: "x".repeat(size), hunks: [] });
    const files = [file("a", 30), file("huge", 500), file("b", 80), file("c", 40)];
    const got = fitDiff(files, { budgetChars: 100, fileChars: 200 });
    expect(got.files.map((f) => f.path)).toEqual(["a", "c"]);
    expect(got.named.map((n) => `${n.what}|${n.trimmed}`)).toEqual(["huge|true", "b|true"]);
    expect(got.named[0]!.why).toBe("its diff is 125 tokens, over the 50-token cap for one file");
    expect(got.named[1]!.why).toBe("its diff is 20 tokens, over what is left of the 25-token budget for the diff");
    expect(fitDiff(files, { budgetChars: 1_000, fileChars: 1_000 })).toEqual({ files, named: [] });
  });
});

describe("preloadKind", () => {
  const step = (name: string) => newStep({ name });
  const [understand, build, review, finish, other] = [step("Understand"), step("Build"), step("Review"), step("Finish"), step("Notes")];
  const edge = (from: { id: string }, to: { id: string }, label = "") => ({ id: `${from.id}-${to.id}`, from: from.id, to: to.id, label });
  const core = [edge(understand, build, "build"), edge(build, review), edge(review, build, "changes requested"), edge(review, finish, "approved"), edge(finish, build, "verification failed")];
  const today: PipelineGraph = { steps: [understand, build, review, finish], edges: [...core, edge(understand, finish, "trivial change made")], startStepId: understand.id };
  const synced: PipelineGraph = { steps: [understand, build, review, finish], edges: [...core, edge(understand, review, "trivial change made")], startStepId: understand.id };
  const visit = (s: { id: string }) => ({ stepId: s.id });

  for (const [name, graph] of [["trivial → Finish (today)", today], ["trivial → Review (after the prompt sync)", synced]] as const) {
    describe(name, () => {
      const cases: { name: string; step: { id: string }; history: { stepId: string }[]; want: ReturnType<typeof preloadKind> }[] = [
        { name: "Build straight after Understand", step: build, history: [visit(understand)], want: "build-first" },
        { name: "Build after two Understand visits (a retry)", step: build, history: [visit(understand), visit(understand)], want: "build-first" },
        { name: "Build with an empty history", step: build, history: [], want: "build-first" },
        { name: "Build sent back by Review", step: build, history: [visit(understand), visit(build), visit(review)], want: "build-bounce" },
        { name: "Build sent back by Finish (a CI failure)", step: build, history: [visit(understand), visit(build), visit(review), visit(finish)], want: "build-bounce" },
        { name: "Build after a Build that was cancelled or failed", step: build, history: [visit(understand), visit(build)], want: "build-bounce" },
        { name: "Build after the trivial route went through Review or Finish, with no Build yet", step: build, history: [visit(understand), visit(review)], want: "build-bounce" },
        { name: "Build after only Finish ran (trivial → Finish, then verification failed)", step: build, history: [visit(understand), visit(finish)], want: "build-bounce" },
        { name: "Review", step: review, history: [visit(understand), visit(build)], want: null },
        { name: "Understand", step: understand, history: [], want: null },
        { name: "Finish", step: finish, history: [visit(understand), visit(build), visit(review)], want: null },
      ];
      for (const c of cases) test(c.name, () => expect(preloadKind(graph, c.step, c.history)).toBe(c.want));
    });
  }

  test("a pipeline that is not Build → Review → Finish is never pre-loaded", () => {
    const graph: PipelineGraph = { steps: [build, other], edges: [edge(build, other)], startStepId: build.id };
    expect(preloadKind(graph, build, [])).toBeNull();
    expect(preloadKind(null, build, [])).toBeNull();
  });
});

describe("the prompt sections", () => {
  test("fileMapSection inlines the map whole, or its start with a line saying where the rest is", () => {
    const whole = fileMapSection({ mapPath: "/g/agetor/file-map.md", text: "# File map\n\n## Touch points\n- `a/b.ts:L1-L2`\n" });
    expect(whole.startsWith("## File map\n\nThe card's file map (/g/agetor/file-map.md), in full unless marked.")).toBe(true);
    expect(whole).toContain("```markdown\n# File map\n\n## Touch points\n- `a/b.ts:L1-L2`\n```");
    expect(whole).not.toContain("trimmed:");
    const long = fileMapSection({ mapPath: "/g/agetor/file-map.md", text: numbered(500), budgetChars: 200, note: "A note." });
    expect(long).toContain("\n\nA note.\n\n");
    expect(long).toMatch(/- trimmed: read \/g\/agetor\/file-map\.md yourself from line \d+ \(the map is [\d,]+ tokens, over the 50-token budget for it\)$/);
    const inlined = /```markdown\n([\s\S]*?)\n```/.exec(long)![1]!;
    expect(inlined.length).toBeLessThanOrEqual(200);
    expect(numbered(500).startsWith(inlined)).toBe(true);
  });

  test("slicesSection heads each slice `path:L<start>-L<end>`, fences it safely, and lists what was left out", () => {
    const section = slicesSection({
      head: HEAD,
      slices: [
        { path: "src/total.ts", section: "touch", start: 12, end: 13, text: "const a = `x`;\n```not a fence```" },
        { path: "src/tax.ts", section: "context", start: 1, end: 45, around: 5, text: "tax" },
      ],
      named: [
        { what: "src/big.ts:L1-L629", why: "629 lines, over the 400-line cap for one slice", trimmed: true },
        { what: "pnpm-lock.yaml", why: "a lockfile", trimmed: false },
      ],
    })!;
    expect(section).toContain(`as they are at HEAD ${HEAD}`);
    expect(section).toContain("### src/total.ts:L12-L13\n\n````\nconst a = `x`;\n```not a fence```\n````");
    expect(section).toContain("### src/tax.ts:L1-L45 (around L5, the one line the map names) — read for context\n\n```\ntax\n```");
    expect(section).toEndWith("Not inlined:\n- trimmed: read src/big.ts:L1-L629 yourself (629 lines, over the 400-line cap for one slice)\n- not inlined: pnpm-lock.yaml — a lockfile");
    expect(slicesSection({ head: HEAD, slices: [], named: [] })).toBeNull();
    expect(slicesSection({ head: HEAD, slices: [], named: [{ what: "a", why: "b", trimmed: false }] })).toContain("None of the file map's ranges could be inlined");
  });

  test("staleMapNote says which commit the map is for, or that it names none", () => {
    expect(staleMapNote("edd6b51a", HEAD)).toContain(`written for commit edd6b51a and the worktree is at ${HEAD}`);
    expect(staleMapNote(null, HEAD)).toContain("names no commit");
    for (const note of [staleMapNote("edd6b51a", HEAD), staleMapNote(null, null)]) expect(note).toContain("no code was inlined by them");
  });

  test("bounceDiffSection inlines the diff and warns off the map's line numbers; nothing to show is no section", () => {
    const section = bounceDiffSection({ base: "origin/develop", head: HEAD, files: splitDiff(DIFF), named: [{ what: "pnpm-lock.yaml", why: "a lockfile (+9 −8)", trimmed: false }] })!;
    expect(section.startsWith("## What this branch changes so far\n\n`git diff -U10 origin/develop...HEAD` at HEAD")).toBe(true);
    expect(section).toContain("trust the diff, not the map's numbers");
    expect(section).toContain(`\`\`\`diff\n${DIFF}\n\`\`\``);
    expect(section).toEndWith("Not inlined:\n- not inlined: pnpm-lock.yaml — a lockfile (+9 −8)");
    expect(bounceDiffSection({ base: "origin/develop", head: HEAD, files: [], named: [] })).toBeNull();
  });

  test("preloadReference names the files and inlines nothing", () => {
    expect(preloadReference({ mapPath: "/g/agetor/file-map.md" })).toEqual({ card: "## File map\n\nThe card's file map is at /g/agetor/file-map.md.", visit: null });
    expect(preloadReference({ mapPath: null })).toEqual({ card: null, visit: null });
  });
});

describe("composeStepPrompt with pre-loaded sections", () => {
  const step = newStep({ name: "Build", instructions: "Build it." });
  const args = {
    pipelineName: "Change", step, stepIndex: 2, stepCap: 14, goal: "The goal.", outgoing: [{ name: "Review", label: "" }], transition: "choose" as const,
    subagentProfiles: [], subagentCap: null, inlineHandoff: true, parallelSiblings: [], nonce: "abcd1234",
    previous: [{ stepName: "Understand", handoff: null, filePath: "/data/handoff.json" }],
  };

  test("with nothing pre-loaded the prompt is byte for byte the prompt without the parameter", async () => {
    const { composeStepPrompt } = await import("./pipeline.ts");
    const plain = composeStepPrompt(args);
    for (const preload of [undefined, null, { card: null, visit: null }, { card: "", visit: "" }]) {
      expect(composeStepPrompt({ ...args, preload })).toBe(plain);
    }
  });

  test("the map follows the goal; what was read for this visit follows the context and comes before the step's instructions", async () => {
    const { composeStepPrompt } = await import("./pipeline.ts");
    const plain = composeStepPrompt(args);
    const prompt = composeStepPrompt({ ...args, preload: { card: "## File map\n\nMAP", visit: "## Code at the file map's ranges\n\nSLICES" } });
    const order = ["## Overall goal", "## File map", "## Context from previous step(s)", "## Code at the file map's ranges", "## Your step", "## Handoff (required)"].map((h) => prompt.indexOf(`\n\n${h}\n\n`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nothing else moved or changed: taking the two sections out gives the plain prompt.
    expect(prompt.replace("\n\n## File map\n\nMAP", "").replace("\n\n## Code at the file map's ranges\n\nSLICES", "")).toBe(plain);
  });
});
