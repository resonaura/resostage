import puppeteer from "puppeteer";
const b = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "shell",
  defaultViewport: { width: 1500, height: 1100, deviceScaleFactor: 2 },
});
const p = await b.newPage();
await p.goto("http://127.0.0.1:2900/", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2500));
await p.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((e) => e.textContent?.trim() === "Light")?.click());
await new Promise((r) => setTimeout(r, 2500));
await p.screenshot({ path: "/tmp/c1.png" });
// open the picker popover from the field
const opened = await p.evaluate(() => {
  const el = document.querySelector(".color-picker__trigger");
  if (!el) return false;
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  el.click();
  return true;
});
console.log("trigger:", opened);
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: "/tmp/c2.png" });
await b.close();
