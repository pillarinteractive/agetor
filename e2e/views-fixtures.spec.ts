import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The pipeline run view and the Velocity view on their fixture pages
 * (src/mainview/fixtures/run.html, velocity.html): every state, rendered by
 * the real components from made-up data. No backend: this spec imports
 * Playwright's own `test`, not ./fixtures, so no headless core is started
 * and nothing a button does leaves the page.
 *
 * Layout is asserted through geometry and DOM state, never pixels (Chromium
 * here, WKWebView in the app). The screenshots are for a person to look at:
 * they go to `VIEWS_SHOTS_DIR` when that is set.
 *
 * The clock is fixed, so every elapsed time and retry time on the page is
 * the same on every run.
 */

const NOW = new Date(2031, 2, 4, 15, 0);
const SHOTS_DIR = process.env.VIEWS_SHOTS_DIR;
const RUN_CASES = ["executing", "ci", "dependency", "auto-retry", "recheck", "step-cap", "needs-input", "failed", "cancelled", "loop", "fanout", "done", "ci-failed", "not-started", "long"];
const VIEW = '[data-testid="pipeline-run-view"], [data-testid="velocity-view"]';

async function open(page: Page, url: string, size = { width: 1440, height: 1000 }) {
  await page.setViewportSize(size);
  await page.clock.setFixedTime(NOW);
  await page.goto(url);
  await expect(page.locator(VIEW)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
const run = (page: Page, name: string, extra = "", size?: { width: number; height: number }) => open(page, `/fixtures/run.html?case=${name}${extra}`, size);
const velocity = (page: Page, query = "", size?: { width: number; height: number }) => open(page, `/fixtures/velocity.html${query}`, size);
const notice = (page: Page) => page.getByTestId("fixture-notice");

/** The view scrolls inside itself: grow the window until all of it shows. */
async function shot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  const size = page.viewportSize()!;
  const more = await page.locator(VIEW).evaluate((el) => el.scrollHeight - el.clientHeight);
  if (more > 0) await page.setViewportSize({ width: size.width, height: size.height + more + 4 });
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
  await page.setViewportSize(size);
}

/** Nothing spills: the page and the view have no sideways scroll, and no
 *  text or control sticks out of the view's column. */
async function expectNoOverflow(page: Page) {
  const report = await page.evaluate((sel) => {
    const view = document.querySelector<HTMLElement>(sel)!;
    const frame = view.firstElementChild!.getBoundingClientRect();
    const spills = [...view.querySelectorAll<HTMLElement>("h2, h3, h4, p, li, dd, dt, button, span, pre, summary")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < frame.left - 0.5 || r.right > frame.right + 0.5);
      })
      .map((el) => `${el.tagName} ${el.dataset.testid ?? ""} ${el.textContent?.slice(0, 40)}`);
    return { page: document.documentElement.scrollWidth - window.innerWidth, view: view.scrollWidth - view.clientWidth, spills };
  }, VIEW);
  expect(report.page, "the page itself must not scroll sideways").toBeLessThanOrEqual(0);
  expect(report.view, "the view must not scroll sideways").toBeLessThanOrEqual(0);
  expect(report.spills, "elements sticking out of the view's column").toEqual([]);
}

/** Press Tab `n` times; the test id (or role and name) of what has the focus each time. */
async function tabStops(page: Page, n: number): Promise<string[]> {
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return "none";
        return [el.dataset.testid ?? el.tagName.toLowerCase(), el.dataset.stepId ?? el.dataset.action ?? ""].filter(Boolean).join(":");
      }),
    );
  }
  return stops;
}

