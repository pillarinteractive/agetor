import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Shown as the button's tooltip. */
  title?: string;
  testId?: string;
}

/**
 * A two-or-three way switch between views of the same thing (a forecast
 * scope, the steps as tiles or as a graph). Each option is a real button
 * with `aria-pressed`, so Tab reaches them in order and Enter or Space
 * presses one; the group is named by `label`.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex flex-wrap gap-[3px] rounded-[7px] bg-state-neutral p-[3px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-testid={o.testId}
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "whitespace-nowrap rounded-[5px] px-2.5 py-1.5 text-[11px] leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
            value === o.value ? "bg-board-card font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
