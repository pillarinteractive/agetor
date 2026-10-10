import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { getPreferences, gotoApp, putPreference } from "./helpers";
import { parseRoadmap, roadmapContinuation, roadmapFinished, roadmapScope, roadmapStatus, summarizeRoadmap, type RoadmapIssueState, type RoadmapStatus } from "../src/shared/roadmap.ts";

/**
 * The board's two roadmap pieces, rendered for real (FORK.md "Roadmap mode"):
 *
 *   - blocker lines — hovering or keyboard-focusing a roadmap step's card
 *     draws a connector to every card it waits on and, dashed, to every card
 *     it blocks, with a panel that also lists the links that have no card
 *     (src/mainview/components/kanban/BlockerLines.tsx);
 *   - the next-milestone prompt — rendered from `state.roadmap.nextMilestone`
 *     and answered through `POST /autopilot/roadmap/continue`
 *     (NextMilestonePrompt.tsx).
 *
 * Nothing here reaches GitHub. The cards are plain tasks made through the
 * API (never started), and Autopilot's status is the one `roadmapPass` would
 * write, built with the same pure functions from a synthetic tracker and
 * stored in the `autopilot_state` preference. Autopilot is switched on with
 * a project that is no repository, so the passes it runs stop at reading the
 * tracker and leave that status alone.
 *
 * Screenshots go to `ROADMAP_SHOTS` when it is set (else the test's output
 * directory): they are for people to look at, never compared.
 */

test.describe.configure({ mode: "serial" });

const TRACKER = [
  "## Numbered completion order",
  "| Step | Task and outcome | Milestone | Predecessor steps |",
  "| --- | --- | --- | --- |",
  "| 1 | #11 [Human] Provide the sample device | H | none |",
  "| 2 | #12 Inventory the widgets | M01 | none |",
  "| 3 | #13 Build the widget store | M01 | 2 |",
  "| 4 | #14 Wire the widget API | M01 | 2 |",
  "| 5 | #15 Ship the widget page | M01 | 3, 4, 9 |",
  "| 6 | #16 Calibrate against the device | M01 | 1, 5 |",
  "| 7 | #17 Write the widget guide | M01 | 5 |",
  "| 8 | #18 Agree the widget names | M01 | none |",
  "| 9 | #19 Design the gadget dock | M02 | 8 |",
  "| 10 | #20 Build the gadget dock | M02 | 9 |",
].join("\n");
const M01 = { number: 1, title: "M01 — Widget foundations" };
const M02 = { number: 2, title: "M02 — Gadget dock" };
const H = { number: 90, title: "H — Owner decisions" };
const GH_MILESTONE: Record<number, { number: number; title: string }> = { 11: H, 12: M01, 13: M01, 14: M01, 15: M01, 16: M01, 17: M01, 18: M01, 19: M02, 20: M02 };
const TITLES: Record<number, string> = {
  12: "#12 Inventory the widgets",
  13: "#13 Build the widget store",
  14: "#14 Wire the widget API",
  15: "#15 Ship the widget page",
  16: "#16 Calibrate against the device",
  17: "#17 Write the widget guide",
};
/** Where each step's card sits. #18 is complete (no card), #11 is the owner's (no card), #19–#20 are M02's. */
const COLUMN: Record<number, "backlog" | "running" | "review"> = { 12: "review", 13: "running", 14: "backlog", 15: "backlog", 16: "backlog", 17: "backlog" };

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function createCard(request: APIRequestContext, backend: E2EBackend, issue: number, workdir: string): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title: TITLES[issue], prompt: `Synthetic card for #${issue}.`, isolation: "none", workdir, agent: "claude-code" },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const { id } = (await res.json()) as { id: string };
  if (COLUMN[issue] !== "backlog") {
    const moved = await request.patch(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend), data: { column: COLUMN[issue] } });
    expect(moved.ok(), `PATCH /tasks/${id} -> ${moved.status()}: ${await moved.text()}`).toBeTruthy();
  }
  return id;
}

