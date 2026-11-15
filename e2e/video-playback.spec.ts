import { expect, test, type Page } from "@playwright/test";

// The review's library had 167 videos, and the ones that failed were the two
// kinds the app could not handle: codecs WebKit never decodes (WMV, Xvid) and
// Matroska files whose second audio track and subtitles were thrown away by
// the old one-track remux. These tests drive the reader's two acceptance cases
// through the real player UI.

async function openFirstVideo(page: Page, query: string) {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`/harness.html?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".gallery-tile");
  await page.locator(".gallery-tile .tile-open-button").first().dblclick();
  await expect(page.locator(".video-player-stage")).toBeVisible();
}

test("a WMV converts once, reports progress, then plays in-app", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openFirstVideo(page, "benchmark=4&videos=1&wmv=1");

  // WKWebView cannot decode WMV, so the player explains the file and offers
  // the one-time conversion instead of a dead transport bar.
  const fallback = page.locator(".viewer-video-fallback");
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("wmv2");

  await page.getByRole("button", { name: "Convert to play here" }).click();
  await expect(page.locator(".viewer-video-converting")).toContainText("Converting…");

  // A progress tick from the conversion event shows the percentage it carries.
  await page.evaluate(() =>
    (
      window as unknown as {
        __emitPlaybackProgress: (path: string, progress: number) => void;
      }
    ).__emitPlaybackProgress("/synthetic/benchmark-0.wmv", 0.42),
  );
  await expect(page.locator(".viewer-video-converting")).toContainText("Converting… 42%");

  await page.evaluate(() =>
    (window as unknown as { __finishPlaybackConversion: () => void }).__finishPlaybackConversion(),
  );

  // The converted copy replaces the fallback: no error, and the video element
  // points at the file the backend wrote into the playback cache.
  await expect(fallback).toHaveCount(0);
  await expect(page.locator(".viewer-video")).toHaveAttribute("src", /^data:video\/mp4/);
  expect(pageErrors).toEqual([]);
});

test("an MKV offers its second audio track and its subtitle in the player", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openFirstVideo(page, "benchmark=4&videos=1&tracks=1");

  const audio = page.getByLabel("Audio track");
  await expect(audio).toBeVisible();
  await expect(audio.locator("option")).toHaveCount(2);
  await expect(audio.locator("option").nth(0)).toHaveText("Main · 2 ch");
  // Language plus channel count, so a 5.1 track is distinguishable from stereo.
  await expect(audio.locator("option").nth(1)).toHaveText("French · 6 ch");

  const subtitles = page.getByLabel("Subtitles");
  await expect(subtitles).toBeVisible();
  // "off" plus the one text track. The bitmap PGS track cannot become
  // `mov_text`, so offering it would be a control that never shows anything.
  await expect(subtitles.locator("option")).toHaveCount(2);
  await expect(subtitles.locator("option").nth(1)).toHaveText("English");
  await expect(subtitles).toHaveValue("off");

  expect(pageErrors).toEqual([]);
});
