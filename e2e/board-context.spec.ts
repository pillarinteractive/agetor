import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * The board is the main view: opening the run view or the Velocity view
 * replaces it, and coming back finds it as it was left — the search text,
 * the View menu's choice, where the board was scrolled to, Done unfolded,
 * and the selected card, with the focus back on it. Against the real app
 * and a throwaway headless core; no task here is ever started.
 */

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" });

async function post<T>(backend: E2EBackend, path: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`${backend.apiBase}${path}`, { method, headers: auth(backend), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** A one-step pipeline, 40 pipeline cards in the backlog, 8 plain cards in
 *  Done, and a few cards the search leaves out. Returns the card to select. */
async function seedBoard(backend: E2EBackend, tag: string): Promise<{ id: string; title: string }> {
  const profile = await post<{ id: string }>(backend, "/agent-profiles", { name: `Builder ${tag}`, harness: "claude-code", model: "opus-5", instructions: "", skills: [] });
  const stepId = randomUUID();
  const pipeline = await post<{ id: string }>(backend, "/pipelines", {
    name: `Context ${tag}`,
    description: "",
    graph: { steps: [{ id: stepId, name: "Build", instructions: "", agentProfileId: profile.id, position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any" }], edges: [], startStepId: stepId },
    maxSteps: 25,
  });
  const make = (title: string, pipelineId?: string) => post<{ id: string; title: string }>(backend, "/tasks", { title, prompt: "Never started.", isolation: "none", workdir: tmpdir(), ...(pipelineId ? { pipelineId } : {}) });
  let picked: { id: string; title: string } | null = null;
  for (let i = 0; i < 40; i++) {
    const t = await make(`Ctx ${tag} backlog ${String(i).padStart(2, "0")}`, pipeline.id);
    if (i === 3) picked = t;
  }
  for (let i = 0; i < 8; i++) {
    const t = await make(`Ctx ${tag} done ${i}`);
    await post(backend, `/tasks/${t.id}`, { column: "done" }, "PATCH");
  }
  for (let i = 0; i < 3; i++) await make(`Unrelated ${tag} ${i}`);
  return picked!;
}

const scroller = (page: Page) => page.locator(".kanban-scroll");
const scrollOf = (page: Page) => scroller(page).evaluate((el) => ({ left: Math.round(el.scrollLeft), top: Math.round(el.scrollTop) }));
const focusedCard = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.taskId ?? null);

test.describe("board context", () => {
  test("search, View, scroll, Done unfolded and the selected card all survive the run view, by Back and by Escape", async ({ page, backend }) => {
    const tag = randomUUID().slice(0, 6);
    const picked = await seedBoard(backend, tag);
    // Narrow and short, so the board scrolls both ways.
    await page.setViewportSize({ width: 900, height: 620 });
    await gotoApp(page, backend.bootBase);

    // Search, and choose a View.
    const search = page.getByLabel("Search tasks");
    await search.fill(`Ctx ${tag}`);
    await expect(page.locator('[data-column-id="backlog"] [data-testid="task-card"]')).toHaveCount(40);
    await expect(page.getByText(`Unrelated ${tag} 0`)).toHaveCount(0);
    const viewMenu = page.getByTestId("board-view");
    await viewMenu.selectOption("all");

    // Unfold Done.
    const done = page.locator('[data-column-id="done"]');
    await expect(done.getByTestId("task-card")).toHaveCount(5);
    await done.getByTestId("column-fold").click();
    await expect(done.getByTestId("task-card")).toHaveCount(8);

    // Select a card, then scroll the board away from it, down and sideways.
    const card = page.locator(`[data-task-id="${picked.id}"]`);
    await card.click();
    await expect(card).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("card-inspector")).toBeVisible();
    await scroller(page).evaluate((el) => el.scrollTo(140, 900));
    const before = await scrollOf(page);
    expect(before.left).toBeGreaterThan(0);
    expect(before.top).toBeGreaterThan(0);

    const expectBoardAsLeft = async () => {
      await expect(scroller(page)).toBeVisible();
      await expect(search).toHaveValue(`Ctx ${tag}`);
      await expect(viewMenu).toHaveValue("all");
      await expect.poll(() => scrollOf(page)).toEqual(before);
      await expect(card).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("card-inspector")).toBeVisible();
      await expect(done.getByTestId("task-card")).toHaveCount(8);
      await expect(done.getByTestId("column-fold")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator('[data-column-id="backlog"] [data-testid="task-card"]')).toHaveCount(40);
      expect(await focusedCard(page)).toBe(picked.id);
    };

    // The run view, and back with its own button.
    await page.getByTestId("inspector-open").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-title")).toContainText(picked.title);
    await expect(scroller(page)).toHaveCount(0);
    // A run nothing has started: its state is the card's, and it offers Run, not Retry.
    await expect(page.getByTestId("pipeline-run-state-label")).toHaveText("Queued");
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Not started");
    await expect(page.getByTestId("pipeline-run-retry")).toHaveCount(0);
    await page.getByTestId("pipeline-run-back").click();
    await expectBoardAsLeft();

    // Again, and back with Escape.
    await page.getByTestId("inspector-open").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await page.getByTestId("pipeline-run-task-details").focus();
    await page.keyboard.press("Escape");
    await expectBoardAsLeft();
  });
});
