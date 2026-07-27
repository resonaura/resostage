import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));

await page.goto("http://localhost:2900/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: "/tmp/audit_player_noscroll.png" });

console.log("done");
await browser.close();
