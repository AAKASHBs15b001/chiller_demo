import { chromium } from "playwright";

const errors = [];
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: "/home/katha/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://187.127.189.154:3000/", { waitUntil: "networkidle", timeout: 20000 });
await page.waitForSelector("text=CHILLER PLANT", { timeout: 15000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/claude-1000/-mnt-c-Users-katha-OneDrive-Desktop-warehouses/3d6f2f5b-c5c3-41e0-ab88-be7f9efbfd0c/scratchpad/live-deploy-check.png" });

console.log("ERRORS:", JSON.stringify(errors, null, 2));
console.log("LOADED_OK: true");
await browser.close();
