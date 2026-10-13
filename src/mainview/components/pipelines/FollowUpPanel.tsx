import { useCallback, useEffect, useState } from "react";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { api, ApiError } from "@/lib/api";
import type { FollowUpAction } from "../../../shared/types.ts";
import { FollowUpComposer } from "./run/FollowUpComposer";

/**
 * "Next" on a finished pipeline: run a follow-up step in the same worktree —
 * a preset from the `pipeline_followups` preference (Open PR, Run VM tests,
 * Explain …) or a custom request with any agent. Presets the branch's changed
 * files make relevant are listed first and marked Suggested; nothing runs
 * until the user clicks. `refreshKey` changes when the run does, so the
 * suggestions track new commits from earlier follow-ups.
 */
export function FollowUpPanel({
  taskId,
  refreshKey,
  onStarted,
}: {
  taskId: string;
  refreshKey: string;
  onStarted: () => void;
}) {
  const { profiles } = useAgentProfiles();
  const [actions, setActions] = useState<FollowUpAction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getFollowUps(taskId)
      .then((r) => alive && setActions(r.actions))
      .catch(() => alive && setActions([]));
    return () => {
      alive = false;
    };
  }, [taskId, refreshKey]);

  const run = useCallback(
    async (body: { presetId?: string; profileId?: string; request?: string }) => {
      setBusy(true);
      setError(null);
      try {
        await api.runFollowUp(taskId, body);
        onStarted();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not start the follow-up.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [taskId, onStarted],
  );

  return <FollowUpComposer actions={actions ?? []} profiles={profiles} busy={busy} error={error} onRun={run} />;
}
