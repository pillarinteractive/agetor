import { useEffect, useId, useState } from "react";
import { Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { FollowUpAction } from "../../../../shared/types.ts";

/**
 * The follow-up composer, drawn from what it is given: a request, the
 * presets (those the branch's changed files make relevant first, marked
 * Suggested) and an agent to run a custom request with. Nothing runs until
 * a button is pressed.
 */
export function FollowUpComposer({
  actions,
  profiles,
  busy,
  error,
  onRun,
}: {
  actions: FollowUpAction[];
  profiles: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  /** Resolves true when the follow-up started (the request is then cleared). */
  onRun: (body: { presetId?: string; profileId?: string; request?: string }) => Promise<boolean> | boolean;
}) {
  const inputId = useId();
  const [request, setRequest] = useState("");
  const [profileId, setProfileId] = useState("");

  useEffect(() => {
    if (!profileId && profiles.length > 0) setProfileId(profiles[0]!.id);
  }, [profiles, profileId]);

  const run = async (body: { presetId?: string; profileId?: string; request?: string }) => {
    if (await onRun(body)) setRequest("");
  };

  const sorted = [...actions].sort((a, b) => Number(b.suggested) - Number(a.suggested));
  const text = request.trim();

  return (
    <div data-testid="pipeline-followups" className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-[11px] text-[color:var(--state-queued)]">
        Follow-up on this run · starts a new step in the same worktree
      </label>
      <Textarea
        id={inputId}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Ask a question or describe what to do next (optional for the buttons below)"
        className="min-h-[70px] text-xs"
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          aria-label="Agent for a custom follow-up"
          className="h-7 min-w-0 max-w-full rounded-md border border-board-line bg-board-card px-2 text-[11px] text-foreground"
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
          className="h-7 gap-1 px-2.5 text-[11px]"
        >
          <Play className="size-3" aria-hidden />
          Run follow-up
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[11px] font-medium text-[color:var(--state-failed)]">
          {error}
        </p>
      )}
    </div>
  );
}
