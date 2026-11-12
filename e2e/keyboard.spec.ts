import { expect, test } from "@playwright/test";

// Finding #13: viewer/video keyboard support. Space/K/J navigate the photo
// viewer, L favorites, and the video player keeps arrows for seek while J/K
// step the queue.
test("photo viewer and video player respond to keyboard shortcuts", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/harness.html?benchmark=30&videos=4", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");

  // Open the viewer on the first photo.
  const photoTile = page
    .locator(".gallery-tile")
    .filter({ hasNot: page.locator(".tile-play-background") })
    .first();
  await photoTile.locator(".tile-open-button").dblclick();
  await expect(page.locator(".viewer-screen")).toBeVisible();
  const heading = page.locator(".video-player-title h1");
  await expect(heading).toHaveText(/benchmark-/);
  const firstName = await heading.textContent();

  // K advances; J goes back; Space also advances.
  await page.keyboard.press("k");
  await expect(heading).not.toHaveText(firstName ?? "");
  const secondName = await heading.textContent();
  await page.keyboard.press("j");
  await expect(heading).toHaveText(firstName ?? "");
  await page.keyboard.press(" ");
  await expect(heading).toHaveText(secondName ?? "");

  // L toggles favorite and the bottom-bar button reflects it.
  const favorite = page.getByRole("button", { name: "Add favorite", exact: true }).first();
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Remove favorite", exact: true }).first(),
  ).toHaveAttribute("aria-pressed", "true");

  // Escape back to the library.
  await page.keyboard.press("Escape");
  await expect(page.locator(".gallery-tile").first()).toBeVisible();

  // Start the first synthetic video in the background session.
  const videoTile = page
    .locator(".gallery-tile")
    .filter({ has: page.locator(".tile-play-background") })
    .first();
  await videoTile.locator(".tile-play-background").click();
  await page
    .getByRole("button", { name: /\. Open player\./ })
    .first()
    .click();
  await expect(page.locator(".video-player-screen-active")).toBeVisible();

  // M toggles mute without touching navigation.
  const video = page.locator(".video-player-screen-active video");
  await expect(video).toHaveCount(1);
  await page.keyboard.press("m");
  expect(await video.evaluate((element) => (element as HTMLVideoElement).muted)).toBe(true);
  await page.keyboard.press("m");
  expect(await video.evaluate((element) => (element as HTMLVideoElement).muted)).toBe(false);

  // K advances the queue to the next video.
  const videoHeading = page.locator(".video-player-screen-active .video-player-title h1");
  await expect(videoHeading).toHaveText(/benchmark-0\.mp4/);
  await page.keyboard.press("k");
  await expect(videoHeading).toHaveText(/benchmark-1\.mp4/);

  // J returns to the previous video.
  await page.keyboard.press("j");
  await expect(videoHeading).toHaveText(/benchmark-0\.mp4/);
});