/** The status `roadmapPass` would publish for this board. */
function statusFor(ids: Record<number, string>, opts: { maxInFlight: number }): RoadmapStatus {
  const parsed = parseRoadmap(TRACKER);
  const states = new Map<number, RoadmapIssueState>(
    Object.keys(GH_MILESTONE).map((k) => {
      const n = Number(k);
      return [n, { state: n === 18 ? "CLOSED" : "OPEN", stateReason: n === 18 ? "COMPLETED" : null, url: `https://github.com/example/widgets/issues/${n}`, milestone: GH_MILESTONE[n] }];
    }),
  );
  const views = roadmapStatus(parsed, states);
  const steps = roadmapScope(parsed.steps, states, M01);
  const started = [12, 13];
  const busy = new Set(started);
  const backlog = new Map([14, 15, 16, 17].map((n) => [n, ids[n]!]));
  const cards = new Map(started.map((n) => [n, ids[n]!]));
  const nextMilestone = roadmapContinuation({ views, states, milestones: [M01], steps, busy, maxInFlight: opts.maxInFlight, finished: roadmapFinished(parsed, views.filter((v) => steps.has(v.step))) });
  return summarizeRoadmap({ issue: 600, url: "https://github.com/example/widgets/issues/600", parsed, views, scope: { milestones: [{ ...M01, total: steps.size }], steps }, busy, backlog, cards, needsUser: new Map(), nextMilestone, now: Date.now() });
}

let project = "";
let ids: Record<number, string> = {};

async function seedAutopilot(request: APIRequestContext, backend: E2EBackend, opts: { maxInFlight: number; offer: boolean }): Promise<RoadmapStatus> {
  const status = statusFor(ids, opts);
  if (!opts.offer) status.nextMilestone = null;
  await putPreference(request, backend, "autopilot_config_version", "2");
  await putPreference(request, backend, "autopilot", JSON.stringify({ enabled: true, project, roadmap: { issue: 600 }, milestone: M01, milestones: [M01], maxInFlight: opts.maxInFlight }));
  await putPreference(request, backend, "autopilot_state", JSON.stringify({ phase: "running", cards: [ids[12], ids[13]], roadmap: status, roadmapBacklog: Object.fromEntries([14, 15, 16, 17].map((n) => [String(n), ids[n]])) }));
  return status;
}

const card = (page: Page, issue: number) => page.locator(`[data-task-id="${ids[issue]}"]`);
const shot = async (page: Page, name: string, info: { outputPath: (...p: string[]) => string }) => {
  const dir = process.env.ROADMAP_SHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: dir ? path.join(dir, name) : info.outputPath(name) });
};
/** Load the app afresh. The boot URL differs only in its hash, which alone
 *  would be a same-document navigation — no reload, no new fetch. */
const openApp = async (page: Page, url: string) => {
  await page.goto("about:blank");
  await gotoApp(page, url);
  // The boot splash stays over the page for its minimum dwell and takes the
  // pointer meanwhile: a press on a card would land on it instead.
  await page.locator("#splash").waitFor({ state: "detached" });
};
/** Park the pointer where no card is. */
const pointerAway = (page: Page) => page.mouse.move(640, 8);

test.beforeAll(async ({ backend, playwright }) => {
  const request = await playwright.request.newContext();
  project = path.join(tmpdir(), `agetor-e2e-roadmap-${Date.now()}`);
  mkdirSync(project, { recursive: true });
  ids = {};
  for (const n of [12, 13, 14, 15, 16, 17]) ids[n] = await createCard(request, backend, n, project);
  await request.dispose();
});

