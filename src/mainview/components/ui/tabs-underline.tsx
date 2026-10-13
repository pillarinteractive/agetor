import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface UnderlineTab<T extends string> {
  value: T;
  label: string;
  testId?: string;
}

/**
 * A row of underlined tabs over one panel: `role="tablist"`, each tab with
 * `aria-selected` and `aria-controls`. Every tab is in the Tab order and
 * Enter or Space selects it; Left and Right move between them as well, as a
 * tab list is expected to. The caller renders the panel through
 * `TabPanel` with the same `idBase`.
 */
export function UnderlineTabs<T extends string>({
  label,
  idBase,
  value,
  tabs,
  onChange,
  className,
}: {
  label: string;
  idBase: string;
  value: T;
  tabs: readonly UnderlineTab<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const move = (from: number, by: number) => {
    const next = tabs[(from + by + tabs.length) % tabs.length]!;
    onChange(next.value);
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${idBase}-tab-${next.value}`)}`)?.focus();
  };
  return (
    <div ref={listRef} role="tablist" aria-label={label} className={cn("flex flex-wrap gap-x-[18px] border-b border-board-line", className)}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.value}`}
          data-testid={t.testId}
          aria-selected={value === t.value}
          aria-controls={`${idBase}-panel`}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") move(i, 1);
            else if (e.key === "ArrowLeft") move(i, -1);
            else return;
            e.preventDefault();
          }}
          className={cn(
            "-mb-px border-b-2 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            value === t.value ? "border-state-waiting font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The panel the selected tab controls. */
export function TabPanel({ idBase, value, className, children }: { idBase: string; value: string; className?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${value}`} className={className}>
      {children}
    </div>
  );
}
