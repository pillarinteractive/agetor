// Measure the stored-field part of the `GET /tasks` payload against a COPY
// of a real data dir (live decorations like subagent counts are tiny and
// left out):
//   cp ~/.agetor/agetor.sqlite* /tmp/agetor-copy/
//   AGETOR_DATA_DIR=/tmp/agetor-copy bun scripts/measure-task-list.ts [--fields]
// Never point it at the live ~/.agetor — importing db.ts runs migrations.
if (!process.env.AGETOR_DATA_DIR) throw new Error("set AGETOR_DATA_DIR to a COPY of the data dir");
const { tasks } = await import("../src/bun/db.ts");
const { FULL_TASK_LIST, archivedRowsFor, shapeTaskForList } = await import("../src/bun/task-list.ts");
type Opts = typeof FULL_TASK_LIST;
const size = (v: unknown) => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v)));
const build = (opts: Opts) =>
  tasks.list({ archived: archivedRowsFor(opts), includeIds: opts.includeIds }).map((t) => shapeTaskForList(t, opts));
const variants: Record<string, Opts> = {
  "GET /tasks (legacy full)": FULL_TASK_LIST,
  "?lean=1&archived=1": { lean: true, includeArchived: true, includeIds: [] },
  "?lean=1 (board poll)": { lean: true, includeArchived: false, includeIds: [] },
};
const all = tasks.list();
console.log(`tasks: ${all.length} (archived ${all.filter((t) => t.archivedAt != null).length})`);
for (const [name, opts] of Object.entries(variants)) {
  const t0 = performance.now();
  const rows = build(opts);
  const body = JSON.stringify(rows);
  const ms = performance.now() - t0;
  console.log(`${name.padEnd(28)} rows=${String(rows.length).padStart(5)} bytes=${Buffer.byteLength(body).toLocaleString().padStart(11)}  build+stringify=${ms.toFixed(0)}ms`);
}
if (process.argv.includes("--fields")) {
  const per: Record<string, number> = {};
  for (const r of build(variants["?lean=1 (board poll)"]!)) {
    for (const [k, v] of Object.entries(r)) per[k] = (per[k] ?? 0) + size(v);
    if (r.agentProfile) for (const [k, v] of Object.entries(r.agentProfile)) per[`agentProfile.${k}`] = (per[`agentProfile.${k}`] ?? 0) + size(v);
    for (const s of r.pipelineRun?.snapshot?.graph.steps ?? []) per["pipelineRun.graph.steps.instructions"] = (per["pipelineRun.graph.steps.instructions"] ?? 0) + size(s.instructions);
    if (r.pipelineRun) per["pipelineRun.history"] = (per["pipelineRun.history"] ?? 0) + size(r.pipelineRun.history);
  }
  console.log(Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 12));
}
