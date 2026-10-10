/**
 * The board's blocker lines: which cards a hovered card waits on and which
 * it blocks, and the geometry of the connectors drawn between them
 * (src/mainview/components/kanban/BlockerLines.tsx). Pure — no DOM.
 *
 * Roadmap steps come from Autopilot's status (`RoadmapStepLinks`, by card
 * id); a card's manual `card_dependencies` (`blockedBy` / `blocking`) are
 * drawn the same way.
 */
import { linkWaits, roadmapLinkStateLabel, type RoadmapLinkStep, type RoadmapStepLinks } from "../../shared/roadmap.ts";
import type { Task } from "../../shared/types.ts";

/** A connector between two cards, pointing the way the work flows: from
 *  the card that has to finish to the card that waits on it. */
export interface BlockerEdge {
  from: string;
  to: string;
  /** waits — the hovered card (or, further up the chain, one it waits on)
   *  waits on `from`; blocks — `to` waits on the hovered card (or on one it
   *  blocks). */
  kind: "waits" | "blocks";
  /** 1 = a direct link of the hovered card; more = further along the chain. */
  depth: number;
  /** The card at the far end from the hovered one, named for a clipped line. */
  label: string;
}

/** A row in the hover panel. */
export interface BlockerRow {
  key: string;
  /** "3 · #13 Build the widget store" */
  text: string;
  /** "in flight", "open in another milestone (M02)", … */
  state: string;
  /** Its card, when it has one on the board (a line is drawn to it). */
  taskId: string | null;
  /** A predecessor that is complete: listed, no longer in the way. */
  done: boolean;
}

export interface BlockerView {
  /** "Step 5" for a roadmap step's card; null for a card with only manual links. */
  step: string | null;
  edges: BlockerEdge[];
  waits: BlockerRow[];
  blocks: BlockerRow[];
  moreWaits: number;
  moreBlocks: number;
  /** Following the chain further would add lines (hold Shift). */
  hasChain: boolean;
}

const MAX_EDGES = 48;
const MAX_DEPTH = 8;

const rowOf = (l: RoadmapLinkStep, kind: "waits" | "blocks"): BlockerRow => ({
  key: `${kind}:${l.step}`,
  text: `${l.step} · #${l.issue} ${l.title}`,
  state: roadmapLinkStateLabel(l) + (l.note ? ` — noted: ${l.note}` : ""),
  taskId: l.taskId,
  done: kind === "waits" && !linkWaits(l),
});

/**
 * What hovering `taskId` shows: its direct predecessors and successors (the
 * panel's rows, and a line to each that has a card), and with `transitive`
 * the chain behind them. Null when the card has no links at all.
 */
export function blockerView(
  taskId: string,
  links: ReadonlyMap<string, RoadmapStepLinks>,
  task: Pick<Task, "blockedBy" | "blocking"> | null | undefined,
  opts: { transitive?: boolean } = {},
): BlockerView | null {
  const own = links.get(taskId) ?? null;
  const manualWaits = (task?.blockedBy ?? []).filter((d) => !d.satisfied);
  const manualBlocks = task?.blocking ?? [];
  if (!own && manualWaits.length === 0 && manualBlocks.length === 0) return null;

  const edges: BlockerEdge[] = [];
  const seen = new Set<string>();
  const add = (e: BlockerEdge) => {
    const key = `${e.from}>${e.to}`;
    if (e.from === e.to || seen.has(key) || edges.length >= MAX_EDGES) return;
    seen.add(key);
    edges.push(e);
  };
  const label = (l: RoadmapLinkStep) => `step ${l.step} · #${l.issue}`;
  let hasChain = false;

  // Up the chain: what this card waits on, then what those wait on.
  const walk = (entry: RoadmapStepLinks, kind: "waits" | "blocks", depth: number, visited: Set<string>) => {
    for (const l of kind === "waits" ? entry.predecessors.filter(linkWaits) : entry.successors) {
      if (!l.taskId || !entry.taskId) continue;
      const nextEntry = links.get(l.taskId);
      const further = !!nextEntry && (kind === "waits" ? nextEntry.predecessors.some((p) => linkWaits(p) && p.taskId) : nextEntry.successors.some((p) => p.taskId));
      if (depth === 1 || opts.transitive) add(kind === "waits" ? { from: l.taskId, to: entry.taskId, kind, depth, label: label(l) } : { from: entry.taskId, to: l.taskId, kind, depth, label: label(l) });
      if (further && !visited.has(l.taskId)) {
        hasChain = true;
        if (opts.transitive && depth < MAX_DEPTH) {
          visited.add(l.taskId);
          walk(nextEntry!, kind, depth + 1, visited);
        }
      }
    }
  };
  if (own) {
    walk(own, "waits", 1, new Set([taskId]));
    walk(own, "blocks", 1, new Set([taskId]));
  }
  // Manual card dependencies, drawn the same way.
  for (const d of manualWaits) add({ from: d.taskId, to: taskId, kind: "waits", depth: 1, label: d.ref ?? d.title });
  for (const b of manualBlocks) add({ from: taskId, to: b.taskId, kind: "blocks", depth: 1, label: b.title });

  const roadmapCards = new Set([...(own?.predecessors ?? []), ...(own?.successors ?? [])].map((l) => l.taskId).filter(Boolean));
  return {
    step: own?.step ?? null,
    edges,
    waits: [
      ...(own?.predecessors ?? []).map((l) => rowOf(l, "waits")),
      ...manualWaits.filter((d) => !roadmapCards.has(d.taskId)).map((d) => ({ key: `dep:${d.taskId}`, text: d.title, state: d.detail || "card dependency", taskId: d.taskId, done: false })),
    ],
    blocks: [
      ...(own?.successors ?? []).map((l) => rowOf(l, "blocks")),
      ...manualBlocks.filter((b) => !roadmapCards.has(b.taskId)).map((b) => ({ key: `dep:${b.taskId}`, text: b.title, state: "waits on this card", taskId: b.taskId, done: false })),
    ],
    moreWaits: own?.morePredecessors ?? 0,
    moreBlocks: own?.moreSuccessors ?? 0,
    hasChain,
  };
}

