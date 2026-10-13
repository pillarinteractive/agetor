import { useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CardAction } from "@/lib/card-state";
import { LeaseContext } from "@/lib/leases";
import { PrContext } from "@/lib/prs";
import { ProgressContext, RoadmapCardsContext } from "@/lib/progress";
import type { VelocityAnswer } from "../../../shared/velocity.ts";
import type { Task } from "../../../shared/types.ts";
import { VelocityView } from "./VelocityView";

/**
 * The Velocity view with its data: the report over the whole roadmap
 * (`GET /autopilot/roadmap/velocity?scope=roadmap`, so the roadmap's own
 * totals are in it), read again every minute and when the owner's assumed
 * time per step changes, and the board's contexts for the rows' card states.
 */
export function VelocityRoute({ tasks, onBack, onAction }: { tasks: Task[]; onBack: () => void; onAction: (task: Task, action: CardAction) => void }) {
  const [delay, setDelay] = useState("");
  const [applied, setApplied] = useState<number | null>(null);
  const [answer, setAnswer] = useState<VelocityAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leases = useContext(LeaseContext);
  const prs = useContext(PrContext);
  const progress = useContext(ProgressContext);
  const roadmap = useContext(RoadmapCardsContext);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void api
        .getVelocity({ scope: "roadmap", ownerDelayHours: applied })
        .then((a) => {
          if (!alive) return;
          setAnswer(a);
          setError(null);
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [applied]);

  return (
    <VelocityView
      answer={answer}
      error={error}
      tasks={tasks}
      ctx={{ prs, leases, progress, roadmap, now: Date.now() }}
      delay={delay}
      onDelay={setDelay}
      onApplyDelay={() => {
        const n = Number(delay);
        setApplied(delay.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null);
      }}
      onBack={onBack}
      onAction={onAction}
    />
  );
}
