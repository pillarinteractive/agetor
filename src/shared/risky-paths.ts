/**
 * Which changed files make a PR "risky" for Autopilot — one it leaves in In
 * Review for the owner instead of signing off (src/bun/autopilot.ts).
 *
 * A file is classified by its path SEGMENTS, never by a substring:
 *
 *  1. Never risky: tests, fixtures, golden/snapshot data and docs
 *     (`NOT_PRODUCT_DIRS`, `isTestFile`, `*.md`). `testdata/permission-denied/
 *     case.json` and `docs/engineering/authz-inventory.md` are not
 *     product code, whatever words their names carry.
 *  2. Risky: any directory named exactly like a sensitive area
 *     (`RISKY_DIRS`: `billing/`, `auth/`, `drizzle/`, `migrations/` …). A
 *     Next.js route group or dynamic segment counts by its name: `(auth)/`
 *     is `auth`. A longer name is not a match: `permission-denied/` is not
 *     `permission`.
 *  3. Risky: a source file whose name contains a sensitive WORD
 *     (`RISKY_FILE_WORDS`), the name split on `-`, `_`, `.` and camelCase:
 *     `deviceAuth.ts`, `stripe.ts`, `BillingNotice.tsx`, `migrationCheck.ts`.
 *     `authoritative.ts` has no word `auth`. Data files (`.json`, `.txt`,
 *     `.yaml` …) are not matched by name — only by their directory.
 *  4. Risky: `schema.ts`, anything named `schema*` directly in a `db/`
 *     directory or inside `db/schema/`, and the request middleware
 *     (`middleware.ts`, Next 16's `proxy.ts`).
 *
 * The `autopilot_risky_paths` preference (a JSON array of globs) replaces
 * all of the above: a file is then risky when it matches any glob.
 * Pure; shared with tests.
 */

/** Directories whose every (non-test, non-doc) file is sensitive. Compared
 *  with a whole path segment, lower-cased, with a route group's or dynamic
 *  segment's brackets removed. */
export const RISKY_DIRS: readonly string[] = [
  "billing",
  "stripe",
  "checkout",
  "subscription",
  "subscriptions",
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "clerk",
  "session",
  "sessions",
  "permission",
  "permissions",
  "migration",
  "migrations",
  "drizzle",
];

/** Words that make a SOURCE file's name sensitive (see rule 3). */
export const RISKY_FILE_WORDS: readonly string[] = [
  "billing",
  "stripe",
  "checkout",
  "subscription",
  "subscriptions",
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "authorize",
  "clerk",
  "session",
  "sessions",
  "permission",
  "permissions",
  "rbac",
  "roles",
  "migration",
  "migrations",
  "drizzle",
];

/** Source files sensitive by their whole name (extension aside). */
export const RISKY_FILE_STEMS: readonly string[] = ["middleware", "proxy"];

/** Extensions of files matched by name (rule 3 and `RISKY_FILE_STEMS`). */
export const SOURCE_EXTENSIONS: readonly string[] = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "py", "rb", "rs", "java", "kt", "swift", "php", "cs", "sql", "sh"];

/** Directories that hold no product code: tests, fixtures, recorded data,
 *  docs. A file under any of them is never risky. A segment starting `e2e`
 *  (`e2e-staging/`) counts too. */
export const NOT_PRODUCT_DIRS: readonly string[] = [
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "__snapshots__",
  "test",
  "tests",
  "testdata",
  "testing",
  "fixture",
  "fixtures",
  "golden",
  "goldens",
  "snapshots",
  "mocks",
  "e2e",
  "docs",
  "doc",
];

/** The preference holding the per-install override: a JSON array of globs. */
export const RISKY_PATHS_PREF = "autopilot_risky_paths";

const lowerSet = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
const DIRS = lowerSet(RISKY_DIRS);
const WORDS = lowerSet(RISKY_FILE_WORDS);
const STEMS = lowerSet(RISKY_FILE_STEMS);
const SOURCE = lowerSet(SOURCE_EXTENSIONS);
const NOT_PRODUCT = lowerSet(NOT_PRODUCT_DIRS);

