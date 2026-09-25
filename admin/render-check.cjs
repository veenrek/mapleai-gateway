const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));

  for (const [name, url] of [
    ["STOREFRONT /", "http://127.0.0.1:20128/"],
    ["CHECKER /check", "http://127.0.0.1:20128/check"],
    ["LOGIN /login", "http://127.0.0.1:20128/login"],
  ]) {
    console.log("\n=== " + name + " ===");
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(800);
      const info = await page.evaluate(() => {
        const body = document.body;
        const bs = getComputedStyle(body);
        const header = document.querySelector("header");
        const hs = header ? getComputedStyle(header) : null;
        const card = document.querySelector(".lot, .panel");
        const cs = card ? getComputedStyle(card) : null;
        return {
          title: document.title,
          textSample: (body.innerText || "").replace(/\s+/g, " ").slice(0, 220),
          bodyBg: bs.backgroundColor,
          headerBg: hs ? hs.backgroundColor : null,
          cardBg: cs ? cs.backgroundColor : null,
          cardRadius: cs ? cs.borderRadius : null,
          stylesheetCount: document.styleSheets.length,
          buttons: [...document.querySelectorAll("button,a")].map((b) => b.innerText.trim()).filter(Boolean).slice(0, 5),
        };
      });
      console.log("title:", info.title);
      console.log("text:", info.textSample);
      console.log("body bg:", info.bodyBg, "| header bg:", info.headerBg, "| card bg:", info.cardBg, info.cardRadius);
      console.log("stylesheets:", info.stylesheetCount);
      console.log("buttons/links:", JSON.stringify(info.buttons));
    } catch (e) {
      console.log("FAIL:", String(e).slice(0, 150));
    }
  }
  if (errors.length) { console.log("\nCONSOLE ERRORS:"); errors.slice(0, 6).forEach((e) => console.log(" -", e)); }
  else console.log("\nconsole errors: none");
  await browser.close();
})();
