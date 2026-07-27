import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://localhost:2900/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1000));

async function clickTab(text) {
  const handle = await page.evaluateHandle((text) => {
    const els = Array.from(document.querySelectorAll("button, [role=tab]"));
    return els.find((el) => el.textContent.trim() === text || el.textContent.includes(text));
  }, text);
  const el = handle.asElement();
  if (el) await el.click();
  await new Promise((r) => setTimeout(r, 600));
}

await clickTab("Player");
await page.screenshot({ path: "/tmp/empty_player.png" });
await clickTab("Mixer");
await page.screenshot({ path: "/tmp/empty_mixer.png" });
await clickTab("Builder");
await page.screenshot({ path: "/tmp/empty_builder.png" });
await clickTab("Settings");
await page.screenshot({ path: "/tmp/empty_settings.png" });

console.log("ERRORS:", JSON.stringify(errors, null, 2));
await browser.close();