test.describe("run view fixtures", () => {
  for (const name of RUN_CASES) {
    test(`${name}: the band's label and colour are the board card's, and its tile agrees`, async ({ page }) => {
      await run(page, name, "&card=1", { width: 1440, height: 1500 });
      const band = page.getByTestId("pipeline-run-state");
      const card = page.getByTestId("fixture-card").getByTestId("task-card");
      const cardBand = card.getByTestId("card-state");
      const label = (await cardBand.innerText()).trim();
      await expect(page.getByTestId("pipeline-run-state-label")).toHaveText(label);
      expect(await band.getAttribute("data-state")).toBe(await card.getAttribute("data-state"));
      expect(await band.getAttribute("data-state-kind")).toBe(await card.getAttribute("data-state-kind"));
      const paint = (el: Element) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color];
      expect(await band.evaluate(paint)).toEqual(await cardBand.evaluate(paint));
      // A state reads without colour: its label, and an icon beside it.
      await expect(band.locator("p").first().locator("svg")).toHaveCount(1);
      await expect(page.getByTestId("pipeline-run-state-reason")).toHaveText((await card.getByTestId("card-status").getAttribute("title"))!);
      await expect(page.getByTestId("pipeline-run-hold-state")).toHaveText(label);
      // The tile of the step the card is on says the same; a fan-out has no single such step.
      const step = await page.getByTestId("pipeline-run-state-step").count();
      if (step > 0 && name !== "fanout" && name !== "done" && name !== "ci-failed") {
        const current = page.locator('[data-testid="pipeline-run-step-tile"][data-current="true"]');
        await expect(current).toHaveCount(1);
        await expect(current).toHaveAttribute("data-state", (await band.getAttribute("data-state"))!);
        await expect(current.locator("span").first()).toHaveText(label);
      }
    });
  }

  test("recovery: one Retry per state, named for what it does; nothing else in the band changes the run", async ({ page }) => {
    // case → [the band's buttons as action:label, …]
    const expected: Record<string, string[]> = {
      executing: ["stop:Stop"],
      ci: ["view-pr:Inspect CI", "stop:Stop"],
      dependency: ["open-dependency:Open dependency", "retry-now:Retry Review now"],
      "auto-retry": ["retry-now:Retry Build now"],
      recheck: ["recheck:Recheck now"],
      "step-cap": ["extend-cap:Extend cap"],
      "needs-input": ["open-step:Answer (2)", "stop:Stop"],
      failed: ["retry:Retry Build"],
      cancelled: ["resume:Resume Build"],
      loop: ["stop:Stop"],
      fanout: ["stop:Stop"],
      done: ["view-pr:Review PR"],
      "ci-failed": ["fix-ci:Fix CI"],
      "not-started": ["run:Run"],
    };
    for (const [name, buttons] of Object.entries(expected)) {
      await run(page, name);
      const found = await page.getByTestId("pipeline-run-actions").locator("button").evaluateAll((els) => els.map((el) => `${(el as HTMLElement).dataset.action}:${el.textContent}`));
      expect(found, name).toEqual(buttons);
      // The whole page has at most one Retry, and it is in the band.
      expect(await page.getByTestId("pipeline-run-retry").count(), name).toBeLessThanOrEqual(1);
      expect(await page.getByRole("button", { name: /^(Retry|Resume|Recheck|Extend)/ }).count(), name).toBe(await page.getByTestId("pipeline-run-retry").count());
      // Restart and Advance are never in the band, and never open by default.
      await expect(page.getByTestId("pipeline-run-actions").getByText(/Restart|Advance/), name).toHaveCount(0);
      await expect(page.getByTestId("pipeline-run-advance"), name).toHaveCount(0);
    }
  });

  test("the retry flavours say what they do, and Recheck says it is the retry request", async ({ page }) => {
    await run(page, "recheck");
    const recheck = page.getByTestId("pipeline-run-retry");
    await expect(recheck).toHaveAttribute("title", /This is the retry request: it also retries any other blocked execution of this run\. It does not skip the input or restart the pipeline\./);
    await recheck.click();
    await expect(notice(page)).toHaveText("Preview: send the retry request. Nothing was started.");
    await run(page, "failed");
    await expect(page.getByTestId("pipeline-run-retry")).toHaveAttribute("title", "Runs Build again in place. It does not restart the pipeline.");
    await page.getByTestId("pipeline-run-retry").click();
    await expect(notice(page)).toHaveText("Preview: send the retry request for step-2. Nothing was started.");
    await run(page, "step-cap");
    await expect(page.getByTestId("pipeline-run-retry")).toHaveAttribute("title", /another step allowance \(now step cap 28 of 28\)/);
    await expect(page.getByTestId("pipeline-run-state-facts")).toContainText("step cap 28 of 28");
    await run(page, "cancelled");
    await expect(page.getByTestId("pipeline-run-retry")).toHaveAttribute("title", "Continues Build where it was stopped. It does not restart the pipeline.");
  });

  test("Restart and Advance are under Advanced run controls, each behind its own step", async ({ page }) => {
    await run(page, "failed");
    const advanced = page.getByTestId("pipeline-run-advanced");
    await expect(advanced).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("pipeline-run-restart")).toBeHidden();
    await advanced.locator("summary").click();
    await expect(advanced).toContainText("These are not retries.");
    // Restart asks first (the page only reports that it would).
    await page.getByTestId("pipeline-run-restart").click();
    await expect(notice(page)).toHaveText("Preview: restart the pipeline (after its confirmation). Nothing was started.");
    // Advance opens a form; nothing is chosen and nothing is sent by opening it.
    await page.getByTestId("pipeline-run-advance-open").click();
    await expect(notice(page)).toHaveText("Preview: restart the pipeline (after its confirmation). Nothing was started.");
    const form = page.getByTestId("pipeline-run-advance");
    await expect(form.getByRole("button", { name: "Advance", exact: true })).toBeDisabled();
    await form.getByTestId("pipeline-run-advance-finish").click();
    await form.getByRole("button", { name: "Advance", exact: true }).click();
    await expect(notice(page)).toHaveText("Preview: advance step-2 to the end. Nothing was started.");
    // A running, a finished and an unstarted run: no Advance; Restart only where the server takes it.
    await run(page, "executing");
    await expect(page.getByTestId("pipeline-run-advanced")).toHaveCount(0);
    await run(page, "not-started");
    await expect(page.getByTestId("pipeline-run-advanced")).toHaveCount(0);
    await run(page, "done");
    await page.getByTestId("pipeline-run-advanced").locator("summary").click();
    await expect(page.getByTestId("pipeline-run-restart")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-advance-open")).toHaveCount(0);
  });

  test("executions are counted, loops are named, and nothing reads as a fraction of the steps", async ({ page }) => {
    await run(page, "loop");
    await expect(page.getByTestId("pipeline-run-facts")).toHaveText("Change: understand, build, review, finish · PR #1406 · 7 executions recorded · looped back 4 times");
    await expect(page.getByTestId("pipeline-run-facts")).not.toContainText("/");
    await expect(page.getByTestId("pipeline-run-state-step")).toHaveText("· Review · round 3");
    const tiles = page.getByTestId("pipeline-run-step-tile");
    await expect(tiles).toHaveText([/Handed off.*Understand.*Architect.*1 execution$/, /Handed off.*Build.*Sonnet Builder.*3 executions recorded/, /Working.*Review.*GPT Reviewer.*3 executions recorded/, /Not started.*Finish.*Finisher.*Not run yet/]);
    // The newest three executions, then all of them on request.
    const rows = page.getByTestId("pipeline-run-history-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("#7 Review · round 3");
    await page.getByTestId("pipeline-run-history-all").click();
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(4)).toContainText("Handed off to Build");
    // A fan-out: two current tiles and no single current step.
    await run(page, "fanout");
    await expect(page.locator('[data-testid="pipeline-run-step-tile"][data-current="true"]')).toHaveCount(2);
    await expect(page.getByText("several executions at once · no single current step")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-facts")).toContainText("several executions at once");
    // The step cap is the run's allowance, shown as such.
    await run(page, "step-cap");
    await expect(page.getByTestId("pipeline-run-step-cap")).toHaveText("Step cap28 of 28 executions started");
  });

  test("a wait is not an execution: the band and the hold say no agent is executing", async ({ page }) => {
    for (const name of ["auto-retry", "dependency", "recheck", "failed", "cancelled"]) {
      await run(page, name);
      await expect(page.getByTestId("pipeline-run-state-facts"), name).toContainText("no agent executing");
      await expect(page.getByTestId("pipeline-run-executing"), name).toHaveText("Agents executingnone");
    }
    await run(page, "executing");
    await expect(page.getByTestId("pipeline-run-state-facts")).not.toContainText("no agent executing");
    await expect(page.getByTestId("pipeline-run-executing")).toHaveText("Agents executing1");
    // Only the wait queue keeps a maximum number of attempts.
    await run(page, "auto-retry");
    await expect(page.getByTestId("pipeline-run-hold")).toContainText("1 of 3 used");
    await run(page, "recheck");
    await expect(page.getByTestId("pipeline-run-hold")).toContainText("32 · no maximum recorded");
  });

  test("selecting a step shows it, and says whether it is the current step or a recorded execution", async ({ page }) => {
    await run(page, "loop");
    await expect(page.getByTestId("pipeline-run-step-context")).toHaveAttribute("data-step-id", "review");
    await expect(page.getByTestId("pipeline-run-step-viewing")).toHaveText("Current step");
    await expect(page.getByTestId("pipeline-run-step-subagents")).toHaveText("Subagentsavailable: Scout · running: Scout");
    const build = page.locator('[data-testid="pipeline-run-step-tile"][data-step-id="build"]');
    await build.click();
    await expect(build).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pipeline-run-step-viewing")).toHaveText("Viewing recorded execution");
    await expect(page.getByTestId("pipeline-run-step-handoff")).toContainText("a recorded handoff, not an approval of the current head");
    await expect(page.getByTestId("pipeline-run-step-executions")).toHaveText("Executions3 executions recorded · latest #6, round 3");
    await page.getByTestId("pipeline-run-open-step").first().click();
    await expect(notice(page)).toHaveText("Preview: open the panel of step-6. Nothing was started.");
    await page.locator('[data-testid="pipeline-run-step-tile"][data-step-id="finish"]').click();
    await expect(page.getByTestId("pipeline-run-step-viewing")).toHaveText("Viewing a step that has not run");
    await expect(page.getByTestId("pipeline-run-step-not-started")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-step-subagents")).toHaveText("Subagentsnone configured");
  });

  test("Transcript: the step's final report and the way to the whole transcript", async ({ page }) => {
    await run(page, "done", "&tab=transcript");
    await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("pipeline-run-report")).toContainText("Opened PR #1406 with the frozen extension and its parity tests.");
    await page.getByTestId("pipeline-run-open-transcript").click();
    await expect(notice(page)).toHaveText("Preview: open the panel of step-4. Nothing was started.");
    // An execution still open has no final report yet, and says so.
    await run(page, "executing", "&tab=transcript");
    await expect(page.getByTestId("pipeline-run-report-none")).toHaveText("This execution is still open: it has no final report yet.");
  });

  test("Checks: the current head only from the PR watcher; a recorded pass never stands for it", async ({ page }) => {
    await run(page, "ci-failed", "&tab=checks");
    const current = page.getByTestId("pipeline-run-check-current");
    await expect(current).toHaveAttribute("data-status", "failing");
    await expect(current).toContainText("Checks failing: unit · also failing on develop: lint");
    await expect(current).toContainText("as of 2:57 PM on c41d09e");
    await expect(page.getByTestId("pipeline-run-checks")).toContainText("A recorded pass is history: it does not show that the current head passes.");
    const passed = page.locator('[data-testid="pipeline-run-check-row"][data-status="passing"]');
    await expect(passed).toHaveCount(1);
    await expect(passed).toHaveAttribute("data-current-head", "false");
    await expect(passed).toContainText("Passed · recorded");
    await expect(passed).toContainText("recorded, head not recorded");
    // A recorded result wears no result's colour: its chip is the neutral one.
    await expect(passed.locator("[data-state]")).toHaveAttribute("data-state", "queued");
    await expect(current.locator("[data-state]")).toHaveAttribute("data-state", "failed");
    // No pull request: unavailable, in words.
    await run(page, "failed", "&tab=checks");
    await expect(page.getByTestId("pipeline-run-check-current")).toHaveText("Unavailable: no pull request is known for this task.");
    // A step waiting on CI now is a wait, not a result.
    await run(page, "ci", "&tab=checks");
    await expect(page.locator('[data-testid="pipeline-run-check-row"][data-source="step-wait"]')).toContainText("Waiting now");
    await expect(page.getByTestId("pipeline-run-check-current")).toHaveAttribute("data-status", "running");
  });

  test("Files: what the handoff named, and no per-step file list is claimed", async ({ page }) => {
    await run(page, "done", "&tab=files");
    await expect(page.getByTestId("pipeline-run-files")).toContainText("docs/contract/operation-boundary.md");
    await expect(page.getByTestId("pipeline-run-files")).toContainText("A list of the files one step changed is unavailable: no diff is recorded per step.");
    await page.getByTestId("pipeline-run-view-changes").click();
    await expect(notice(page)).toHaveText("Preview: view the task's changes. Nothing was started.");
  });

  test("Graph & routing: the routes as a list, and available is not running", async ({ page }) => {
    await run(page, "loop");
    await expect(page.getByTestId("pipeline-run-presentation-steps")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("pipeline-run-presentation-graph").click();
    await expect(page.getByTestId("pipeline-run-presentation-graph")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pipeline-run-step-tiles")).toHaveCount(0);
    const routes = page.getByTestId("pipeline-run-routes").locator("li");
    await expect(routes).toHaveCount(6);
    await expect(routes.nth(1)).toHaveText("UnderstandFinish· trivial changenot taken");
    await expect(routes.nth(3)).toHaveText("ReviewBuild· changes requestedtaken 2 times");
    const delegation = page.getByTestId("pipeline-run-delegation");
    await expect(delegation).toContainText("Understand · available: Scout");
    await expect(delegation).toContainText("Review · available: Scout · running: Scout");
    await expect(delegation).toContainText("Available means a step may delegate to it. It does not mean a subagent is running.");
  });

  test("the follow-up composer follows the run: offered when done or blocked with nothing executing", async ({ page }) => {
    await run(page, "done");
    await expect(page.getByTestId("pipeline-followups")).toBeVisible();
    await page.getByTestId("pipeline-followup-action").filter({ hasText: "Run VM tests" }).click();
    await expect(notice(page)).toHaveText("Preview: start a follow-up (vm-tests). Nothing was started.");
    await expect(page.getByTestId("pipeline-followup-custom")).toBeDisabled();
    await run(page, "executing");
    await expect(page.getByTestId("pipeline-followups")).toHaveCount(0);
    await expect(page.getByTestId("pipeline-run-followup-unavailable")).toBeVisible();
    await run(page, "needs-input");
    await expect(page.getByTestId("pipeline-followups")).toHaveCount(0);
  });

  test("keyboard: Tab goes through the band's actions, the switch, the tiles, the tabs and on to the advanced controls", async ({ page }) => {
    await run(page, "dependency");
    await page.getByTestId("fixture-case").focus();
    expect(await tabStops(page, 15)).toEqual([
      "pipeline-run-back",
      "pipeline-run-task-details",
      "pipeline-run-action:open-dependency",
      "pipeline-run-retry:retry-now",
      "pipeline-run-presentation-steps",
      "pipeline-run-presentation-graph",
      "pipeline-run-step-tile:understand",
      "pipeline-run-step-tile:build",
      "pipeline-run-step-tile:review",
      "pipeline-run-step-tile:finish",
      "pipeline-run-tab-summary",
      "pipeline-run-tab-transcript",
      "pipeline-run-tab-checks",
      "pipeline-run-tab-files",
      "pipeline-run-open-step",
    ]);
    // Enter and Space activate: a tile, a tab, the switch, a band action.
    await page.locator('[data-testid="pipeline-run-step-tile"][data-step-id="build"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pipeline-run-step-context")).toHaveAttribute("data-step-id", "build");
    await page.getByTestId("pipeline-run-tab-checks").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("pipeline-run-tab-checks")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "run-step-tab-checks");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("pipeline-run-tab-files")).toBeFocused();
    await expect(page.getByTestId("pipeline-run-tab-files")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("pipeline-run-presentation-graph").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("pipeline-run-graph")).toBeVisible();
    await page.getByTestId("pipeline-run-retry").focus();
    await page.keyboard.press("Enter");
    await expect(notice(page)).toHaveText("Preview: send the retry request. Nothing was started.");
    // The advanced controls: the summary opens with the keyboard, and its buttons follow it.
    const summary = page.getByTestId("pipeline-run-advanced").locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    expect(await tabStops(page, 2)).toEqual(["pipeline-run-advance-open", "pipeline-run-restart"]);
  });

  for (const width of [1440, 720]) {
    test(`layout at ${width}px: nothing spills, and the hold comes ${width < 768 ? "before" : "beside"} the step's detail`, async ({ page }) => {
      for (const name of RUN_CASES) {
        await run(page, name, "", { width, height: 1000 });
        await expectNoOverflow(page);
      }
      await run(page, "long", "&presentation=graph", { width, height: 1000 });
      await expectNoOverflow(page);
      await run(page, "dependency", "", { width, height: 1000 });
      const hold = (await page.getByTestId("pipeline-run-hold").boundingBox())!;
      const context = (await page.getByTestId("pipeline-run-step-context").boundingBox())!;
      if (width < 768) expect(hold.y + hold.height).toBeLessThanOrEqual(context.y);
      else {
        expect(hold.x).toBeGreaterThan(context.x + context.width);
        expect(Math.abs(hold.y - context.y)).toBeLessThan(40);
      }
      // The tiles: one row when wide, two columns when narrow.
      const tops = await page.getByTestId("pipeline-run-step-tile").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(width < 768 ? 2 : 1);
    });
  }

  test("screenshots", async ({ page }) => {
    test.skip(!SHOTS_DIR, "set VIEWS_SHOTS_DIR to keep screenshots");
    test.setTimeout(240_000);
    const shots: [string, string][] = [
      ["executing", ""], ["ci", ""], ["dependency", ""], ["auto-retry", ""], ["recheck", ""], ["step-cap", ""], ["needs-input", ""], ["failed", ""], ["cancelled", ""], ["loop", ""], ["fanout", ""], ["done", ""], ["not-started", ""],
      ["ci-failed", "&tab=checks"], ["loop", "&presentation=graph"], ["long", ""],
    ];
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 720]) {
        for (const [name, extra] of shots) {
          await run(page, name, `${extra}${theme === "dark" ? "&theme=dark" : ""}`, { width, height: 900 });
          await shot(page, `run-${name}${extra.replace(/[&=]/g, "-")}-${width}-${theme}`);
        }
      }
    }
  });
});

