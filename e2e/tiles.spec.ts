import { expect, test } from "@playwright/test";

// Finding #15: a tile used to be one <button> containing the video
// play-in-background <button>. Invalid HTML, and React logged a
// validateDOMNesting warning in dev. The tile is now an article with a
// transparent open overlay and sibling play control.
async function readAlignment(page: import("@playwright/test").Page) {
  const labels = ["Name", "Captured", "Kind", "Size"];
  // The sort button sits inside a .details-col with 12px side padding, so a
  // header's button starts 12px right of its grid track. The row cells are
  // grid items with the same padding, so compare track edges, not text.
  return page.evaluate((wanted) => {
    const headers = wanted.map((label) => {
      const header = Array.from(
        document.querySelectorAll<HTMLElement>(".details-sort-header"),
      ).find((element) => element.textContent?.trim().startsWith(label));
      const cell = header?.closest<HTMLElement>(".details-col");
      return cell ? cell.getBoundingClientRect().left : null;
    });
    const row = document.querySelector<HTMLElement>(".gallery-grid.layout-details .gallery-tile")!;
    const open = row.querySelector<HTMLElement>(".tile-open-button")!;
    const cells = [
      row.querySelector<HTMLElement>(".tile-caption b"),
      row.querySelector<HTMLElement>(".tile-date"),
      row.querySelector<HTMLElement>(".tile-kind"),
      row.querySelector<HTMLElement>(".tile-size"),
    ].map((element) => (element ? element.getBoundingClientRect().left : null));
    const rowBox = row.getBoundingClientRect();
    const openBox = open.getBoundingClientRect();
    return {
      headers,
      cells,
      overlayCoversRow:
        Math.abs(openBox.width - rowBox.width) <= 1.5 &&
        Math.abs(openBox.height - rowBox.height) <= 1.5,
    };
  }, labels);
}

function expectDetailsAligned(layout: Awaited<ReturnType<typeof readAlignment>>) {
  layout.headers.forEach((left, index) => {
    expect(left, "header cells exist").not.toBeNull();
    expect(layout.cells[index], "row cells exist").not.toBeNull();
    expect(
      Math.abs((left as number) - (layout.cells[index] as number)),
      "row cell stays under its header column",
    ).toBeLessThan(1.5);
  });
  expect(layout.overlayCoversRow).toBe(true);
}

test("library tiles keep open and play as sibling buttons", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Wide enough that the inspector's compact-width header padding (<=1299px)
  // does not shift the details header; this test is about the row box.
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&videos=8", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");

  // No interactive element may be nested inside another in any layout.
  for (const view of ["Grid view", "Details view", "Timeline view", "Grid view"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.waitForSelector(".gallery-tile");
    expect(
      await page.evaluate(() => document.querySelectorAll("button button").length),
      `${view} must not nest buttons`,
    ).toBe(0);
  }

  const videoTile = page
    .locator(".gallery-tile")
    .filter({ has: page.locator(".tile-play-background") })
    .first();
  await expect(videoTile).toBeVisible();
  await expect(videoTile.locator(".tile-open-button")).toHaveCount(1);
  await expect(videoTile.locator(".tile-play-background")).toHaveCount(1);

  // The overlay covers the whole tile, while the play control sits above it.
  const hit = await videoTile.evaluate((tile) => {
    const open = tile.querySelector<HTMLElement>(".tile-open-button")!;
    const play = tile.querySelector<HTMLElement>(".tile-play-background")!;
    const tileBox = tile.getBoundingClientRect();
    const openBox = open.getBoundingClientRect();
    const playBox = play.getBoundingClientRect();
    // The tile has a 1px border, which `inset: 0` sits inside.
    const contentWidth = tile.clientWidth;
    const contentHeight = tile.clientHeight;
    const hitAt = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y);
      if (!element) return "none";
      if (element.closest(".tile-play-background")) return "play";
      if (element.closest(".tile-open-button")) return "open";
      return "other";
    };
    return {
      openCoversTile:
        Math.abs(openBox.width - contentWidth) <= 1 &&
        Math.abs(openBox.height - contentHeight) <= 1,
      playHit: hitAt(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2),
      bodyHit: hitAt(tileBox.x + tileBox.width * 0.6, tileBox.y + tileBox.height * 0.8),
    };
  });
  expect(hit.openCoversTile).toBe(true);
  expect(hit.playHit).toBe("play");
  expect(hit.bodyHit).toBe("open");

  // The selection checkbox sits above the open overlay: clicking it selects
  // the tile instead of opening it.
  const checkTarget = await videoTile.evaluate((tile) => {
    const box = tile.querySelector<HTMLElement>(".tile-select-check")!.getBoundingClientRect();
    const element = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return element?.tagName ?? "none";
  });
  expect(checkTarget).toBe("INPUT");
  await videoTile.locator(".tile-select-check input").click();
  await expect(videoTile).toHaveClass(/selected/);
  await expect(page.locator(".viewer-screen")).toHaveCount(0);
  await videoTile.locator(".tile-select-check input").click();

  // Playing in the background must not fall through to the open action.
  await videoTile.locator(".tile-play-background").click();
  await expect(page.locator(".viewer-screen")).toHaveCount(0);

  // A photo tile still opens the viewer from its overlay.
  const photoTile = page
    .locator(".gallery-tile")
    .filter({ hasNot: page.locator(".tile-play-background") })
    .first();
  await photoTile.locator(".tile-open-button").dblclick();
  await expect(page.locator(".viewer-screen")).toBeVisible();

  expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
});

