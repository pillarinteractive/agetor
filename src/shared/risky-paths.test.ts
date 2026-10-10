import { describe, expect, test } from "bun:test";
import { describeRiskyFiles, globToRegExp, isTestFile, nameWords, parseRiskyRules, riskyFiles, riskyReason } from "./risky-paths.ts";

// Synthetic paths in the shape of a Next.js + Drizzle web app with Go agents
// beside it.
const RISKY: [string, string][] = [
  ["apps/web/src/lib/billing/prices.ts", "in billing/"],
  ["apps/web/src/lib/billing/subscriptionSync.ts", "in billing/"],
  ["apps/web/src/app/api/billing/checkout/route.ts", "in billing/"],
  ["apps/web/src/app/api/webhooks/stripe/route.ts", "in stripe/"],
  ["apps/web/src/app/api/webhooks/clerk/route.ts", "in clerk/"],
  ["apps/web/src/app/(auth)/layout.tsx", "in auth/"],
  ["apps/web/src/app/(auth)/sign-in/[[...sign-in]]/page.tsx", "in auth/"],
  ["apps/web/src/components/auth/SignInCard.tsx", "in auth/"],
  ["apps/web/src/components/billing/Paywall.tsx", "in billing/"],
  ["packages/billing/src/calculator.ts", "in billing/"],
  ["packages/billing/package.json", "in billing/"],
  ["services/api/internal/session/store.go", "in session/"],
  ["services/api/permissions/policy.go", "in permissions/"],
  ["apps/web/drizzle/0007_add_widgets.sql", "in drizzle/"],
  ["apps/web/drizzle/meta/0007_snapshot.json", "in drizzle/"],
  ["apps/web/drizzle/meta/_journal.json", "in drizzle/"],
  ["db/migrations/20260101_init.sql", "in migrations/"],
  ["apps/web/src/db/schema.ts", "the database schema"],
  ["packages/core/src/schema.ts", "the database schema"],
  ["server/db/schema.prisma", "the database schema"],
  ["server/db/schema/users.ts", "the database schema"],
  ["apps/web/src/lib/stripe.ts", "named for stripe"],
  ["apps/web/src/lib/cron/auth.ts", "named for auth"],
  ["apps/web/src/app/api/_shared/deviceAuth.ts", "named for auth"],
  ["apps/web/src/components/BillingNotice.tsx", "named for billing"],
  ["apps/web/src/lib/reconcile/billing.ts", "named for billing"],
  ["apps/web/scripts/resync-team-billing.ts", "named for billing"],
  ["apps/web/scripts/migrationCheck.ts", "named for migration"],
  ["apps/web/drizzle.config.ts", "named for drizzle"],
  ["apps/web/src/lib/HTTPSession.ts", "named for session"],
  ["packages/schema/src/roles.ts", "named for roles"],
  ["services/api/authz_policy.go", "named for authz"],
  ["apps/web/src/proxy.ts", "request middleware"],
  ["apps/web/src/middleware.ts", "request middleware"],
  ["./apps/web/src/lib/billing/trial.ts", "in billing/"],
];

const SAFE: string[] = [
  // The two holds that stalled the first real run: fixture folders.
  "apps/agent/internal/collector/widget/testdata/permission-denied/input.json",
  "apps/agent/internal/collector/widget/testdata/permission-denied/expected.golden",
  "apps/agent/internal/collector/widget/testdata/smart-open-failed-permission/output.txt",
  // The same folder names outside a test directory: a longer segment is not the word.
  "apps/agent/internal/collector/permission-denied/handler.go",
  "apps/agent/internal/collector/smart-open-failed-permission/parse.go",
  "apps/web/src/app/subscription-ended/page.tsx",
  // A data file is not matched by its name.
  "apps/agent/internal/collector/widget/open-failed-permission.json",
  "apps/agent/internal/platform/pool/pool_stripe_read_errors.txt",
  // Tests, fixtures, snapshots, end-to-end suites.
  "apps/web/src/lib/billing/__tests__/prices.test.ts",
  "apps/web/src/lib/__tests__/stripe.test.ts",
  "apps/web/src/app/(auth)/__tests__/authPages.test.tsx",
  "apps/web/src/lib/billing/prices.test.ts",
  "apps/web/src/lib/billing/prices.spec.ts",
  "services/api/internal/session/store_test.go",
  "tools/test_auth.py",
  "apps/web/e2e-staging/browser/session.ts",
  "apps/web/e2e-staging/billing/stripe.ts",
  "apps/web/e2e/auth/login.ts",
  "packages/schema/fixtures/widget/invalid/bad-session-id.json",
  "apps/web/src/components/__snapshots__/BillingNotice.test.tsx.snap",
  "apps/web/scripts/__tests__/fixtures/baseline/migrations/0000_fake.sql",
  // Docs.
  "docs/engineering/authz-inventory.md",
  "docs/operations/billing-runbook.md",
  "apps/web/src/lib/billing/README.md",
  "apps/web/src/app/docs/billing/page.tsx",
  // The word inside a longer word.
  "apps/web/src/lib/authoritative.ts",
  "apps/web/src/lib/author.ts",
  "apps/web/src/components/StripedTable.tsx",
  "apps/web/src/lib/sessionless/ping.ts",
  // Plain product code.
  "apps/web/src/lib/fleet/nodes.ts",
  "apps/web/src/app/api/v1/nodes/route.ts",
  "apps/agent/cmd/agent/main.go",
  "packages/schema/src/index.ts",
  "packages/schema/src/widget.schema.json",
  "README.md",
  ".github/workflows/ci.yml",
  "",
];

