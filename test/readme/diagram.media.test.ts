/**
 * The ER diagram's GIF (plan 152) on the demo shop, with `order_items`'s keys dropped so two of the
 * three edges are inferred. Recorded the same way as `readme.media.test.ts`, by
 * `README_MEDIA=diagram bun run readme:media`.
 */
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { diagramEdges, edgeMiddle, tableNode } from "../e2e/diagramLive.js";
import { LAUNCH_TIMEOUT_MS } from "../e2e/harness.js";
import { clickVisibly, pause, pointAt } from "./pace.js";
import { mediaSuite, READ_PAUSE_MS, scene, shopTables, TABLES_GROUP, treeRow } from "./scenes.js";
import { dropShopOrderItemKeys } from "./shop.js";

const KEPT_KEY = "order_items(product_id)->products(id)";
const DRAGGED_TABLE = "customers";
const DRAG = { x: 0, y: 160 };
/** Enough steps for the reader to follow the table across the canvas. */
const DRAG_STEPS = 30;
const POINTER_STEPS = 20;

async function drag(page: Page, table: string, by: { readonly x: number; readonly y: number }): Promise<void> {
  const header = tableNode(page, table).locator(".tc-diagram-header");
  await pointAt(page, header);
  const box = await header.boundingBox();
  if (box === null) throw new Error(`${table} is not drawn; wait for the diagram before dragging it.`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.down();
  await page.mouse.move(x + by.x, y + by.y, { steps: DRAG_STEPS });
  await page.mouse.up();
}

mediaSuite("README diagram media", () => {
  scene("diagram", {
    prepare: () => {
      dropShopOrderItemKeys();
      return Promise.resolve();
    },
    setup: async ({ page }) => {
      await shopTables(page);
    },
    run: async ({ page }) => {
      await clickVisibly(page, treeRow(page, TABLES_GROUP), { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: "Diagrams" }));
      await clickVisibly(page, page.getByRole("menuitem", { name: /^Show Diagram/ }));
      await expect.poll(() => diagramEdges(page, "inferred").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      await expect.poll(() => diagramEdges(page, "declared").count()).toBe(1);
      await pause(page, READ_PAUSE_MS);

      await drag(page, DRAGGED_TABLE, DRAG);
      await pause(page);

      const middle = await edgeMiddle(page, KEPT_KEY);
      await page.mouse.move(middle.x, middle.y, { steps: POINTER_STEPS });
      await page.mouse.click(middle.x, middle.y, { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: "Keep as Virtual Key" }));
      await expect.poll(() => diagramEdges(page, "virtual").count()).toBe(1);
      await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(1);
      await pause(page, READ_PAUSE_MS);
    },
  });
});