// ── Geometry ──────────────────────────────────────────────────────────────

/** A card's box, relative to the overlay's top-left corner. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface EdgeGeometry {
  /** The connector: a cubic curve from the `from` card to the `to` card. */
  d: string;
  /** The arrowhead at the `to` end. */
  arrow: string;
  /** Where each end touches (after clipping). */
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** An end whose card lies outside the visible board: the line stops at
   *  the edge there, and the label goes next to it. */
  clipped: { end: "from" | "to"; side: "top" | "bottom" | "left" | "right"; x: number; y: number } | null;
}

const INSET = 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Which side of the view a box lies wholly beyond, if any. */
export function outside(box: Box, view: { width: number; height: number }): "top" | "bottom" | "left" | "right" | null {
  if (box.bottom <= 0) return "top";
  if (box.top >= view.height) return "bottom";
  if (box.right <= 0) return "left";
  if (box.left >= view.width) return "right";
  return null;
}

/**
 * The connector from card `from` to card `to`. Cards in different columns
 * are joined across the gutter between them; cards in the same column by a
 * bracket that swings out to the right — further for cards further apart,
 * so nested brackets don't run over each other. An end whose card is
 * scrolled out of view is pulled back to the edge of the view (`clipped`).
 * `at` says how far down each card its end sits (0 top … 1 bottom), so the
 * lines into a card and the lines out of it don't share a point.
 */
export function edgeGeometry(from: Box, to: Box, view: { width: number; height: number }, at: { from?: number; to?: number } = {}): EdgeGeometry {
  // The vertical anchor, within the card's visible part.
  const anchorY = (b: Box, frac = 0.5) => {
    const top = Math.max(b.top, 0);
    const bottom = Math.min(b.bottom, view.height);
    return bottom > top ? top + (bottom - top) * frac : (b.top + b.bottom) / 2;
  };
  const right = to.left >= from.right - 4;
  const left = !right && to.right <= from.left + 4;
  const sameColumn = !right && !left;
  /** +1: the line arrives travelling right; -1: travelling left. */
  const dir: 1 | -1 = right ? 1 : -1;
  let start = { x: right || sameColumn ? from.right : from.left, y: anchorY(from, at.from) };
  let end = { x: right ? to.left : to.right, y: anchorY(to, at.to) };
  const fromOut = outside(from, view);
  const toOut = outside(to, view);
  const pull = (p: { x: number; y: number }) => ({ x: clamp(p.x, INSET, view.width - INSET), y: clamp(p.y, INSET, view.height - INSET) });
  if (fromOut) start = pull(start);
  if (toOut) end = pull(end);
  let c1: { x: number; y: number };
  let c2: { x: number; y: number };
  if (sameColumn) {
    const bulge = clamp(10 + Math.abs(end.y - start.y) / 14, 12, 28);
    c1 = { x: start.x + bulge, y: start.y };
    c2 = { x: end.x + bulge, y: end.y };
  } else {
    const reach = Math.max(18, Math.abs(end.x - start.x) / 2);
    c1 = { x: start.x + dir * reach, y: start.y };
    c2 = { x: end.x - dir * reach, y: end.y };
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  const back = end.x - dir * 9;
  const clippedEnd = toOut ? ("to" as const) : fromOut ? ("from" as const) : null;
  return {
    d: `M ${r(start.x)} ${r(start.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(end.x)} ${r(end.y)}`,
    arrow: `M ${r(end.x)} ${r(end.y)} L ${r(back)} ${r(end.y - 4.5)} L ${r(back)} ${r(end.y + 4.5)} Z`,
    start,
    end,
    clipped: clippedEnd ? { end: clippedEnd, side: (toOut ?? fromOut)!, x: clippedEnd === "to" ? end.x : start.x, y: clippedEnd === "to" ? end.y : start.y } : null,
  };
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * Where the hover panel goes: next to the hovered card — under it, over it,
 * or beside it — wherever it covers least. Covering the hovered card or a
 * card a line runs to counts far more than covering any other card, so the
 * panel never sits on what it explains when there is room elsewhere.
 */
export function panelPlacement(
  card: Box,
  view: { width: number; height: number },
  size: { width: number; height: number },
  avoid: { linked?: Box[]; others?: Box[] } = {},
): { left: number; top: number } {
  const gap = 8;
  const fit = (left: number, top: number) => ({ left: clamp(left, 8, view.width - size.width - 8), top: clamp(top, 8, view.height - size.height - 8) });
  const spots = [
    fit(card.left, card.bottom + gap), // under
    fit(card.left, card.top - gap - size.height), // over
    fit(card.right + gap + 24, card.top), // to the right, clear of the bracket lines
    fit(card.left - gap - size.width, card.top), // to the left
  ];
  let best = spots[0]!;
  let bestCost = Infinity;
  for (const spot of spots) {
    const box = { left: spot.left, top: spot.top, right: spot.left + size.width, bottom: spot.top + size.height };
    const cost = overlap(box, card) * 50 + (avoid.linked ?? []).reduce((n, b) => n + overlap(box, b), 0) * 20 + (avoid.others ?? []).reduce((n, b) => n + overlap(box, b), 0);
    if (cost < bestCost) {
      best = spot;
      bestCost = cost;
    }
  }
  return best;
}