describe("riskyReason — by path segment and file-name word", () => {
  test.each(RISKY)("risky: %s", (path, why) => {
    expect(riskyReason(path)).toBe(why);
  });
  test.each(SAFE)("not risky: %s", (path) => {
    expect(riskyReason(path)).toBeNull();
  });

  test("the old substring regex held every one of the fixture-folder paths", () => {
    const OLD = /(billing|stripe|checkout|subscription|auth|clerk|session|permission|migrations?\/|drizzle\/|db\/schema|schema\.ts)/i;
    for (const p of SAFE.slice(0, 3)) expect(OLD.test(p)).toBe(true);
  });

  test("words and test files", () => {
    expect(nameWords("deviceAuth")).toEqual(["device", "auth"]);
    expect(nameWords("resync-studio_billing.v2")).toEqual(["resync", "studio", "billing", "v2"]);
    expect(nameWords("HTTPSessionStore")).toEqual(["http", "session", "store"]);
    expect(["a.test.ts", "a.spec.tsx", "a_test.go", "test_a.py", "a.snap", "x.golden"].every(isTestFile)).toBe(true);
    expect(["attest.ts", "contest.go", "latest.py", "spec.ts"].some(isTestFile)).toBe(false);
  });
});

describe("riskyFiles — the rules in force", () => {
  const changed = ["apps/web/src/lib/fleet/nodes.ts", "apps/web/src/lib/billing/prices.ts", "apps/web/drizzle/0007_add_widgets.sql", "apps/web/src/lib/billing/__tests__/prices.test.ts", ""];

  test("built in: the sensitive files, in order", () => {
    expect(riskyFiles(changed)).toEqual(["apps/web/src/lib/billing/prices.ts", "apps/web/drizzle/0007_add_widgets.sql"]);
    expect(riskyFiles(["apps/agent/internal/collector/widget/testdata/permission-denied/input.json"])).toEqual([]);
  });

  test("the preference's globs replace the built-in rules altogether", () => {
    const rules = parseRiskyRules(JSON.stringify(["apps/web/src/lib/fleet/**", "**/*.sql"]));
    expect(rules.globs).toEqual(["apps/web/src/lib/fleet/**", "**/*.sql"]);
    expect(riskyFiles(changed, rules)).toEqual(["apps/web/src/lib/fleet/nodes.ts", "apps/web/drizzle/0007_add_widgets.sql"]);
    // A different list is a different signature: holds are decided again.
    expect(rules.signature).not.toBe(parseRiskyRules(null).signature);
    expect(rules.signature).not.toBe(parseRiskyRules(JSON.stringify(["**/*.sql"])).signature);
  });

  test("an unusable preference falls back to the built-in rules — it never turns the hold off by accident", () => {
    for (const bad of [null, "", "not json", "{}", "[]", "[1, 2]", '["  "]']) {
      expect(parseRiskyRules(bad)).toEqual({ globs: null, signature: parseRiskyRules(null).signature });
    }
  });

  test("globs: ** any depth, * within a segment, ? one character, case-insensitive", () => {
    expect(globToRegExp("**/billing/**").test("apps/web/src/lib/billing/prices.ts")).toBe(true);
    expect(globToRegExp("**/billing/**").test("billing/prices.ts")).toBe(true);
    expect(globToRegExp("**/billing/**").test("apps/web/src/lib/billing-notes/x.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/lib/a.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
    expect(globToRegExp("SRC/DB/schema.ts").test("src/db/schema.ts")).toBe(true);
    expect(globToRegExp("a(b)+.ts").test("a(b)+.ts")).toBe(true);
  });

  test("the note names the first few files", () => {
    expect(describeRiskyFiles(["a.ts"])).toBe("a.ts");
    expect(describeRiskyFiles(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])).toBe("a.ts, b.ts, c.ts and 2 more");
  });
});