test.describe("blocker lines", () => {
  test.beforeEach(async ({ page, request, backend }) => {
    await putPreference(request, backend, "theme", "light");
    await seedAutopilot(request, backend, { maxInFlight: 2, offer: false });
    await page.setViewportSize({ width: 1500, height: 900 });
    await openApp(page, backend.bootBase);
    await expect(card(page, 15)).toBeVisible();
    // The seeded status reached the page: a backlog card says what it waits on.
    await expect(card(page, 15).getByTestId("card-status")).toContainText("Step 5 · waits on steps 3 (#13), 4 (#14), 9 (#19)");
    // The Needs-you strip (the owner's step 1) loads on its own and pushes
    // the board down: wait for it, so no card moves under a measured point.
    await expect(page.getByTestId("roadmap-needs-you")).toBeVisible();
  });

  test("hovering a card draws a line to each card it waits on, wherever it is, and a dashed one to each it blocks", async ({ page }, info) => {
    await expect(page.getByTestId("blocker-lines")).toHaveCount(0); // nothing until a card is hovered
    await card(page, 15).hover();
    await expect(page.getByTestId("blocker-lines")).toBeVisible();
    // Step 5 waits on step 3 (Running) and step 4 (Backlog), and blocks steps 6 and 7 (Backlog).
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(2);
    await expect(page.getByTestId("blocker-line-blocks")).toHaveCount(2);
    await expect(page.getByTestId("blocker-target-waits")).toHaveCount(2);
    await expect(page.getByTestId("blocker-target-blocks")).toHaveCount(2);
    // The solid and the dashed style.
    await expect(page.getByTestId("blocker-line-waits").first().locator("path").nth(1)).not.toHaveAttribute("stroke-dasharray", /.+/);
    await expect(page.getByTestId("blocker-line-blocks").first().locator("path").nth(1)).toHaveAttribute("stroke-dasharray", "6 4");

    // A line really ends on the card it points at: the waiting line from step 3's card (Running) arrives at step 5's.
    const ends = await page.getByTestId("blocker-line-waits").evaluateAll((gs) => gs.map((g) => g.querySelector("circle")!.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })));
    const running = (await card(page, 13).boundingBox())!;
    const onRunningCard = ends.some((p) => Math.abs(p.x - running.x) < 4 && p.y > running.y && p.y < running.y + running.height);
    expect(onRunningCard, `a waits line starts on the Running card's left edge (ends: ${JSON.stringify(ends)}, card: ${JSON.stringify(running)})`).toBe(true);

    // The panel lists every predecessor — the one in another milestone has no card, so no line, but it is named.
    const panel = page.getByTestId("blocker-panel");
    await expect(panel.getByTestId("blocker-rows-waits")).toContainText("3 · #13 Build the widget store — in flight");
    await expect(panel.getByTestId("blocker-rows-waits")).toContainText("4 · #14 Wire the widget API — in the backlog");
    await expect(panel.getByTestId("blocker-rows-waits")).toContainText("9 · #19 Design the gadget dock — open in another milestone (M02)");
    await expect(panel.getByTestId("blocker-rows-blocks")).toContainText("6 · #16 Calibrate against the device — in the backlog");
    await expect(panel.getByTestId("blocker-rows-blocks")).toContainText("7 · #17 Write the widget guide — in the backlog");
    await shot(page, "01-hover-step5-light.png", info);

    // The overlay takes no pointer events: the card under the lines is still what the pointer hits.
    const hit = await card(page, 15).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && el.contains(top);
    });
    expect(hit).toBe(true);

    // Leaving the card clears everything.
    await pointerAway(page);
    await expect(page.getByTestId("blocker-lines")).toHaveCount(0);
    await expect(page.getByTestId("blocker-panel")).toHaveCount(0);
  });

  test("the owner's step and a finished step are listed without a line; Shift follows the whole chain", async ({ page }, info) => {
    // Step 6 waits on the owner's step 1 (no card) and on step 5.
    await card(page, 16).hover();
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(1);
    await expect(page.getByTestId("blocker-line-blocks")).toHaveCount(0);
    await expect(page.getByTestId("blocker-rows-waits")).toContainText("1 · #11 [Human] Provide the sample device — yours to do");
    await expect(page.getByTestId("blocker-panel")).toContainText("Hold Shift for the whole chain");
    await shot(page, "02-hover-step6-owner-step.png", info);

    await page.keyboard.down("Shift");
    await expect(page.getByTestId("blocker-panel")).toContainText("Showing the whole chain");
    // 5→6, then 3→5 and 4→5, then 2→3 and 2→4.
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(5);
    await expect(page.locator('[data-testid="blocker-line-waits"][data-depth="1"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="blocker-line-waits"][data-depth="3"]')).toHaveCount(2);
    await shot(page, "03-hover-step6-shift-chain.png", info);
    await page.keyboard.up("Shift");
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(1);

    // A card in another column works the same: step 2 (In Review) blocks steps 3 and 4.
    await card(page, 12).hover();
    await expect(page.getByTestId("blocker-line-blocks")).toHaveCount(2);
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(0);
    await expect(page.getByTestId("blocker-panel")).toContainText("Waits on nothing");
    await shot(page, "04-hover-step2-in-review.png", info);
  });

  test("keyboard focus shows the same lines; a click doesn't leave them up", async ({ page }, info) => {
    await card(page, 14).focus();
    // `.focus()` alone isn't keyboard focus; a Tab away and back is.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(card(page, 14)).toBeFocused();
    await expect(page.getByTestId("blocker-lines")).toBeVisible();
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(1); // step 4 waits on step 2 (In Review)
    await expect(page.getByTestId("blocker-line-blocks")).toHaveCount(1); // and blocks step 5
    await shot(page, "05-keyboard-focus-step4.png", info);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("blocker-lines")).toHaveCount(0);
  });

  test("a card scrolled out of view: the line stops at the board's edge with a label", async ({ page }, info) => {
    await page.setViewportSize({ width: 1500, height: 440 });
    // Scroll the board down to the last Backlog card (step 4). The card it
    // waits on — step 2, at the top of In Review — is now above the fold.
    const scroller = page.locator(".kanban-scroll");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await scroller.evaluate((el) => el.scrollTop), "the board scrolls vertically at this height").toBeGreaterThan(100);
    await expect(card(page, 12)).not.toBeInViewport();
    await card(page, 14).hover();
    await expect(page.getByTestId("blocker-lines")).toBeVisible();
    const clipped = page.locator('[data-testid="blocker-line-waits"][data-clipped="top"]');
    await expect(clipped).toHaveCount(1);
    await expect(clipped.getByTestId("blocker-clipped-label")).toHaveText("↑ step 2 · #12");
    await expect(page.getByTestId("blocker-target-waits")).toHaveCount(0); // no outline for a card that isn't in view
    await shot(page, "06-clipped-at-edge.png", info);

    // Scrolling moves the cards; the lines follow without the pointer moving
    // (or go, once the card is no longer under the pointer).
    const before = await clipped.locator("path").first().getAttribute("d");
    await page.mouse.wheel(0, -40);
    await expect
      .poll(async () => {
        const lines = page.getByTestId("blocker-line-waits");
        return (await lines.count()) === 0 || (await lines.first().locator("path").first().getAttribute("d")) !== before;
      })
      .toBe(true);
  });

  test("dark theme uses the same tokens", async ({ page, request, backend }, info) => {
    await putPreference(request, backend, "theme", "dark");
    // The dev page settles its theme from the hash before first paint.
    await openApp(page, `${backend.bootBase}&theme=dark`);
    await card(page, 15).hover();
    await expect(page.getByTestId("blocker-line-waits")).toHaveCount(2);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await shot(page, "07-hover-step5-dark.png", info);
  });

  test("dragging a card still works under the overlay", async ({ page, request, backend }) => {
    // Step 7's card, from the Backlog into In Review — a column fully in
    // view, so the drop isn't racing the board's edge auto-scroll.
    const start = (await card(page, 17).boundingBox())!;
    const to = (await page.locator("h2", { hasText: /^In Review$/ }).boundingBox())!;
    await page.mouse.move(start.x + 40, start.y + 20);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 40, { steps: 4 });
    await expect(card(page, 17)).toHaveClass(/opacity-50/); // it is being dragged
    // While a button is down no lines are drawn — though the pointer is on a card with links.
    await expect(page.getByTestId("blocker-lines")).toHaveCount(0);
    await page.mouse.move(to.x + 60, to.y + 220, { steps: 12 });
    await page.mouse.move(to.x + 64, to.y + 224, { steps: 2 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const res = await request.get(`${backend.apiBase}/tasks/${ids[17]}`, { headers: auth(backend) });
        return ((await res.json()) as { column: string }).column;
      })
      .toBe("review");
    // Put it back for the tests that follow.
    const back = await request.patch(`${backend.apiBase}/tasks/${ids[17]}`, { headers: auth(backend), data: { column: "backlog" } });
    expect(back.ok()).toBeTruthy();
  });
});

