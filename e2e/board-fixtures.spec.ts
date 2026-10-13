import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The board's cards, columns and inspector on the fixture page
 * (src/mainview/fixtures/board.html): every card state, rendered by the real
 * components from made-up data. No backend: this spec imports Playwright's
 * own `test`, not ./fixtures, so no headless core is started and nothing a
 * button does leaves the page.
 *
 * Layout is asserted through geometry and DOM state, never pixels (Chromium
 * here, WKWebView in the app). The screenshots are for a person to look at:
 * they go to the test's output directory, and to `BOARD_SHOTS_DIR` too when
 * that is set.
 *
 * The clock is fixed, so every elapsed time and retry time on the page is
 * the same on every run.
 */

const FIXTURE = "/fixtures/board.html";
const NOW = new Date(2031, 2, 4, 15, 0);
const SHOTS_DIR = process.env.BOARD_SHOTS_DIR;

async function open(page: Page, query = "", size = { width: 1440, height: 1000 }) {
  await page.setViewportSize(size);
  await page.clock.setFixedTime(NOW);
  await page.goto(`${FIXTURE}${query}`);
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

const card = (page: Page, issue: number): Locator => page.locator(`[data-task-id="t${issue}"]`);
const column = (page: Page, id: string): Locator => page.locator(`[data-column-id="${id}"]`);

/** Nothing spills: the page has no sideways scroll of its own, and no card's
 *  content is wider than the card. */
async function expectNoOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="task-card"]')];
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      // The band, the body and the footer: the card's parts in the flow. (The
      // unread dot and the hover strip are positioned over the frame on purpose.)
      cards: cards
        .filter((c) => [...c.children].some((el) => getComputedStyle(el).position !== "absolute" && el.scrollWidth > el.clientWidth + 1))
        .map((c) => c.dataset.taskId),
      // A child that sticks out of its card's frame, e.g. an unbroken word.
      spills: cards
        .filter((c) => {
          const frame = c.getBoundingClientRect();
          return [...c.querySelectorAll<HTMLElement>("h3, p, [data-testid='card-step'], [data-testid='card-action'], [data-testid='card-state']")].some((el) => {
            const r = el.getBoundingClientRect();
            return r.left < frame.left - 0.5 || r.right > frame.right + 0.5;
          });
        })
        .map((c) => c.dataset.taskId),
    };
  });
  expect(report.page, "the page itself must not scroll sideways").toBeLessThanOrEqual(0);
  expect(report.cards, "cards whose content is wider than the card").toEqual([]);
  expect(report.spills, "cards with a line sticking out of the frame").toEqual([]);
}

