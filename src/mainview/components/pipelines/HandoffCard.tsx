import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, ChevronDown, CircleAlert, CircleCheck, CircleHelp, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { ASSISTANT_MD_COMPONENTS, ExternalLink, MD_URL_TRANSFORM } from "../kanban/md-components";
import type { Handoff } from "../../../shared/types.ts";

const Markdown = ({ text }: { text: string }) => (
  <div className="agetor-md text-xs text-foreground">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
      {text}
    </ReactMarkdown>
  </div>
);

function Artifact({ value }: { value: string }) {
  if (/^https?:\/\//i.test(value)) {
    return (
      <ExternalLink href={value} className="break-all text-info underline-offset-2 hover:underline">
        {value.replace(/^https?:\/\/(www\.)?/i, "")}
      </ExternalLink>
    );
  }
  return <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{value}</code>;
}

/**
 * A pipeline step's handoff, formatted: status and next step up top, the
 * summary and reason as Markdown, artifacts as links / paths, and open
 * questions as a list — instead of the raw `<handoff>` JSON. Used in a step's
 * transcript and in the pipeline run view (result, blocked and history).
 */
export const HandoffCard = memo(function HandoffCard({
  handoff,
  className,
  defaultShowPurpose = false,
}: {
  handoff: Handoff;
  className?: string;
  defaultShowPurpose?: boolean;
}) {
  const [showPurpose, setShowPurpose] = useState(defaultShowPurpose);
  const blocked = handoff.status === "blocked";
  return (
    <div
      data-testid="handoff-card"
      className={cn(
        "space-y-2.5 rounded-md border p-2.5",
        blocked ? "border-warning/40 bg-warning/5" : "border-border bg-card",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5",
            blocked ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
          )}
        >
          {blocked ? <CircleAlert className="size-3" /> : <CircleCheck className="size-3" />}
          {blocked ? "Blocked" : "Done"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
          <ArrowRight className="size-3" />
          {handoff.next ?? "End of pipeline"}
        </span>
      </div>

      {handoff.summary && <Markdown text={handoff.summary} />}

      {handoff.reason && (
        <div>
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Why handing off</p>
          <Markdown text={handoff.reason} />
        </div>
      )}

      {handoff.openQuestions.length > 0 && (
        <div data-testid="handoff-open-questions">
          <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning">
            <CircleHelp className="size-3" />
            Open questions
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {handoff.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {handoff.artifacts.length > 0 && (
        <div data-testid="handoff-artifacts">
          <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Paperclip className="size-3" />
            Artifacts
          </p>
          <ul className="space-y-1 text-xs">
            {handoff.artifacts.map((a, i) => (
              <li key={i}>
                <Artifact value={a} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {handoff.purpose && (
        <div>
          <button
            type="button"
            onClick={() => setShowPurpose((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            Purpose
            <ChevronDown className={cn("size-3 transition-transform", showPurpose && "rotate-180")} aria-hidden />
          </button>
          {showPurpose && <p className="mt-1 text-xs text-muted-foreground">{handoff.purpose}</p>}
        </div>
      )}
    </div>
  );
});
