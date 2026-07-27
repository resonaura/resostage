import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));

await page.goto("http://localhost:2900/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1000));

async function clickTab(text) {
  const handle = await page.evaluateHandle((text) => {
    const els = Array.from(document.querySelectorAll("button, [role=tab]"));
    return els.find((el) => el.textContent.trim() === text || el.textContent.includes(text));
  }, text);
  const el = handle.asElement();
  if (el) await el.click();
  await new Promise((r) => setTimeout(r, 700));
}

await clickTab("Player");
await page.screenshot({ path: "/tmp/audit_player.png", fullPage: true });

await clickTab("Mixer");
await page.screenshot({ path: "/tmp/audit_mixer.png", fullPage: true });

await clickTab("Builder");
await page.screenshot({ path: "/tmp/audit_builder.png", fullPage: true });

await clickTab("Settings");
await page.screenshot({ path: "/tmp/audit_settings.png", fullPage: true });

// Also a narrower tablet-ish viewport
await page.setViewport({ width: 834, height: 1112 });
await clickTab("Player");
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: "/tmp/audit_player_tablet.png", fullPage: true });

console.log("done");
await browser.close();
