import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Secondary text on the run and velocity pages: the board's queued grey,
 *  which holds its contrast on a card and on a neutral chip alike. */
export const SUB = "text-[11px] leading-[1.45] text-[color:var(--state-queued)]";

/** A panel: the board card's surface and line. */
export const PANEL = "rounded-lg border border-board-line bg-board-card";

export function SectionHead({ title, note, id, children }: { title: string; note?: ReactNode; id?: string; children?: ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h3 id={id} className="text-sm font-semibold leading-[1.4] text-foreground">
        {title}
      </h3>
      {note != null && <span className={SUB}>{note}</span>}
      {children}
    </div>
  );
}

/** One fact as a row: its name on the left, its value on the right. */
export function InfoRow({ name, children, testId }: { name: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex justify-between gap-3 border-b border-board-line py-2 text-[11px] leading-[1.45]">
      <dt className="shrink-0 text-[color:var(--state-queued)]">{name}</dt>
      <dd className="min-w-0 text-right text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** A quiet note inside a panel. */
export function Note({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn(SUB, className)}>{children}</p>;
}
