import { useCallback, useEffect, useState } from "react";
import { Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FollowUpAction } from "../../../shared/types.ts";

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
  const [request, setRequest] = useState("");
  const [profileId, setProfileId] = useState("");
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

  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0]!.id);
  }, [profiles, profileId]);

  const run = useCallback(
    async (body: { presetId?: string; profileId?: string; request?: string }) => {
      setBusy(true);
      setError(null);
      try {
        await api.runFollowUp(taskId, body);
        setRequest("");
        onStarted();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not start the follow-up.");
      } finally {
        setBusy(false);
      }
    },
    [taskId, onStarted],
  );

  const sorted = [...(actions ?? [])].sort((a, b) => Number(b.suggested) - Number(a.suggested));
  const text = request.trim();

  return (
    <div data-testid="pipeline-followups" className="mb-3 flex flex-col gap-2 rounded-md border border-border p-2.5">
      <p className="text-xs font-medium text-muted-foreground">Next</p>
      <Textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Ask a question or describe what to do next (optional for the buttons below)"
        className="min-h-[52px] text-xs"
      />
      {sorted.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sorted.map((a) => {
            const missingText = a.requiresRequest && !text;
            const disabled = busy || !a.agentId || missingText;
            const title = !a.agentId
              ? `Agent "${a.agentName}" not found`
              : missingText
                ? "Type your request above first"
                : a.suggested
                  ? `Suggested: the branch changed ${a.matched.join(", ")}${a.matched.length >= 3 ? ", …" : ""}`
                  : `Runs with ${a.agentName}`;
            return (
              <Button
                key={a.id}
                type="button"
                size="sm"
                variant={a.suggested ? "default" : "outline"}
                data-testid="pipeline-followup-action"
                data-suggested={a.suggested}
                disabled={disabled}
                title={title}
                onClick={() => void run({ presetId: a.id, request: text || undefined })}
                className={cn("h-7 gap-1 text-xs")}
              >
                {a.suggested && <Sparkles className="size-3" aria-hidden />}
                {a.label}
              </Button>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          aria-label="Agent for a custom follow-up"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="pipeline-followup-custom"
          disabled={busy || !text || !profileId}
          title={text ? "Run your request with this agent" : "Type a request above first"}
          onClick={() => void run({ profileId, request: text })}
          className="h-7 gap-1 text-xs"
        >
          <Play className="size-3" aria-hidden />
          Run
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
