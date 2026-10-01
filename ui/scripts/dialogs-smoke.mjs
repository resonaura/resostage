/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { runRenderAcceptance } from "../../scripts/media/acceptance.mjs";

if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: node ui/scripts/dialogs-smoke.mjs <packaged Core executable> <packaged media executable>");
}

/** Exercises real shared overlays and format popovers, not a screenshot mock. */
await runRenderAcceptance(resolve(process.argv[2]), resolve(process.argv[3]), async (origin) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(origin);
    for (const [width, height] of [[1360, 900], [800, 600], [400, 800]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("resostage-open-audio-render", { detail: { kind: "generic" } })));
      const dialog = page.getByRole("dialog", { name: "Render", exact: true });
      await dialog.waitFor();
      const close = dialog.getByRole("button", { name: "Close", exact: true }).first();
      const layout = await close.evaluate((button) => {
        const parent = button.closest('[role="dialog"]');
        const rect = parent.getBoundingClientRect();
        const hit = button.getBoundingClientRect();
        const card = document.createElement("div");
        card.className = "rs-card-surface";
        document.body.append(card);
        const cardBackground = getComputedStyle(card).backgroundColor;
        card.remove();
        return { directChild: button.parentElement === parent,
          position: getComputedStyle(button).position,
          right: rect.right - hit.right, top: hit.top - rect.top,
          background: getComputedStyle(parent).backgroundColor,
          cardBackground };
      });
      assert.equal(layout.directChild, true);
      assert.equal(layout.position, "absolute");
      assert.ok(layout.right >= 12 && layout.right <= 22, JSON.stringify(layout));
      assert.ok(layout.top >= 12 && layout.top <= 22, JSON.stringify(layout));
      assert.notEqual(layout.background, "rgba(0, 0, 0, 0)");
      assert.equal(layout.background, layout.cardBackground);
      const heading = dialog.getByRole("heading", { name: "Render", exact: true });
      assert.equal(await heading.locator("svg").count(), 0);
      assert.ok(await heading.evaluate((element) => getComputedStyle(element).color ===
        getComputedStyle(element.closest('[role="dialog"]')).color));
      const fields = await dialog.evaluate((element) => {
        const format = element.querySelector('button[aria-label="Export file format"]');
        const rate = element.querySelector('button[aria-label="Export sample rate"]');
        return { format: format.getBoundingClientRect().toJSON(), rate: rate.getBoundingClientRect().toJSON(),
          labels: [format, rate].map((button) => button.closest("[data-render-field]").firstElementChild.getBoundingClientRect().height),
          dialogWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          overflow: element.scrollWidth > element.clientWidth };
      });
      assert.ok(fields.format.width >= 130, JSON.stringify(fields));
      assert.equal(fields.format.y, fields.rate.y);
      assert.equal(fields.format.height, fields.rate.height);
      assert.equal(fields.labels[0], fields.labels[1]);
      assert.ok(fields.labels[0] > 0);
      if (fields.overflow && process.env.RESOSTAGE_QA_SCREENSHOT)
        await page.screenshot({ path: `${process.env.RESOSTAGE_QA_SCREENSHOT}-${width}-overflow.png` });
      assert.equal(fields.overflow, false, JSON.stringify(fields));
      // React Aria's labelledby combines field name and current value. The
      // explicit label attribute is the stable control identifier here.
      await dialog.locator('button[aria-label="Export file format"]').click();
      for (const label of [".wav", ".aiff", ".flac", ".m4a ALAC", ".mp3", ".m4a AAC", ".opus", ".ogg Vorbis", ".wma"])
        await page.getByRole("option", { name: label, exact: true }).waitFor();
      await page.getByRole("option", { name: ".m4a ALAC", exact: true }).click();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      const formatControl = dialog.locator('button[aria-label="Export file format"]');
      assert.ok((await formatControl.textContent()).includes(".m4a"));
      await formatControl.locator('[data-slot="chip"]').filter({ hasText: "ALAC" }).waitFor();
      await formatControl.click();
      await page.getByRole("option", { name: ".mp3", exact: true }).click();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await dialog.getByRole("button", { name: "Export 1 MP3 file", exact: true }).waitFor();
      assert.equal(await dialog.locator('button[aria-label="Export encoding"]').count(), 0);
      if (process.env.RESOSTAGE_QA_SCREENSHOT) await page.screenshot({ path: `${process.env.RESOSTAGE_QA_SCREENSHOT}-${width}.png` });
      await close.click();
      await dialog.waitFor({ state: "hidden" });
      console.log(`Dialog QA passed: ${width}×${height}, aligned fields, neutral heading, absolute close, all formats, MP3 action/encoding.`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