/** `(auth)` → `auth`, `[[...sign-in]]` → `sign-in`, `@modal` → `modal`. */
const bare = (segment: string) => segment.toLowerCase().replace(/^[([@]+(?:\.\.\.)?/, "").replace(/[)\]]+$/, "");

/** `deviceAuth.test` → device, auth, test · `resync-team-billing` → resync,
 *  studio, billing · `HTTPSession` → http, session. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** `a.test.ts`, `a.spec.tsx`, `a_test.go`, `test_a.py`, `a.snap`, `a.golden`. */
export function isTestFile(fileName: string): boolean {
  const f = fileName.toLowerCase();
  return /\.(test|spec|stories|snap|golden)(\.|$)/.test(f) || /_test\.[a-z0-9]+$/.test(f) || /^test_.*\.py$/.test(f) || /^conftest\.py$/.test(f);
}

/** Why a path is risky under the built-in rules, or null. */
export function riskyReason(path: string): string | null {
  const parts = path.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").split("/").filter(Boolean);
  const file = parts.pop();
  if (!file) return null;
  const dirs = parts.map(bare);
  const lower = file.toLowerCase();
  if (/\.(md|mdx|markdown|rst|adoc)$/.test(lower) || isTestFile(file)) return null;
  if (dirs.some((d) => NOT_PRODUCT.has(d) || /^e2e(?:[-_.]|$)/.test(d))) return null;

  const dir = dirs.find((d) => DIRS.has(d));
  if (dir) return `in ${dir}/`;

  const dot = lower.indexOf(".");
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const parent = dirs[dirs.length - 1];
  if (lower === "schema.ts" || (parent === "db" && stem.startsWith("schema")) || (dirs.length >= 2 && parent === "schema" && dirs[dirs.length - 2] === "db")) return "the database schema";
  if (!SOURCE.has(ext)) return null;
  if (STEMS.has(stem)) return "request middleware";
  const word = nameWords(file.slice(0, file.lastIndexOf("."))).find((w) => WORDS.has(w));
  return word ? `named for ${word}` : null;
}

/** A glob as a regular expression: `**` any depth, `*` within a segment,
 *  `?` one character. Matched against the whole path, case-insensitively. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const g = glob.trim().replace(/^\.?\/+/, "");
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

export interface RiskyRules {
  /** Globs replacing the built-in rules; null = the built-in rules. */
  globs: string[] | null;
  /** Changes whenever the rules do: a hold decided under another signature
   *  is decided again. */
  signature: string;
}

/** Bump when the built-in rules change, so cards held under the old ones are
 *  looked at again. */
const BUILT_IN_VERSION = "segments-1";

/** The rules in force: the preference's globs when it is a non-empty JSON
 *  array of strings, else the built-in rules. */
export function parseRiskyRules(pref: string | null | undefined): RiskyRules {
  try {
    const v = pref ? JSON.parse(pref) : null;
    const globs = Array.isArray(v) ? v.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim()) : [];
    if (globs.length > 0) return { globs, signature: `globs:${JSON.stringify(globs)}` };
  } catch {
    // the built-in rules
  }
  return { globs: null, signature: BUILT_IN_VERSION };
}

/** The risky files among `paths`, in order. */
export function riskyFiles(paths: readonly string[], rules: RiskyRules = parseRiskyRules(null)): string[] {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  if (rules.globs) {
    const res = rules.globs.map(globToRegExp);
    return clean.filter((p) => res.some((re) => re.test(p.replace(/^\.?\/+/, ""))));
  }
  return clean.filter((p) => riskyReason(p) != null);
}

/** "a/b.ts, c/d.ts and 3 more" — for the activity note. */
export function describeRiskyFiles(files: readonly string[], max = 3): string {
  const shown = files.slice(0, max).join(", ");
  return files.length > max ? `${shown} and ${files.length - max} more` : shown;
}
