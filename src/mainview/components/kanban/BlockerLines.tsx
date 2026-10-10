import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { blockerView, edgeGeometry, outside, panelPlacement, type BlockerEdge, type BlockerRow, type Box, type EdgeGeometry } from "@/lib/blocker-lines";
import type { RoadmapStepLinks } from "../../../shared/roadmap.ts";
import type { Task } from "../../../shared/types.ts";

/** How long the pointer rests on a card before its lines appear, so a pass
 *  across the board doesn't flash them. Keyboard focus shows them at once. */
const HOVER_DELAY_MS = 140;
const PANEL_WIDTH = 320;

const WAITS = "hsl(var(--warning))";
const BLOCKS = "hsl(var(--info))";

interface Drawn {
  edge: BlockerEdge;
  geo: EdgeGeometry;
}

interface Measured {
  view: { width: number; height: number };
  card: Box;
  drawn: Drawn[];
  /** The boxes of the cards at the far ends, to outline them. */
  boxes: { id: string; box: Box; kind: "waits" | "blocks"; depth: number }[];
  /** Linked cards that aren't rendered (filtered out, or folded away). */
  missing: Set<string>;
  /** Every other card on the board, for placing the panel clear of them. */
  others: Box[];
  /** The panel's own size once it has been laid out. */
  panel: { width: number; height: number } | null;
  signature: string;
}

/**
 * Blocker lines: hovering (or keyboard-focusing) a card draws a connector to
 * every card it waits on and — in a second style — to every card it blocks,
 * wherever those cards are on the board, and lists the links in a small
 * panel under the card, including the ones that have no card (a finished
 * step, the owner's step, a step of another milestone). Holding Shift
 * follows the whole chain.
 *
 * An overlay over the board that never takes a pointer event. It listens on
 * its parent (the board's positioning box) for pointer and focus events that
 * reach a `[data-task-id]` card, so cards, dragging and the context menu are
 * untouched. Positions are read from the cards' boxes in an animation frame
 * loop that runs only while a card's lines are shown — it follows scrolling,
 * resizing and cards moving — and state changes only when a box moved.
 */
