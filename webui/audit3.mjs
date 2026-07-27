import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));

await page.goto("http://localhost:2900/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));

async function clickTab(text) {
  const handle = await page.evaluateHandle((text) => {
    const els = Array.from(document.querySelectorAll("button, [role=tab]"));
    return els.find((el) => el.textContent.trim() === text || el.textContent.includes(text));
  }, text);
  const el = handle.asElement();
  if (el) await el.click();
  await new Promise((r) => setTimeout(r, 700));
}

await clickTab("Mixer");
await page.screenshot({ path: "/tmp/audit_mixer2.png" });

await clickTab("Builder");
await page.screenshot({ path: "/tmp/audit_builder2.png" });

// click first song in builder to see editor layout
const songRow = await page.evaluateHandle(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.find((b) => b.textContent.includes("1. Opener"));
});
if (songRow.asElement()) await songRow.asElement().click();
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: "/tmp/audit_builder_song.png" });

// tracks tab
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const b = btns.find((x) => x.textContent.trim() === "Tracks");
  if (b) b.click();
});
await new Promise((r) => setTimeout(r, 500));
const trackRow = await page.evaluateHandle(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.find((b) => b.textContent.includes("Synths"));
});
if (trackRow.asElement()) await trackRow.asElement().click();
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: "/tmp/audit_builder_track.png" });

await clickTab("Settings");
await page.screenshot({ path: "/tmp/audit_settings2.png" });

console.log("done");
await browser.close();
