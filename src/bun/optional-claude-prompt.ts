/** A closed allowlist of harmless CLI reminders. Never infer authorization
 * from Yes, Recommended, auto mode, or free-form question text. */
export function environmentReminderKey(paneText: string, choices: Array<{ key: string; label: string }>): string | null {
  const lines = paneText.split("\n").map((s) => s.trim());
  if (!lines.includes("Teach auto mode about your environment?")) return null;
  if (!lines.includes("Auto mode works better when it knows your environment. Takes about a minute.")) return null;
  if (JSON.stringify(choices) !== JSON.stringify([{ key: "1", label: "Yes" }, { key: "2", label: "Not now" }, { key: "3", label: "Don't show again" }])) return null;
  return "3";
}

/** The notice Claude Code shows when its requests go through a gateway that
 *  has not adopted the auto-mode classifier billing change. It asks nothing
 *  and grants nothing ("Nothing breaks: auto mode keeps working"); it only
 *  waits for Enter. Matched on its exact sentences with whitespace collapsed,
 *  because the pane wraps them at its own width, and only when the pane
 *  offers no choices. Returns the key that continues, or null. */
export function gatewayBillingNoticeKey(paneText: string, choices: Array<{ key: string; label: string }>): "Enter" | null {
  if (choices.length !== 0) return null;
  const flat = paneText.replace(/\s+/g, " ");
  const required = [
    "We're changing auto mode to no longer charge for classifier requests in Claude Code.",
    "However, this session isn't eligible because your requests go through",
    "Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.",
    "Enter to continue · Esc to cancel",
  ];
  return required.every((sentence) => flat.includes(sentence)) ? "Enter" : null;
}
