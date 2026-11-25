import { expect, test } from "@playwright/test";

test("the map groups nearby photos and opens a photo outside the first library page", async ({
  page,
}) => {
  await page.goto("/harness.html?benchmark=500&gps=1");
  await page.getByRole("button", { name: "Map", exact: true }).click();

  await expect(page.getByText("3 photos with locations")).toBeVisible();
  const atlas = page.locator(".photo-map-atlas");
  const rail = page.getByRole("complementary", { name: "Map photos" });
  await expect(atlas.getByRole("button", { name: "2 photos in this area" })).toBeVisible();
  await expect(atlas.getByRole("button", { name: "benchmark-499.jpg" })).toBeVisible();

  await atlas.getByRole("button", { name: "2 photos in this area" }).click();
  await expect(rail.getByRole("heading", { name: "2 photos here" })).toBeVisible();
  await expect(rail.getByRole("heading", { name: "benchmark-0.jpg" })).toBeVisible();
  await expect(rail.getByRole("button", { name: /benchmark-499.jpg/ })).toHaveCount(0);

  await rail.getByRole("button", { name: "Show all" }).click();
  await expect(rail.getByRole("heading", { name: "3 photos in view" })).toBeVisible();
  await rail.getByRole("button", { name: /benchmark-499.jpg/ }).click();
  await expect(rail.getByRole("heading", { name: "benchmark-499.jpg" })).toBeVisible();
  await expect(rail.getByText("33.869° S, 151.209° E").first()).toBeVisible();
  // Picking from the list keeps it; Show all returns to the live in-view list.
  await expect(rail.getByRole("heading", { name: "3 photos here" })).toBeVisible();
  await rail.getByRole("button", { name: "Show all" }).click();
  // Panning away from every photo empties the in-view list.
  await atlas.getByRole("button", { name: "World view" }).click();
  await atlas.getByRole("button", { name: "Zoom in" }).click();
  await atlas.getByRole("button", { name: "Zoom in" }).click();
  await expect(rail.getByRole("heading", { name: "0 photos in view" })).toBeVisible();
  await expect(rail.getByText("No photos in this part of the map.")).toBeVisible();

  await atlas.getByRole("button", { name: "World view" }).click();
  await expect(atlas.getByRole("button", { name: "Zoom out" })).toBeDisabled();

  // Open shows the photo in the app's viewer, though the library never loaded it,
  // and the viewer steps through the map's photos.
  await rail.getByRole("button", { name: /benchmark-499.jpg/ }).click();
  await rail.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".viewer-screen")).toBeVisible();
  const title = page.locator(".video-player-title h1");
  await expect(title).toHaveText("benchmark-499.jpg");
  await page.keyboard.press("k");
  await expect(title).not.toHaveText("benchmark-499.jpg");
  await expect(title).toHaveText(/benchmark-(0|1)\.jpg/);
  await page.keyboard.press("Escape");
  await expect(page.getByText("3 photos with locations")).toBeVisible();
});

test("the map explains an empty catalog of geotagged photos", async ({ page }) => {
  await page.goto("/harness.html?benchmark=10");
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No geotagged photos" })).toBeVisible();
  await expect(page.locator(".photo-map-marker")).toHaveCount(0);
});
