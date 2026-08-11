# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: test/smoke.spec.mjs >> GLBackend renders points and recovers from context loss
- Location: test/smoke.spec.mjs:47:1

# Error details

```
TimeoutError: page.waitForFunction: Timeout 10000ms exceeded.
```

# Test source

```ts
  1  | /**
  2  |  * CI smoke test for the WebGL2 backend (GLBackend.js).
  3  |  *
  4  |  * This is the automated counterpart to test/smoke.html. It loads that page in
  5  |  * headless Chromium -- which provides real WebGL2 via SwiftShader -- and asserts
  6  |  * the in-page pixel-readback checks all passed.
  7  |  *
  8  |  * Runs in CI (e.g. GitHub Actions); it does NOT run in a plain Node sandbox,
  9  |  * because it needs a browser binary:
  10 |  *
  11 |  *   npm i -D @playwright/test
  12 |  *   npx playwright install chromium
  13 |  *   npx playwright test test/smoke.spec.mjs
  14 |  *
  15 |  * A static server is started inline so GLBackend.js resolves at ../GLBackend.js.
  16 |  */
  17 | import { test, expect } from "@playwright/test";
  18 | import { createServer } from "node:http";
  19 | import { readFile } from "node:fs/promises";
  20 | import { fileURLToPath } from "node:url";
  21 | import { dirname, join, normalize } from "node:path";
  22 | 
  23 | const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");   // package root
  24 | const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
  25 | 
  26 | let server, base;
  27 | 
  28 | test.beforeAll(async () => {
  29 |     server = createServer(async (req, res) => {
  30 |         try {
  31 |             const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  32 |             const path = join(ROOT, rel);
  33 |             const body = await readFile(path);
  34 |             const ext = path.slice(path.lastIndexOf("."));
  35 |             res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" });
  36 |             res.end(body);
  37 |         } catch {
  38 |             res.writeHead(404); res.end("not found");
  39 |         }
  40 |     });
  41 |     await new Promise((r) => server.listen(0, r));
  42 |     base = "http://localhost:" + server.address().port;
  43 | });
  44 | 
  45 | test.afterAll(async () => { await new Promise((r) => server.close(r)); });
  46 | 
  47 | test("GLBackend renders points and recovers from context loss", async ({ page }) => {
  48 |     const logs = [];
  49 |     page.on("console", (m) => logs.push("[console." + m.type() + "] " + m.text()));
  50 |     page.on("pageerror", (e) => logs.push("[pageerror] " + String(e)));
  51 |     page.on("requestfailed", (r) => logs.push("[requestfailed] " + r.url() + " " + (r.failure() && r.failure().errorText)));
  52 | 
  53 |     await page.goto(base + "/test/smoke.html");
  54 |     try {
> 55 |         await page.waitForFunction(() => !!window.__SMOKE_RESULT__, null, { timeout: 10000 });
     |                    ^ TimeoutError: page.waitForFunction: Timeout 10000ms exceeded.
  56 |     } catch (e) {
  57 |         console.log("--- lite-gl smoke page diagnostics ---\n" + (logs.join("\n") || "(no console/request output)"));
  58 |         throw e;
  59 |     }
  60 | 
  61 |     const result = await page.evaluate(() => window.__SMOKE_RESULT__);
  62 | 
  63 |     // Surface each in-page check as a readable assertion (skipped checks pass through).
  64 |     for (const c of result.checks) {
  65 |         if (c.ok === null) continue;
  66 |         expect(c.ok, c.name + (c.detail ? " -- " + c.detail : "")).toBe(true);
  67 |     }
  68 |     expect(result.pass).toBe(true);
  69 | });
  70 | 
  71 | // GL backend args (software rendering for headless CI) live in playwright.config.mjs.
  72 | 
```