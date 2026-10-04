import { getClient, type Flags } from "../context.ts";
import { c, out, printJson } from "../output.ts";
import { resolveTask } from "../resolve.ts";
import type { FollowUpAction } from "../../shared/types.ts";

/**
 * The fork's board-level commands — what the Conductor agent (and anyone at a
 * terminal) uses to see the whole board and act on it:
 *
 *   agetor board                                  every live card, suggestions, leases
 *   agetor suggestions [apply <taskId> <id>]      rule-based fixes (the Needs you bar's Apply)
 *   agetor activity <id>                          a card's timeline
 *   agetor followups <id>                         follow-ups a finished pipeline offers
 *   agetor followup <id> <actionId> [--request <text>]   start one
 */
export async function cmdBoard(_args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  if (flags.json) return printJson(await client.call("GET", "/board/digest"));
  out(await client.call<string>("GET", "/board/digest?format=text"));
}

interface SuggestionRow {
  id: string;
  taskId: string;
  taskTitle: string;
  title: string;
  detail: string;
}

export async function cmdSuggestions(args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  if (args[0] === "apply") {
    const [, ref, id] = args;
    if (!ref || !id) throw new Error("usage: agetor suggestions apply <taskId> <suggestionId>");
    const task = await resolveTask(client, ref);
    const res = await client.call<{ message: string }>("POST", "/suggestions/apply", { taskId: task.id, id });
    return flags.json ? printJson(res) : out(`${c.green("✓")} ${res.message}`);
  }
  const list = await client.call<SuggestionRow[]>("GET", "/suggestions");
  if (flags.json) return printJson(list);
  if (list.length === 0) return out(c.dim("no suggestions"));
  for (const s of list) out(`${c.bold(s.taskTitle)} [${s.taskId.slice(0, 8)}] ${c.dim(s.id)}\n  ${s.title} — ${s.detail}`);
}

interface ActivityRow {
  ts: number;
  kind: string;
  text: string;
  url?: string;
}

export async function cmdActivity(args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  if (!args[0]) throw new Error("usage: agetor activity <id>");
  const task = await resolveTask(client, args[0]);
  const list = await client.call<ActivityRow[]>("GET", `/tasks/${encodeURIComponent(task.id)}/activity`);
  if (flags.json) return printJson(list);
  if (list.length === 0) return out(c.dim("no activity yet"));
  for (const e of list) {
    const when = new Date(e.ts).toLocaleString();
    out(`${c.dim(when)}  ${e.text}${e.url ? c.dim(`  ${e.url}`) : ""}`);
  }
}

export async function cmdFollowUps(args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  if (!args[0]) throw new Error("usage: agetor followups <id>");
  const task = await resolveTask(client, args[0]);
  const res = await client.call<{ actions: FollowUpAction[]; changedFiles: number }>(
    "GET",
    `/tasks/${encodeURIComponent(task.id)}/pipeline/followups`,
  );
  if (flags.json) return printJson(res);
  for (const a of res.actions) {
    const notes = [a.suggested ? "suggested" : null, a.requiresRequest ? "needs --request" : null].filter(Boolean).join(", ");
    out(`${c.bold(a.id)}  ${a.label} (${a.agentName})${notes ? c.dim(`  ${notes}`) : ""}`);
  }
}

export async function cmdFollowUp(args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  const positional: string[] = [];
  let request: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--request") request = args[++i];
    else positional.push(args[i]!);
  }
  const [ref, presetId] = positional;
  if (!ref || !presetId) throw new Error('usage: agetor followup <id> <actionId> [--request "<text>"]');
  const task = await resolveTask(client, ref);
  const res = await client.call<{ title?: string }>("POST", `/tasks/${encodeURIComponent(task.id)}/pipeline/followups`, {
    presetId,
    ...(request ? { request } : {}),
  });
  return flags.json ? printJson(res) : out(`${c.green("✓")} started ${presetId} on ${task.title}`);
}

interface BlockRow {
  pipeline: string;
  step: string;
  kind: string;
  count: number;
  lastAt: number;
  examples: { title: string; message: string }[];
}

/** `agetor blocks [--days N]` — what pipelines block on, most frequent first. */
export async function cmdBlocks(args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  const i = args.indexOf("--days");
  const days = i >= 0 ? Number(args[i + 1]) : 14;
  const rows = await client.call<BlockRow[]>("GET", `/blocks?days=${Number.isFinite(days) && days > 0 ? days : 14}`);
  if (flags.json) return printJson(rows);
  if (rows.length === 0) return out(c.dim("no blocks recorded"));
  for (const r of rows) {
    out(`${c.bold(String(r.count).padStart(3))}  ${r.pipeline} › ${r.step}  ${c.dim(r.kind)}  ${c.dim(`last ${new Date(r.lastAt).toLocaleString()}`)}`);
    for (const e of r.examples) out(`       ${c.dim(e.title.slice(0, 60))}: ${e.message.replace(/\s+/g, " ").slice(0, 140)}`);
  }
}