export function BlockerLines({ links, tasks }: { links: ReadonlyMap<string, RoadmapStepLinks>; tasks: Task[] }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [transitive, setTransitive] = useState(false);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const linksRef = useRef(links);
  const tasksRef = useRef(tasks);
  linksRef.current = links;
  tasksRef.current = tasks;

  // Which card the pointer rests on, or the keyboard focused.
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pressed = false;
    const cardOf = (t: EventTarget | null) => (t instanceof Element ? (t.closest("[data-task-id]") as HTMLElement | null) : null);
    const hasLinks = (id: string) => {
      if (linksRef.current.has(id)) return true;
      const t = tasksRef.current.find((x) => x.id === id);
      return !!t && ((t.blockedBy ?? []).some((d) => !d.satisfied) || (t.blocking?.length ?? 0) > 0);
    };
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      setHovered(null);
    };
    const show = (id: string, delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setHovered(id);
      }, delay);
    };
    const onOver = (e: PointerEvent) => {
      // Not while a button is down (a drag in progress), and not for touch.
      if (pressed || e.buttons !== 0 || e.pointerType === "touch") return;
      const id = cardOf(e.target)?.dataset.taskId;
      if (!id || !hasLinks(id)) return;
      setTransitive(e.shiftKey);
      show(id, HOVER_DELAY_MS);
    };
    const onOut = (e: PointerEvent) => {
      const el = cardOf(e.target);
      if (!el || cardOf(e.relatedTarget) === el) return; // still inside the same card
      clear();
    };
    const onDown = () => {
      pressed = true;
      clear();
    };
    const onUp = () => {
      pressed = false;
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement && e.target.matches("[data-task-id]") ? e.target : null;
      const id = el?.dataset.taskId;
      // Keyboard focus only: a click also focuses the card, and opens it.
      if (!el || !id || !el.matches(":focus-visible") || !hasLinks(id)) return;
      show(id, 0);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && e.target.matches("[data-task-id]")) clear();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") setTransitive(e.type === "keydown");
      else if (e.key === "Escape" && e.type === "keydown") clear();
    };
    host.addEventListener("pointerover", onOver);
    host.addEventListener("pointerout", onOut);
    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      if (timer) clearTimeout(timer);
      host.removeEventListener("pointerover", onOver);
      host.removeEventListener("pointerout", onOut);
      host.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  const view = useMemo(
    () => (hovered ? blockerView(hovered, links, tasks.find((t) => t.id === hovered), { transitive }) : null),
    [hovered, links, tasks, transitive],
  );

  // Follow the cards while lines are shown: one read of the boxes per frame,
  // one state change when something moved.
  useEffect(() => {
    if (!hovered || !view) {
      setMeasured(null);
      return;
    }
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host) return;
    const find = (id: string) => host.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    let frame = 0;
    let last = "";
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = find(hovered);
      // The card moved away under the pointer, was removed, or lost both the
      // pointer and the focus without an event reaching us: nothing to show.
      if (!el || !(el.matches(":hover") || el.matches(":focus-visible"))) {
        setHovered(null);
        return;
      }
      const origin = root.getBoundingClientRect();
      const boxOf = (node: Element): Box => {
        const r = node.getBoundingClientRect();
        return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
      };
      const size = { width: origin.width, height: origin.height };
      const boxes = new Map<string, Box>([[hovered, boxOf(el)]]);
      const missing = new Set<string>();
      const boxFor = (id: string) => {
        if (boxes.has(id)) return boxes.get(id)!;
        if (missing.has(id)) return null;
        const node = find(id);
        if (!node) {
          missing.add(id);
          return null;
        }
        const b = boxOf(node);
        boxes.set(id, b);
        return b;
      };
      const drawn: Drawn[] = [];
      const ends = new Map<string, { kind: "waits" | "blocks"; depth: number }>();
      for (const edge of view.edges) {
        const from = boxFor(edge.from);
        const to = boxFor(edge.to);
        if (!from || !to) continue;
        // Both ends out of view (a link further up the chain): nothing to see.
        if (outside(from, size) && outside(to, size)) continue;
        // Lines into the hovered card arrive above the ones leaving it.
        drawn.push({ edge, geo: edgeGeometry(from, to, size, { from: edge.from === hovered ? 0.66 : 0.5, to: edge.to === hovered ? 0.34 : 0.5 }) });
        const far = edge.kind === "waits" ? edge.from : edge.to;
        if (far !== hovered && !ends.has(far)) ends.set(far, { kind: edge.kind, depth: edge.depth });
      }
      for (const row of [...view.waits, ...view.blocks]) if (row.taskId) boxFor(row.taskId);
      const others: Box[] = [];
      for (const node of host.querySelectorAll<HTMLElement>("[data-task-id]")) {
        const id = node.dataset.taskId!;
        if (id !== hovered && !ends.has(id)) others.push(boxes.get(id) ?? boxOf(node));
      }
      const panel = panelRef.current;
      const next: Measured = {
        view: size,
        card: boxes.get(hovered)!,
        drawn,
        boxes: [...ends].map(([id, v]) => ({ id, box: boxes.get(id)!, ...v })),
        missing,
        others,
        panel: panel ? { width: panel.offsetWidth, height: panel.offsetHeight } : null,
        signature: "",
      };
      next.signature = JSON.stringify([size, next.card, drawn.map((d) => [d.edge.from, d.edge.to, d.geo.d]), [...missing], others.length, next.panel], (_k, v) => (typeof v === "number" ? Math.round(v) : v));
      if (next.signature !== last) {
        last = next.signature;
        setMeasured(next);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [hovered, view]);

  const shown = hovered && view && measured ? { view, measured } : null;
  // The panel is laid out once out of sight to learn its height, then placed.
  const place =
    shown && shown.measured.panel
      ? panelPlacement(shown.measured.card, shown.measured.view, shown.measured.panel, { linked: shown.measured.boxes.map((b) => b.box), others: shown.measured.others })
      : null;

  return (
    <div ref={rootRef} data-testid="blocker-lines-root" className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {shown && (
        <>
          <svg data-testid="blocker-lines" aria-hidden className="absolute inset-0 h-full w-full" width={shown.measured.view.width} height={shown.measured.view.height}>
            {/* The hovered card, then the cards at the far ends. */}
            <Outline box={shown.measured.card} color="hsl(var(--foreground) / 0.55)" />
            {shown.measured.boxes.map((b) =>
              outside(b.box, shown.measured.view) ? null : <Outline key={b.id} box={b.box} color={b.kind === "waits" ? WAITS : BLOCKS} dashed={b.kind === "blocks"} faint={b.depth > 1} testId={`blocker-target-${b.kind}`} />,
            )}
            {shown.measured.drawn.map(({ edge, geo }) => {
              const color = edge.kind === "waits" ? WAITS : BLOCKS;
              const far = edge.depth > 1;
              return (
                <g key={`${edge.from}>${edge.to}`} data-testid={`blocker-line-${edge.kind}`} data-depth={edge.depth} data-clipped={geo.clipped ? geo.clipped.side : undefined} opacity={far ? 0.6 : 1}>
                  {/* A halo in the page colour keeps the line readable over cards. */}
                  <path d={geo.d} fill="none" stroke="hsl(var(--background))" strokeWidth={far ? 4 : 5} strokeLinecap="round" opacity={0.9} />
                  <path d={geo.d} fill="none" stroke={color} strokeWidth={far ? 1.5 : 2} strokeLinecap="round" strokeDasharray={edge.kind === "blocks" ? "6 4" : undefined} />
                  <path d={geo.arrow} fill={color} stroke="hsl(var(--background))" strokeWidth={0.75} />
                  <circle cx={geo.start.x} cy={geo.start.y} r={2.5} fill={color} stroke="hsl(var(--background))" strokeWidth={0.75} />
                  {geo.clipped && <ClippedLabel x={geo.clipped.x} y={geo.clipped.y} side={geo.clipped.side} text={edge.label} color={color} width={shown.measured.view.width} />}
                </g>
              );
            })}
          </svg>
          {/* Over the lines: the words stay readable where a line runs behind them. */}
          <div
            ref={panelRef}
            role="tooltip"
            data-testid="blocker-panel"
            className="absolute rounded-md border border-border bg-card px-2.5 py-2 text-[11px] leading-snug text-card-foreground shadow-lg"
            style={{ left: place?.left ?? 0, top: place?.top ?? 0, width: PANEL_WIDTH, maxHeight: Math.max(120, shown.measured.view.height - 16), overflow: "hidden", visibility: place ? "visible" : "hidden" }}
          >
            <Rows title="Waits on" empty={shown.view.step ? "Waits on nothing" : null} rows={shown.view.waits} more={shown.view.moreWaits} kind="waits" missing={shown.measured.missing} />
            <Rows title="Blocks" empty={null} rows={shown.view.blocks} more={shown.view.moreBlocks} kind="blocks" missing={shown.measured.missing} />
            {shown.view.hasChain && <p className="mt-1.5 text-[10px] text-muted-foreground">{transitive ? "Showing the whole chain" : "Hold Shift for the whole chain"}</p>}
          </div>
        </>
      )}
    </div>
  );
}

