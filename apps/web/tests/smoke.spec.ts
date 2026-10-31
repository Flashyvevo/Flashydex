import { expect, test } from "@playwright/test";

test("renders the placeholder at a 390×844 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "pokescan" })).toBeVisible();
});