test.describe("board fixtures", () => {
  test("every state is on the page, by label and icon, and is derived from the run, not the column", async ({ page }) => {
    await open(page);
    const expected: [number, string, string][] = [
      [1455, "queued", "Queued"],
      [1454, "queued", "Dependency"],
      [1458, "queued", "Stopped"],
      [933, "working", "Working"],
      [1326, "waiting", "Waiting on CI"],
      [1265, "waiting", "Waiting on command"],
      [1301, "needs", "Quiet"],
      [1340, "queued", "Queued"],
      [1346, "queued", "No activity yet"],
      [1293, "needs", "Step cap"],
      [1269, "needs", "Needs input"],
      [845, "waiting", "Auto retry"],
      [846, "waiting", "Auto retry"],
      [850, "waiting", "Auto retry"],
      [851, "waiting", "Dependency"],
      [860, "needs", "Needs you"],
      [861, "failed", "Failed"],
      [1031, "failed", "CI failed"],
      [1023, "needs", "Review PR"],
      [1024, "needs", "Review comments"],
      [1025, "needs", "No PR yet"],
      [1026, "needs", "PR closed"],
      [816, "waiting", "Opening PR"],
      [1285, "waiting", "Updating branch"],
      [1286, "waiting", "Waiting on CI"],
      [1287, "waiting", "In merge train"],
      [892, "merged", "Merged"],
      [1352, "queued", "Done"],
    ];
    for (const [issue, state, label] of expected) {
      const c = card(page, issue);
      await expect(c, `#${issue}`).toHaveAttribute("data-state", state);
      const band = c.getByTestId("card-state");
      await expect(band, `#${issue}`).toHaveText(label);
      // The state reads without colour: a label, and an icon beside it.
      await expect(band.locator("svg"), `#${issue}`).toHaveCount(1);
    }
    // Three cards in the Blocked column, three different states: one retries
    // by itself (blue), one waits on the owner (amber), one failed (red).
    const tint = (issue: number) => card(page, issue).getByTestId("card-state").evaluate((el) => getComputedStyle(el).backgroundColor);
    const [retrying, needsYou, failed] = [await tint(845), await tint(860), await tint(861)];
    expect(new Set([retrying, needsYou, failed]).size).toBe(3);
    // In the Running column, a card parked on CI is not a working one.
    expect(await tint(1326)).toBe(retrying);
    expect(await tint(933)).not.toBe(retrying);
    await shot(page, "states-1440-light");
  });

  test("a card shows its step, its strip and one action or its agent", async ({ page }) => {
    await open(page);
    const working = card(page, 933);
    await expect(working.getByTestId("card-step")).toHaveText("StepBuild2m");
    await expect(working.getByTestId("card-strip").locator("span")).toHaveCount(4);
    await expect(working.getByTestId("card-strip").locator('[data-status="done"]')).toHaveCount(1);
    await expect(working.getByTestId("card-strip").locator('[data-status="current"]')).toHaveCount(1);
    await expect(working.getByTestId("card-pr-number")).toHaveText("PR 1399");
    // Working needs nothing from the owner: no button, the agent's name instead.
    await expect(working.getByTestId("card-action")).toHaveCount(0);
    await expect(working.getByTestId("task-card-pipeline")).toHaveText("Sonnet Builder");
    // A loop back: the round is named, and the steps ahead are to do again.
    await expect(card(page, 1279).getByTestId("card-step")).toContainText("Review· round 2");
    // Recovery wording: a stopped step is resumed, a capped one retried.
    await expect(card(page, 1458).getByTestId("card-action")).toHaveText("Resume Build");
    await expect(card(page, 1293).getByTestId("card-action")).toHaveText("Retry Review");
    await expect(card(page, 1031).getByTestId("card-action")).toHaveText("Fix CI");
    await expect(card(page, 845).getByTestId("card-action")).toHaveText("Inspect retry");
    // A task without a pipeline has no step and no strip.
    await expect(card(page, 1345).getByTestId("card-step")).toHaveText("No pipeline");
    await expect(card(page, 1345).getByTestId("card-strip")).toHaveCount(0);
    // The strip sits inside the card's padding, as wide as the title.
    const strip = (await working.getByTestId("card-strip").boundingBox())!;
    const title = (await working.locator("h3").boundingBox())!;
    expect(Math.abs(strip.x - title.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(strip.width - title.width)).toBeLessThanOrEqual(1);
  });

  test("columns: sentence-case names, a count and a summary of their cards' states", async ({ page }) => {
    await open(page);
    await expect(page.locator("h2")).toHaveText(["Backlog", "Running", "Blocked", "In review", "Merge queue", "Done"]);
    await expect(column(page, "blocked").getByTestId("column-count")).toHaveText("8");
    await expect(column(page, "blocked").getByTestId("column-summary")).toHaveText("3 need you · 1 failed · 4 waiting");
    await expect(column(page, "running").getByTestId("column-summary")).toHaveText("1 needs you · 3 working · 2 waiting · 2 queued");
    await expect(column(page, "done").getByTestId("column-summary")).toHaveText("1 queued · 2 merged");
  });

  test("a click selects and opens the inspector; a double click opens the run; the button acts", async ({ page }) => {
    await open(page);
    const inspector = page.getByTestId("card-inspector");
    await expect(inspector).toHaveCount(0);
    await card(page, 1293).locator("h3").click();
    await expect(card(page, 1293)).toHaveAttribute("data-selected", "true");
    // Selected reads as an outline around the card, separate from its state's border.
    expect(await card(page, 1293).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    expect(await card(page, 1455).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    await expect(inspector.getByTestId("inspector-status")).toHaveText("Status: Blocked");
    await expect(inspector.getByTestId("inspector-step")).toHaveText("Step: Review");
    await expect(inspector.getByTestId("inspector-state")).toHaveText("State: Step cap");
    await expect(inspector.getByTestId("inspector-recovery-note")).toHaveText("Retry resumes Review with another step allowance. It does not restart the pipeline.");
    await expect(inspector.getByTestId("inspector-restart")).toHaveText("Restart pipeline…");
    await expect(inspector.getByTestId("inspector-pr")).toContainText("Checked3m ago");
    // A stopped card: resuming its step and restarting the pipeline are two buttons.
    await card(page, 1458).locator("h3").click();
    await expect(inspector.getByTestId("inspector-primary")).toHaveText("Resume Build");
    await expect(inspector.getByTestId("inspector-recovery-note")).toContainText("Resume continues Build where it was stopped. Restart pipeline starts again from the first step");
    // A card retrying by itself: the schedule.
    await card(page, 845).getByTestId("card-action").click();
    await expect(card(page, 845)).toHaveAttribute("data-selected", "true");
    await expect(inspector.getByTestId("inspector-retry-schedule")).toContainText("Next retry3:18 PM");
    await expect(inspector.getByTestId("inspector-retry-schedule")).toContainText("1 of 3 used");
    await expect(inspector.getByTestId("inspector-recovery-note")).toContainText("Nothing is needed from you");
    await shot(page, "inspector-auto-retry-1440-light");

    const notice = page.getByTestId("fixture-notice");
    await card(page, 1031).getByTestId("card-action").click();
    await expect(notice).toHaveText("Preview: Fix CI — Issue #1031. Nothing was started.");
    // The button did not select its card.
    await expect(card(page, 845)).toHaveAttribute("data-selected", "true");
    await card(page, 933).locator("h3").dblclick();
    await expect(notice).toHaveText("Preview: open the run — Issue #933. Nothing was started.");
    await inspector.getByTestId("inspector-close").click();
    await expect(inspector).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test("a double click on a card the inspector then covers still opens the run, and presses nothing", async ({ page }) => {
    await open(page, "", { width: 1440, height: 760 });
    const title = card(page, 845).locator("h3");
    const at = (await title.boundingBox())!;
    await title.dblclick();
    // The first click opened the inspector over the point that was clicked…
    const inspector = (await page.getByTestId("card-inspector").boundingBox())!;
    expect(inspector.y).toBeLessThan(at.y);
    // …and the second one still meant "open": no inspector button took it.
    await expect(page.getByTestId("fixture-notice")).toHaveText("Preview: open the run — Issue #845. Nothing was started.");
    // After that, the inspector's buttons are ordinary buttons again.
    await page.getByTestId("inspector-open").click();
    await page.getByTestId("inspector-retry").dblclick();
    await expect(page.getByTestId("fixture-notice")).toHaveText("Preview: Retry — Issue #845. Nothing was started.");
  });

  test("keyboard: Tab to a card, Enter selects, Tab reaches its button, Escape closes the inspector", async ({ page }) => {
    await open(page);
    const first = card(page, 1455);
    // Tab from the top of the page until the first card has the focus.
    await expect(async () => {
      await page.keyboard.press("Tab");
      await expect(first).toBeFocused({ timeout: 250 });
    }).toPass();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("card-inspector")).toBeVisible();
    await expect(first).toHaveAttribute("data-selected", "true");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(first.getByTestId("card-action")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("fixture-notice")).toHaveText("Preview: Run — Issue #1455. Nothing was started.");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-inspector")).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 1100, 820]) {
      test(`layout at ${width}px, ${theme}: columns stay in one row, at least 11.5rem wide, and the board scrolls sideways`, async ({ page }) => {
        await open(page, theme === "dark" ? "?theme=dark&select=t1293" : "?select=t1293", { width, height: 1000 });
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/);
        const boxes = await page.locator("[data-column-id]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, width: r.width })));
        expect(boxes).toHaveLength(6);
        expect(new Set(boxes.map((b) => Math.round(b.top))).size, "no wrapping").toBe(1);
        for (const b of boxes) expect(b.width).toBeGreaterThanOrEqual(184);
        const scroller = await page.locator(".kanban-scroll").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        if (width < 1173) expect(scroller.scroll).toBeGreaterThan(scroller.client);
        else expect(scroller.scroll).toBe(scroller.client);
        await expect(page.getByTestId("card-inspector")).toBeVisible();
        await expectNoOverflow(page);
        await shot(page, `board-${width}-${theme}`);
      });
    }
  }

  test("long titles, reasons and names are clamped inside the card", async ({ page }) => {
    await open(page, "?case=long&select=t861", { width: 1440, height: 1400 });
    await expectNoOverflow(page);
    const heights = await page.locator('[data-testid="task-card"] h3').evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) })));
    for (const { h, line } of heights) expect(h).toBeLessThanOrEqual(line * 2 + 1);
    const reasons = await page.locator('[data-testid="card-status"]').evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) })));
    for (const { h, line } of reasons) expect(h).toBeLessThanOrEqual(line * 2 + 1);
    // The card's line is cut short; the inspector has the step's words in full.
    await expect(page.getByTestId("inspector-reason")).toContainText("…");
    await expect(page.getByTestId("card-inspector")).toContainText("a very long stack trace that goes on and on");
    await shot(page, "long-1440-light");
    await open(page, "?case=long&theme=dark", { width: 820, height: 1400 });
    await expectNoOverflow(page);
    await shot(page, "long-820-dark");
  });

  test("a 60-card backlog stays on the board and scrolls with it", async ({ page }) => {
    await open(page, "?case=backlog");
    await expect(column(page, "backlog").getByTestId("column-count")).toHaveText("62");
    await expect(column(page, "backlog").getByTestId("task-card")).toHaveCount(62);
    await expectNoOverflow(page);
    await shot(page, "backlog60-1440-light");
    await card(page, 1461).scrollIntoViewIfNeeded();
    await expect(card(page, 1461)).toBeInViewport();
    await shot(page, "backlog60-1440-light-bottom");
    await open(page, "?case=backlog&theme=dark", { width: 1100, height: 1000 });
    await expectNoOverflow(page);
    await shot(page, "backlog60-1100-dark");
  });
});
