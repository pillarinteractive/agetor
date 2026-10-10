import { useState } from "react";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError, type AutopilotDto } from "@/lib/api";
import { roadmapOffer } from "@/lib/card-status";
import { milestoneName, nextMilestoneText } from "../../../shared/roadmap.ts";

/**
 * Autopilot's next-milestone offer (src/bun/autopilot.ts `roadmapPass`):
 * when the milestone being worked can no longer fill its slots, the board
 * asks whether to start the one that follows as well. Rendered from the
 * roadmap status the server publishes, so it survives a reload and reads
 * the same in `agetor roadmap status`; every answer goes through
 * `POST /autopilot/roadmap/continue`.
 *
 * Not modal: it sits in the board's corner and nothing waits on it.
 */
export function NextMilestonePrompt({ autopilot, onAnswered }: { autopilot: AutopilotDto | null; onAnswered: (next: AutopilotDto, message: string) => void }) {
  const [busy, setBusy] = useState<"accept" | "always" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offer = roadmapOffer(autopilot);
  if (!offer) return null;
  const text = nextMilestoneText(offer);
  const name = milestoneName(offer);

  const answer = async (action: "accept" | "always" | "dismiss") => {
    setBusy(action);
    setError(null);
    try {
      const r = await api.continueRoadmap(action);
      onAnswered(r, r.message);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Start the next milestone?"
      data-testid="next-milestone-prompt"
      data-reason={offer.reason ?? undefined}
      className="absolute bottom-5 right-4 z-30 w-[23rem] max-w-[calc(100%-2rem)] rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Rocket className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        Next milestone
      </div>
      <p className="mt-1.5 text-[13px] leading-snug" data-testid="next-milestone-question">
        {text.question}
      </p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground" data-testid="next-milestone-detail">
        {text.detail}. What is left of {offer.current} keeps running.
      </p>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" className="h-7" data-testid="next-milestone-accept" disabled={busy !== null} onClick={() => void answer("accept")}>
          {busy === "accept" ? "Starting…" : `Start ${name}`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          data-testid="next-milestone-always"
          disabled={busy !== null}
          onClick={() => void answer("always")}
          title={`Start ${name}, and from now on continue into later milestones without asking (turn it off in the Autopilot dialog)`}
        >
          Always continue
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7"
          data-testid="next-milestone-dismiss"
          disabled={busy !== null}
          onClick={() => void answer("dismiss")}
          title={offer.reason === "finished" ? "Leave it — start it later from the Autopilot dialog" : "Ask again when this milestone has moved on"}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
