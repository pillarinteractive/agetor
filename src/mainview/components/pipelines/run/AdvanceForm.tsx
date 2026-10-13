import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MultiSearchSelect, type MultiSearchSelectItem } from "@/components/ui/multi-search-select";
import type { Handoff } from "../../../../shared/types.ts";

/**
 * Manually advance one execution: pick the next step(s), or finish here.
 * Nothing is chosen for the user and nothing is sent until Advance is
 * pressed: the button stays disabled until a next step is picked or
 * "Finish here" is switched on.
 */
export function AdvanceForm({
  candidates,
  busy,
  onSubmit,
}: {
  candidates: { value: string; label: string }[];
  busy: boolean;
  onSubmit: (nextStepIds: string[] | null, handoff?: Partial<Handoff>) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [finishHere, setFinishHere] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [summary, setSummary] = useState("");

  const items: MultiSearchSelectItem[] = candidates;

  const submit = () => {
    const handoff = purpose.trim() || summary.trim() ? { purpose: purpose.trim(), summary: summary.trim() } : undefined;
    onSubmit(finishHere ? null : selected, handoff);
  };

  return (
    <div data-testid="pipeline-run-advance" className="mt-2 flex flex-col gap-2 rounded-md border border-board-line bg-background p-2">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch checked={finishHere} onCheckedChange={setFinishHere} data-testid="pipeline-run-advance-finish" />
        Finish here (no next step)
      </label>
      {!finishHere && (
        <MultiSearchSelect
          values={selected}
          onChange={setSelected}
          items={items}
          emptyLabel="Pick next step(s)…"
          placeholder="Search steps…"
        />
      )}
      <Textarea
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        placeholder="Purpose (optional)"
        className="min-h-[44px] text-xs"
      />
      <Textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Summary (optional)"
        className="min-h-[44px] text-xs"
      />
      <Button
        type="button"
        size="sm"
        className="h-7 text-xs"
        disabled={busy || (!finishHere && selected.length === 0)}
        onClick={submit}
      >
        Advance
      </Button>
    </div>
  );
}
