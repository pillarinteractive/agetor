import { useState } from "react";
import { MessageSquarePlus, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SUB } from "./parts";

const SELECT =
  "h-7 w-full rounded-md border border-board-line bg-background px-2 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";

/**
 * The owner's two ways to reopen a run with check gates from a step, under
 * "Advanced run controls": rewind to it, or send it feedback. Each is a form
 * that is closed until asked for; no step is chosen for the user, and
 * nothing is sent until the form's own button is pressed.
 */
export function ReopenForms({
  choices,
  busy,
  onRewind,
  onFeedback,
}: {
  /** The steps the run has reached, in path order. */
  choices: { id: string; name: string }[];
  busy: boolean;
  onRewind: (stepId: string) => void;
  onFeedback: (fromStepId: string, note: string, invalidate: boolean) => void;
}) {
  const [open, setOpen] = useState<"rewind" | "feedback" | null>(null);
  const [stepId, setStepId] = useState("");
  const [note, setNote] = useState("");
  const [invalidate, setInvalidate] = useState(false);
  const name = choices.find((c) => c.id === stepId)?.name ?? null;
  const toggle = (which: "rewind" | "feedback") => {
    setOpen((cur) => (cur === which ? null : which));
    setStepId("");
  };
  const picker = (label: string) => (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {label}
      <select data-testid="pipeline-run-reopen-step" value={stepId} onChange={(e) => setStepId(e.target.value)} className={SELECT}>
        <option value="">Pick a step…</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pipeline-run-rewind-open"
          aria-expanded={open === "rewind"}
          title="Void a step's results and the later steps', and run from that step again — a form, nothing happens until you confirm in it"
          className="h-7 gap-1 px-2.5 text-[11px]"
          onClick={() => toggle("rewind")}
        >
          <Undo2 className="size-3" aria-hidden />
          Rewind to a step…
        </Button>
        {open === "rewind" && (
          <div data-testid="pipeline-run-rewind" className="mt-2 flex flex-col gap-2 rounded-md border border-board-line bg-background p-2">
            {picker("Rewind to")}
            <p className={SUB}>
              The results of {name ?? "that step"} and of every step after it are marked void and each runs again, starting with {name ?? "it"}. Whatever is running is stopped. The
              history is kept, and git is not touched: no commit is removed and nothing is pushed.
            </p>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid="pipeline-run-rewind-submit"
              className="h-7 text-xs"
              disabled={busy || !stepId}
              onClick={() => {
                setOpen(null);
                onRewind(stepId);
              }}
            >
              {name ? `Rewind to ${name}` : "Rewind"}
            </Button>
          </div>
        )}
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pipeline-run-feedback-open"
          aria-expanded={open === "feedback"}
          title="Write a note to a step and run from it again with the note in its prompt — a form, nothing is sent until you press its button"
          className="h-7 gap-1 px-2.5 text-[11px]"
          onClick={() => toggle("feedback")}
        >
          <MessageSquarePlus className="size-3" aria-hidden />
          Send feedback from a step…
        </Button>
        {open === "feedback" && (
          <div data-testid="pipeline-run-feedback" className="mt-2 flex flex-col gap-2 rounded-md border border-board-line bg-background p-2">
            {picker("Send to")}
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="pipeline-run-feedback-note"
              placeholder="What should change — the step reads this as an instruction from you"
              className="min-h-[72px] text-xs"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={invalidate} onCheckedChange={setInvalidate} data-testid="pipeline-run-feedback-invalidate" />
              Also void the results of this step and the later ones
            </label>
            <p className={cn(SUB)}>
              The run is reopened from {name ?? "that step"}: its next prompt carries the note, and so does each later step's, once.{" "}
              {invalidate ? "Their earlier results are marked void, as a rewind does." : "Earlier results stand: each of those steps runs once more as a refinement."} Whatever is
              running is stopped; git is not touched.
            </p>
            <Button
              type="button"
              size="sm"
              data-testid="pipeline-run-feedback-submit"
              className="h-7 text-xs"
              disabled={busy || !stepId || !note.trim()}
              onClick={() => {
                setOpen(null);
                onFeedback(stepId, note.trim(), invalidate);
                setNote("");
                setInvalidate(false);
              }}
            >
              {name ? `Send to ${name}` : "Send feedback"}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
