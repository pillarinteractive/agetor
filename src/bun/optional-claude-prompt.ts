/** A closed allowlist of harmless CLI reminders. Never infer authorization
 * from Yes, Recommended, auto mode, or free-form question text. */
export function environmentReminderKey(paneText: string, choices: Array<{ key: string; label: string }>): string | null {
  const lines = paneText.split("\n").map((s) => s.trim());
  if (!lines.includes("Teach auto mode about your environment?")) return null;
  if (!lines.includes("Auto mode works better when it knows your environment. Takes about a minute.")) return null;
  if (JSON.stringify(choices) !== JSON.stringify([{ key: "1", label: "Yes" }, { key: "2", label: "Not now" }, { key: "3", label: "Don't show again" }])) return null;
  return "3";
}
