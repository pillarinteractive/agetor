import { Activity, CircleAlert, CircleCheck, CircleDashed, CircleX, Clock3, GitMerge, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardStateIcon, CardStateTone } from "@/lib/card-state";

/** The state's icon. A state reads by its label and this icon; the colour
 *  only repeats it. */
export const STATE_ICONS: Record<CardStateIcon, LucideIcon> = {
  activity: Activity,
  clock: Clock3,
  alert: CircleAlert,
  x: CircleX,
  merge: GitMerge,
  dashed: CircleDashed,
  check: CircleCheck,
};

/**
 * A state as a chip: its icon, its label and its colour pair, the same three
 * a board card's band shows (index.css `[data-state]`). For a state named
 * away from its card: a velocity row, a step tile, a run's hold.
 */
export function StateBadge({ tone, icon, label, className, testId }: { tone: CardStateTone; icon: CardStateIcon; label: string; className?: string; testId?: string }) {
  const Icon = STATE_ICONS[icon];
  return (
    <span
      data-testid={testId}
      data-state={tone}
      className={cn("inline-flex max-w-full items-center gap-[5px] rounded bg-state-bg px-[7px] py-[3px] text-[11px] font-semibold leading-[1.3] text-state", className)}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