test.describe("next-milestone prompt", () => {
  test.beforeEach(async ({ page, request, backend }) => {
    await putPreference(request, backend, "theme", "light");
    await page.setViewportSize({ width: 1500, height: 900 });
  });

  test("not shown while the milestone can still fill its slots", async ({ page, request, backend }) => {
    // Four steps left to start, two slots.
    const status = await seedAutopilot(request, backend, { maxInFlight: 2, offer: true });
    expect(status.nextMilestone).toMatchObject({ number: 2, left: 4, reason: null });
    await openApp(page, backend.bootBase);
    await expect(card(page, 15)).toBeVisible();
    await expect(page.getByTestId("next-milestone-prompt")).toHaveCount(0);
  });

  test("offered from the server's status; Not now is remembered across a reload", async ({ page, request, backend }, info) => {
    // Four steps left to start, five slots: the milestone can't fill them.
    const status = await seedAutopilot(request, backend, { maxInFlight: 5, offer: true });
    expect(status.nextMilestone).toMatchObject({ number: 2, left: 4, reason: "nearly-done", startable: 1 });
    await openApp(page, backend.bootBase);
    const prompt = page.getByTestId("next-milestone-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByTestId("next-milestone-question")).toHaveText("M01 is nearly done (4 steps left to start). Start M02 — Gadget dock (2 steps) as well?");
    await expect(prompt.getByTestId("next-milestone-detail")).toContainText("1 of its 2 agent steps can start now");
    await expect(prompt.getByTestId("next-milestone-accept")).toHaveText("Start M02");
    await expect(prompt.getByTestId("next-milestone-always")).toHaveText("Always continue");
    await shot(page, "08-next-milestone-prompt.png", info);
    // It doesn't cover the board's cards or stop them being hovered.
    await card(page, 15).hover();
    await expect(page.getByTestId("blocker-lines")).toBeVisible();
    await shot(page, "09-prompt-with-lines.png", info);
    await pointerAway(page);

    await prompt.getByTestId("next-milestone-dismiss").click();
    await expect(prompt).toHaveCount(0);
    const prefs = await getPreferences(request, backend);
    expect(JSON.parse(prefs.autopilot_state!).roadmapOffer).toMatchObject({ milestone: 2, reason: "nearly-done" });
    expect(JSON.parse(prefs.autopilot!).milestones).toEqual([M01]); // the scope is untouched
    // The answer lives on the server: a reload doesn't ask again.
    await openApp(page, backend.bootBase);
    await expect(card(page, 15)).toBeVisible();
    await expect(page.getByTestId("next-milestone-prompt")).toHaveCount(0);
  });

  test("Start adds the milestone to the scope; Always continue also stops the asking", async ({ page, request, backend }, info) => {
    await seedAutopilot(request, backend, { maxInFlight: 5, offer: true });
    await openApp(page, backend.bootBase);
    await page.getByTestId("next-milestone-accept").click();
    await expect(page.getByTestId("next-milestone-prompt")).toHaveCount(0);
    await expect(page.getByText("M02 — Gadget dock is in scope with M01", { exact: false })).toBeVisible();
    await shot(page, "10-after-accept-toast.png", info);
    let cfg = JSON.parse((await getPreferences(request, backend)).autopilot!);
    expect(cfg.milestones).toEqual([M01, M02]); // added, not replaced
    // The cards keep their roadmap lines while the next pass is on its way.
    await expect(card(page, 15).getByTestId("card-status")).toContainText("Step 5 · waits on steps 3 (#13)");
    expect(cfg.milestone).toEqual(M01);
    expect(cfg.autoContinue ?? false).toBe(false);
    expect(cfg.enabled).toBe(true);

    await seedAutopilot(request, backend, { maxInFlight: 5, offer: true });
    await openApp(page, backend.bootBase);
    await page.getByTestId("next-milestone-always").click();
    await expect(page.getByTestId("next-milestone-prompt")).toHaveCount(0);
    cfg = JSON.parse((await getPreferences(request, backend)).autopilot!);
    expect(cfg.milestones).toEqual([M01, M02]);
    expect(cfg.autoContinue).toBe(true);
    // The Autopilot dialog shows the scope and the switch.
    await page.getByTestId("autopilot-button").click();
    await expect(page.getByTestId("autopilot-scope-list")).toContainText("M01 — Widget foundations + M02 — Gadget dock");
    await expect(page.getByTestId("autopilot-auto-continue")).toBeChecked();
    await shot(page, "11-autopilot-dialog-scope.png", info);
  });
});
