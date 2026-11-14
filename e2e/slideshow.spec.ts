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
  await openAlbumSlideshow(page, "benchmark=12&longNames=1");

  const geometry = await page.evaluate(() => {
    const caption = document.querySelector(".slideshow-caption") as HTMLElement;
    const name = caption.querySelector("div:first-child") as HTMLElement;
    const stop = document.querySelector(".slideshow-stop") as HTMLElement;
    const nameBox = name.getBoundingClientRect();
    const captionBox = caption.getBoundingClientRect();
    const stopBox = stop.getBoundingClientRect();
    return {
      ellipsized: name.scrollWidth > name.clientWidth,
      nameRight: nameBox.right,
      captionRight: captionBox.right,
      stopLeft: stopBox.left,
      stopVisible: stopBox.right <= window.innerWidth,
    };
  });

  expect(geometry.ellipsized).toBe(true);
  // The name stays inside the caption instead of spilling across the bar.
  expect(geometry.nameRight).toBeLessThanOrEqual(geometry.captionRight + 1);
  expect(geometry.nameRight).toBeLessThan(geometry.stopLeft);
  expect(geometry.stopVisible).toBe(true);
});