test.describe("velocity fixtures", () => {
  test("whole roadmap: the forecast range, the report's own completion, rates, and where time goes", async ({ page }) => {
    await velocity(page);
    await expect(page.getByTestId("velocity-subtitle")).toHaveText(/^Roadmap #639 · snapshot Mar 4, 2:58 PM · run started 2\.8d ago$/);
    await expect(page.getByTestId("velocity-view-roadmap")).toHaveAttribute("aria-pressed", "true");
    const panel = page.getByTestId("velocity-forecast-panel");
    await expect(panel).toContainText("Whole roadmap forecast");
    await expect(page.getByTestId("velocity-forecast-range")).toHaveText(/days|hours/);
    await expect(panel).toContainText("a range, not a promised date");
    await expect(panel).toContainText(/Assumes .+ per human step \(the median of the 3 finished\)/);
    await expect(page.getByTestId("velocity-progress-count")).toHaveText("20 of 44 complete");
    await expect(page.getByTestId("velocity-progress").getByRole("img")).toHaveAttribute("aria-label", "Whole roadmap: 20 complete, 21 agent steps and 3 human steps remaining");
    await expect(page.getByTestId("velocity-rates")).toContainText("Agent steps · run-wide");
    await expect(page.getByTestId("velocity-rates")).toContainText("A trend is unavailable: the report keeps these three windows, not a history of rates.");
    await expect(page.getByTestId("velocity-rate-3d")).toContainText("the run is 2.8 days old, so this window is the whole run");
    await expect(page.getByTestId("velocity-tiles")).toContainText("of accumulated task time");
    // Four buckets; a legend button picks the detail line, and says it is pressed.
    const time = page.getByTestId("velocity-time");
    await expect(time.locator("[data-bucket]")).toHaveCount(4);
    await expect(page.getByTestId("velocity-bucket-held")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("velocity-bucket-other").click();
    await expect(page.getByTestId("velocity-bucket-other")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("velocity-bucket-held")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("velocity-bucket-detail")).toContainText("A median per step is unavailable for a group of phases.");
    await expect(page.getByTestId("velocity-bucket-detail")).toHaveAttribute("data-state", "queued");
    await expect(time).toContainText("This is accumulated task time: tasks run side by side, so it is longer than the calendar time that passed.");
    // The four segments fill the bar and sit on one line.
    const bar = await time.locator("[data-bucket]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), width: r.width })));
    expect(new Set(bar.map((b) => b.top)).size).toBe(1);
    await expectNoOverflow(page);
  });

  test("release gate: remaining steps and the forecast, and never a completion fraction or a bar", async ({ page }) => {
    await velocity(page);
    await page.getByTestId("velocity-view-gate").click();
    await expect(page.getByTestId("velocity-view-gate")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("velocity-forecast-panel")).toContainText("Release gate forecast");
    await expect(page.getByTestId("velocity-remaining-agent")).toHaveText("21");
    await expect(page.getByTestId("velocity-remaining-owner")).toHaveText("3");
    const progress = page.getByTestId("velocity-progress");
    await expect(progress).toContainText("Remaining on the release path");
    await expect(page.getByTestId("velocity-progress-count")).toHaveText("24 remaining");
    await expect(progress.getByRole("img")).toHaveCount(0);
    await expect(progress).not.toContainText(/\d+ of \d+|\d+\s*\/\s*\d+|%/);
    await expect(page.getByTestId("velocity-completion-unavailable")).toHaveText("Completion is not supplied for this scope: the report counts what remains on the path to the gate, not how much of it is done. No total is derived from the gate's step number.");
    // Everything else is the whole run's, and says so.
    await expect(page.getByTestId("velocity-tiles").getByText(/run-wide/)).toHaveCount(3);
    await expect(page.getByTestId("velocity-time")).toContainText("run-wide");
    await expect(page.getByTestId("velocity-slots")).toContainText("run-wide");
    await expect(page.getByTestId("velocity-bottlenecks")).toContainText("the whole roadmap, not only the release path");
  });

  test("move these next: each row is its card's state, with one action; a step with no card says unavailable", async ({ page }) => {
    await velocity(page);
    const rows = page.getByTestId("velocity-bottleneck");
    if ((await page.getByTestId("velocity-bottlenecks-all").count()) > 0) await page.getByTestId("velocity-bottlenecks-all").click();
    const seen = await rows.evaluateAll((els) =>
      els.map((el) => ({
        state: (el as HTMLElement).dataset.state,
        label: el.querySelector('[data-testid="velocity-bottleneck-state"]')!.textContent,
        icon: el.querySelectorAll('[data-testid="velocity-bottleneck-state"] svg').length,
        known: el.querySelector<HTMLElement>('[data-testid="velocity-bottleneck-reason"]')!.dataset.known,
        buttons: el.querySelectorAll("button").length,
        text: el.textContent ?? "",
      })),
    );
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const row of seen) {
      expect(row.icon, row.label ?? "").toBe(1);
      expect(row.text).toMatch(/\d+ steps? behind it|no step behind it/);
      expect(row.text).not.toContain("dependents");
      // A row with a card has exactly one action; one without has none and says why.
      if (row.known === "true") expect(row.buttons).toBe(1);
      else {
        expect(row.buttons).toBe(0);
        expect(row.text).toContain("unavailable");
      }
    }
    expect(seen.map((r) => `${r.state}:${r.label}`)).toEqual(expect.arrayContaining(["needs:Review PR", "working:Working", "needs:Yours to do"]));
    await expect(page.getByTestId("velocity-bottlenecks")).toContainText("These counts overlap: the same step can be behind several of these, and resolving one task does not start every step behind it.");
    await rows.filter({ hasText: "Review PR" }).first().getByTestId("velocity-bottleneck-action").click();
    await expect(notice(page)).toHaveText(/^Preview: Review PR — Issue #\d+\. Nothing was started\.$/);
  });

  test("capacity: occupied, not executing, over all observed time", async ({ page }) => {
    await velocity(page);
    const slots = page.getByTestId("velocity-slots");
    await expect(slots).toContainText("Execution capacity");
    await expect(slots).toContainText(/All observed time · \d/);
    await expect(slots).not.toContainText("48");
    await expect(page.getByTestId("velocity-occupied")).toHaveText(/^Slots occupied, on average\d\.\d of 3$/);
    await expect(slots.locator("[data-pip]")).toHaveCount(3);
    await expect(slots).toContainText("An occupied slot may be waiting, not executing.");
    await expect(slots).toContainText("went unobserved while the app was closed or Autopilot paused");
    await expect(page.getByTestId("velocity-view")).not.toContainText("Slots in use");
  });

  test("the details: the method is one press away, with every chart's numbers and the owner's assumption", async ({ page }) => {
    await velocity(page);
    const details = page.getByTestId("velocity-details");
    await expect(details).not.toHaveAttribute("open", "");
    await page.getByTestId("velocity-method-link").click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details.locator("> summary")).toBeFocused();
    await expect(page.getByTestId("velocity-forecast-gate")).toContainText("the main-release gate");
    await expect(page.getByTestId("velocity-forecast-roadmap")).toContainText("the whole roadmap");
    await expect(page.getByTestId("velocity-forecast-notes")).toContainText("An estimate, not a date");
    await expect(page.getByTestId("velocity-phase-owner")).toContainText("Held for you");
    await expect(page.getByTestId("velocity-phases")).toContainText("Accumulated task time over 17 steps: tasks run side by side, so it is longer than the calendar time that passed.");
    await expect(page.getByTestId("velocity-cycle")).toContainText(/median .+ · p75 .+ · p90 /);
    await expect(page.getByTestId("velocity-rework")).toContainText("review rounds per step");
    await expect(page.getByTestId("velocity-burnup")).toBeVisible();
    await expect(page.getByTestId("velocity-throughput")).toBeVisible();
    // The owner's assumed time per step: the panel and the range follow it.
    const before = await page.getByTestId("velocity-forecast-range").innerText();
    await page.getByTestId("velocity-owner-delay").fill("300");
    await page.getByTestId("velocity-owner-apply").click();
    await expect(page.getByTestId("velocity-forecast-panel")).toContainText("Assumes 12.5d per human step (your figure)");
    expect(await page.getByTestId("velocity-forecast-range").innerText()).not.toBe(before);
    await expectNoOverflow(page);
  });

  test("missing data is said in words: no forecast, no gate, no samples, no data", async ({ page }) => {
    await velocity(page, "?case=no-forecast");
    await expect(page.getByTestId("velocity-forecast-range")).toHaveText("Forecast unavailable");
    await expect(page.getByTestId("velocity-forecast-unavailable")).toHaveText(/^\d steps completed with a measured cycle time — not enough for a forecast \(it needs 5\)$/);
    await expect(page.getByTestId("velocity-forecast-panel")).toContainText("Remaining steps for this scope: unavailable");
    await expectNoOverflow(page);
    await velocity(page, "?case=no-gate&scope=gate");
    await expect(page.getByTestId("velocity-forecast-range")).toHaveText("Forecast unavailable");
    await expect(page.getByTestId("velocity-forecast-unavailable")).toHaveText("The report has no open release-gate step, so there is no forecast for this scope.");
    await expect(page.getByTestId("velocity-progress-count")).toHaveText("unavailable");
    await velocity(page, "?case=no-samples");
    await expect(page.getByTestId("velocity-occupied")).toHaveText("Slots occupied, on averageunavailable");
    await expect(page.getByTestId("velocity-slots")).toContainText("Unavailable: no slot samples yet.");
    await expect(page.getByTestId("velocity-slots").locator("[data-pip]")).toHaveCount(0);
    await velocity(page, "?case=empty");
    await expect(page.getByTestId("velocity-empty")).toHaveText("No velocity data yet — it is collected from the first Autopilot pass on");
    await expect(page.getByTestId("velocity-forecast-panel")).toHaveCount(0);
  });

  test("keyboard: Back, the scope switch, the method link, the legend and the rows' buttons, in order", async ({ page }) => {
    await velocity(page);
    await page.getByTestId("fixture-case").focus();
    expect(await tabStops(page, 8)).toEqual(["velocity-back", "velocity-view-gate", "velocity-view-roadmap", "velocity-method-link", "velocity-bucket-working", "velocity-bucket-held", "velocity-bucket-ci", "velocity-bucket-other"]);
    await page.getByTestId("velocity-view-gate").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("velocity-view-gate")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("velocity-view-roadmap")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("velocity-bucket-ci").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("velocity-bucket-detail")).toContainText("CI / merge queue:");
    await page.getByTestId("velocity-back").focus();
    await page.keyboard.press("Enter");
    await expect(notice(page)).toHaveText("Preview: go back to the board. Nothing was started.");
  });

  for (const width of [1440, 720]) {
    test(`layout at ${width}px: nothing spills in either theme or scope`, async ({ page }) => {
      for (const query of ["", "?scope=gate", "?theme=dark", "?case=no-forecast", "?case=no-samples"]) {
        await velocity(page, query, { width, height: 1000 });
        await page.getByTestId("velocity-details").locator("> summary").click();
        await expectNoOverflow(page);
      }
    });
  }

  test("screenshots", async ({ page }) => {
    test.skip(!SHOTS_DIR, "set VIEWS_SHOTS_DIR to keep screenshots");
    test.setTimeout(240_000);
    const shots: [string, string, boolean][] = [
      ["roadmap", "", false], ["gate", "?scope=gate", false], ["no-forecast", "?case=no-forecast", false], ["no-samples", "?case=no-samples", false], ["no-gate", "?case=no-gate&scope=gate", false], ["details", "", true],
    ];
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 720]) {
        for (const [name, query, details] of shots) {
          await velocity(page, `${query}${theme === "dark" ? `${query ? "&" : "?"}theme=dark` : ""}`, { width, height: 900 });
          if (details) await page.getByTestId("velocity-details").locator("> summary").click();
          await shot(page, `velocity-${name}-${width}-${theme}`);
        }
      }
    }
  });
});