test("details rows stay aligned with their header after the row box change", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=40&videos=8", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  // Wide enough that the inspector's compact-width rules do not shift the
  // details header; this test pins the row box, not the inspector layout.
  await page.getByRole("button", { name: "Details view", exact: true }).click();
  await page.waitForSelector(".gallery-grid.layout-details .gallery-tile");

  const layout = await readAlignment(page);
  expect(layout.headers).toHaveLength(4);
  expectDetailsAligned(layout);

  const detailsCheck = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".gallery-grid.layout-details .gallery-tile")!;
    const box = row.querySelector<HTMLElement>(".tile-select-check")!.getBoundingClientRect();
    const element = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return element?.tagName ?? "none";
  });
  expect(detailsCheck).toBe("INPUT");
  await page
    .locator(".gallery-grid.layout-details .gallery-tile")
    .first()
    .locator(".tile-select-check input")
    .click();
  await expect(page.locator(".gallery-grid.layout-details .gallery-tile").first()).toHaveClass(
    /selected/,
  );
  await expect(page.locator(".viewer-screen")).toHaveCount(0);
});

test("details header and rows stay aligned with the inspector open at 1280px", async ({ page }) => {
  // 1280px is inside the inspector's compact-width breakpoint (<=1299px),
  // where the sticky details header used to be padded narrower than the
  // rows by one gutter on each side.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/harness.html?benchmark=40&videos=8", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  const showInspector = page.getByRole("button", { name: "Show inspector", exact: true });
  if (await showInspector.count()) {
    await showInspector.click();
  }
  await expect(page.getByRole("button", { name: "Hide inspector", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Details view", exact: true }).click();
  await page.waitForSelector(".gallery-grid.layout-details .gallery-tile");

  const layout = await readAlignment(page);
  expectDetailsAligned(layout);
});

test("details names truncate before the metadata cluster with the inspector open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/harness.html?benchmark=40&longNames=1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  const showInspector = page.getByRole("button", { name: "Show inspector", exact: true });
  if (await showInspector.count()) {
    await showInspector.click();
  }
  await page.getByRole("button", { name: "Details view", exact: true }).click();
  await page.waitForSelector(".gallery-grid.layout-details .gallery-tile");

  const collisions = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".gallery-grid.layout-details .list-view-row")];
    return rows.flatMap((row) => {
      const meta = row.querySelector(".list-row-meta");
      const truncate = row.querySelector<HTMLElement>(".middle-truncate");
      const tail = row.querySelector(".middle-truncate-tail");
      const cell = row.querySelector(".tile-caption b");
      if (!meta || !truncate || !tail || !cell) return [];
      const problems: string[] = [];
      if (tail.getBoundingClientRect().right > meta.getBoundingClientRect().left + 0.5) {
        problems.push("tail paints under the metadata");
      }
      if (tail.getBoundingClientRect().right > cell.getBoundingClientRect().right + 0.5) {
        problems.push("tail escapes the name cell");
      }
      if (truncate.scrollWidth > truncate.clientWidth + 0.5) {
        problems.push("truncation box overflows");
      }
      return problems;
    });
  });
  expect(collisions).toEqual([]);

  // The sorted column reports its direction; unsorted sortable columns say none.
  await expect(page.getByRole("columnheader", { name: /^Captured/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(page.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
    "aria-sort",
    "none",
  );
});