function Outline({ box, color, dashed, faint, testId }: { box: Box; color: string; dashed?: boolean; faint?: boolean; testId?: string }) {
  return (
    <rect
      data-testid={testId}
      x={box.left - 3}
      y={box.top - 3}
      width={Math.max(0, box.right - box.left + 6)}
      height={Math.max(0, box.bottom - box.top + 6)}
      rx={11}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeDasharray={dashed ? "6 4" : undefined}
      opacity={faint ? 0.6 : 1}
    />
  );
}

/** Names the card a line runs off the edge towards. */
function ClippedLabel({ x, y, side, text, color, width }: { x: number; y: number; side: "top" | "bottom" | "left" | "right"; text: string; color: string; width: number }) {
  const arrow = side === "top" ? "↑" : side === "bottom" ? "↓" : side === "left" ? "←" : "→";
  const label = `${arrow} ${text.length > 28 ? `${text.slice(0, 27)}…` : text}`;
  const w = Math.min(220, label.length * 6.2 + 12);
  const left = Math.min(Math.max(4, side === "right" ? x - w - 6 : x + 8), Math.max(4, width - w - 4));
  const top = side === "bottom" ? y - 20 : side === "top" ? y + 4 : y - 9;
  return (
    <g data-testid="blocker-clipped-label">
      <rect x={left} y={top} width={w} height={18} rx={4} fill="hsl(var(--background))" stroke={color} strokeWidth={1} />
      <text x={left + 6} y={top + 12.5} fontSize={11} fill="hsl(var(--foreground))">
        {label}
      </text>
    </g>
  );
}

function Rows({ title, empty, rows, more, kind, missing }: { title: string; empty: string | null; rows: BlockerRow[]; more: number; kind: "waits" | "blocks"; missing: ReadonlySet<string> }) {
  if (rows.length === 0) return empty ? <p className="text-muted-foreground">{empty}</p> : null;
  return (
    <div className={cn(kind === "blocks" && "mt-1.5")} data-testid={`blocker-rows-${kind}`}>
      <p className="mb-0.5 font-semibold">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {rows.slice(0, 8).map((r) => {
          const lined = !!r.taskId && !r.done && !missing.has(r.taskId);
          return (
            <li key={r.key} className={cn("flex items-start gap-1.5", r.done && "text-muted-foreground")}>
              {/* The swatch says whether a line is drawn to it, and in which style. */}
              <svg aria-hidden width={14} height={12} className="mt-0.5 shrink-0">
                {lined ? (
                  <line x1={1} y1={6} x2={13} y2={6} stroke={kind === "waits" ? WAITS : BLOCKS} strokeWidth={2} strokeDasharray={kind === "blocks" ? "4 3" : undefined} />
                ) : r.done ? (
                  <path d="M3 6.5 L6 9.5 L11 3.5" fill="none" stroke="currentColor" strokeWidth={1.5} />
                ) : (
                  <circle cx={7} cy={6} r={3} fill="none" stroke="currentColor" strokeWidth={1.25} />
                )}
              </svg>
              <span className="min-w-0 break-words">
                <span className="line-clamp-2">
                  {r.text}
                  <span className="text-muted-foreground">
                    {" — "}
                    {r.state}
                    {r.taskId && !r.done && missing.has(r.taskId) ? " (its card isn't shown)" : ""}
                  </span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {(rows.length > 8 || more > 0) && <p className="text-muted-foreground">and {Math.max(0, rows.length - 8) + more} more</p>}
    </div>
  );
}
