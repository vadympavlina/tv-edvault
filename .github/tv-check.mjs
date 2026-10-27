// Used by .github/workflows/tv-check.yml. Argument: folder for screenshots.
import { chromium } from "playwright";

const out = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const kyiv = () => new Date().toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv" });

async function report(page, label) {
  const app = page.frames().find((f) => f.url().includes("app.html"));
  if (!app) return console.log(label, "no app frame");
  const s = await app.evaluate(() => ({
    body: document.body.className,
    splash: !document.getElementById("splash").hidden,
    note: (document.querySelector(".launch-note") || {}).textContent,
    frames: [...document.querySelectorAll("iframe.frame")].map((f) => f.className + " " + (f.getAttribute("src") || "").slice(0, 40)),
  }));
  console.log(`[${kyiv()}] ${label}`, JSON.stringify(s));
  for (const f of page.frames()) {
    if (!f.url().includes("lb.itstep.org")) continue;
    const text = await f.evaluate(() => (document.body ? document.body.innerText : "")).catch((e) => "ERR " + e.message);
    console.log("   lb frame:", f.url().slice(0, 60), "|", JSON.stringify(text.replace(/\s+/g, " ").slice(0, 160)));
  }
}

function watch(page, name) {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`   ${name} console ${m.type()}:`, m.text().slice(0, 200));
  });
  page.on("requestfailed", (r) => console.log(`   ${name} request failed:`, r.url().slice(0, 100), r.failure() && r.failure().errorText));
}

// 1. Started at night, switches on by itself.
const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
watch(tv, "auto");
await tv.goto("http://localhost:8765/?autostart=0");
await wait(3000);
await tv.frameLocator("iframe.app").locator("#launch").click();
for (let i = 0; i <= 18; i++) {
  await report(tv, "auto #" + i);
  await tv.screenshot({ path: `${out}/auto-${String(i).padStart(2, "0")}.png` });
  await wait(30000);
}

// 2. Control: opened and started by hand while the schedule is on.
const manual = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
watch(manual, "manual");
await manual.goto("http://localhost:8765/?autostart=0");
await wait(3000);
await manual.frameLocator("iframe.app").locator("#launch").click();
for (let i = 0; i <= 4; i++) {
  await wait(15000);
  await report(manual, "manual #" + i);
  await manual.screenshot({ path: `${out}/manual-${i}.png` });
}
await browser.close();
