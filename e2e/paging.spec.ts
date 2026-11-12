import { expect, test } from "@playwright/test";

type PagingCall = { cursor: string | null };

// Real-browser guard for the paging path: a 600-item library must be walked
// page by page, each continuation cursor fetched once, and the last item must
// become reachable. The request-identity change only touches bookkeeping, so
// this is the regression check that normal pagination still works in a browser.
test("cursor paging walks a 600-item library once per page", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.addInitScript(() => {
    const w = window as unknown as {
      __pagingCalls?: PagingCall[];
      __TAURI_INTERNALS__?: { invoke?: unknown };
    };
    w.__pagingCalls = [];
    const wrap = () => {
      const internals = w.__TAURI_INTERNALS__;
      if (
        !internals ||
        typeof internals.invoke !== "function" ||
        (internals.invoke as { __wrapped?: boolean }).__wrapped
      ) {
        return false;
      }
      const original = internals.invoke as (cmd: string, args?: unknown) => Promise<unknown>;
      const wrapped = (cmd: string, args?: unknown) => {
        if (cmd === "get_library_items") {
          const cursor =
            (args as { filter?: { cursor?: string | null } } | undefined)?.filter?.cursor ?? null;
          (w.__pagingCalls as PagingCall[]).push({ cursor });
        }
        return original(cmd, args);
      };
      (wrapped as { __wrapped?: boolean }).__wrapped = true;
      internals.invoke = wrapped;
      return true;
    };
    if (!wrap()) {
      const timer = setInterval(() => {
        if (wrap()) clearInterval(timer);
      }, 5);
    }
  });

  await page.goto("/harness.html?benchmark=600", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile", { timeout: 30_000 });

  const calls = () =>
    page.evaluate(
      () => (window as unknown as { __pagingCalls: PagingCall[] }).__pagingCalls,
    );
  const scrollToBottom = () =>
    page.evaluate(() => {
      const container = document.querySelector(".library-grid-container");
      if (container) container.scrollTop = container.scrollHeight;
    });

  // First page only: no continuation cursor has been requested yet.
  expect((await calls()).every((call) => call.cursor === null)).toBe(true);

  const scrollUntil = async (predicate: () => Promise<boolean>, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await scrollToBottom();
      await page.waitForTimeout(300);
      if (await predicate()) return true;
    }
    return false;
  };

  expect(
    await scrollUntil(async () => (await calls()).some((call) => call.cursor === "items-250")),
  ).toBe(true);
  expect(
    await scrollUntil(() => page.locator('img[alt="benchmark-499.jpg"]').isVisible()),
  ).toBe(true);

  expect(
    await scrollUntil(async () => (await calls()).some((call) => call.cursor === "items-500")),
  ).toBe(true);
  expect(
    await scrollUntil(() => page.locator('img[alt="benchmark-599.jpg"]').isVisible()),
  ).toBe(true);

  // No continuation cursor fetched twice, and nothing beyond the last page.
  await scrollToBottom();
  await page.waitForTimeout(500);
  const cursors = (await calls()).map((call) => call.cursor).filter((c): c is string => !!c);
  expect(cursors).toEqual(["items-250", "items-500"]);
  expect(new Set(cursors).size).toBe(cursors.length);

  expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
});
