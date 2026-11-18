import { expect, test, type Page } from "@playwright/test";

// Album cards expose a slideshow control, so these tests do not depend on a
// keyboard shortcut or on tile affordances.
async function openAlbumSlideshow(page: Page, query = "benchmark=12") {
  await page.goto(`/harness.html?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  const card = page.locator(".album-card-wrap").first();
  await card.hover();
  await card.getByRole("button", { name: /Play slideshow of/ }).click();
  await expect(page.locator(".slideshow-overlay")).toBeVisible();
}

// Finding U15: the app's top bar stayed visible above the show, so the stage
// started 56px down the window and only part of the screen belonged to the
// photo. While a slideshow is open the frame is marked `slideshow-open`: the
// top bar hides and the overlay reaches the top edge.
test("the slideshow hides the top bar and fills the window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAlbumSlideshow(page);

  const overlay = page.locator(".slideshow-overlay");
  await expect(page.locator(".topbar")).toBeHidden();

  const top = await overlay.evaluate((el) => getComputedStyle(el).top);
  expect(top).toBe("0px");
  const box = await overlay.boundingBox();
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(1280);

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(page.locator(".topbar")).toBeVisible();
});

test("a long filename ellipsizes instead of covering the controls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Three repeats, not one: a single long name fits inside the HUD's 880px
  // column with the narrower fallback font on CI, so the name would not
  // ellipsize there and the check would fail on the runner only.
  await openAlbumSlideshow(page, "benchmark=12&longNames=3");

  const geometry = await page.evaluate(() => {
    const caption = document.querySelector(".slideshow-caption") as HTMLElement;
    const name = caption.querySelector("div:first-child") as HTMLElement;
    const controls = document.querySelector(".slideshow-controls") as HTMLElement;
    const stop = document.querySelector(".slideshow-stop") as HTMLElement;
    const nameBox = name.getBoundingClientRect();
    const captionBox = caption.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    const stopBox = stop.getBoundingClientRect();
    return {
      ellipsized: name.scrollWidth > name.clientWidth,
      nameRight: nameBox.right,
      captionRight: captionBox.right,
      captionBottom: captionBox.bottom,
      controlsTop: controlsBox.top,
      stopVisible: stopBox.right <= window.innerWidth,
    };
  });

  expect(geometry.ellipsized).toBe(true);
  // The name stays inside the caption instead of spilling across the bar.
  expect(geometry.nameRight).toBeLessThanOrEqual(geometry.captionRight + 1);
  // Caption and controls are stacked rows, so a name wide enough to fill the
  // HUD still cannot reach the buttons: compare rows, not horizontal edges.
  expect(geometry.captionBottom).toBeLessThanOrEqual(geometry.controlsTop + 0.5);
  expect(geometry.stopVisible).toBe(true);
});
