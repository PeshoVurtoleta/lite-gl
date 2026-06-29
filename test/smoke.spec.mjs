/**
 * CI smoke test for the WebGL2 backend (GLBackend.js).
 *
 * This is the automated counterpart to test/smoke.html. It loads that page in
 * headless Chromium -- which provides real WebGL2 via SwiftShader -- and asserts
 * the in-page pixel-readback checks all passed.
 *
 * Runs in CI (e.g. GitHub Actions); it does NOT run in a plain Node sandbox,
 * because it needs a browser binary:
 *
 *   npm i -D @playwright/test
 *   npx playwright install chromium
 *   npx playwright test test/smoke.spec.mjs
 *
 * A static server is started inline so GLBackend.js resolves at ../GLBackend.js.
 */
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");   // package root
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };

let server, base;

test.beforeAll(async () => {
    server = createServer(async (req, res) => {
        try {
            const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
            const path = join(ROOT, rel);
            const body = await readFile(path);
            const ext = path.slice(path.lastIndexOf("."));
            res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" });
            res.end(body);
        } catch {
            res.writeHead(404); res.end("not found");
        }
    });
    await new Promise((r) => server.listen(0, r));
    base = "http://localhost:" + server.address().port;
});

test.afterAll(async () => { await new Promise((r) => server.close(r)); });

test("GLBackend renders points and recovers from context loss", async ({ page }) => {
    const logs = [];
    page.on("console", (m) => logs.push("[console." + m.type() + "] " + m.text()));
    page.on("pageerror", (e) => logs.push("[pageerror] " + String(e)));
    page.on("requestfailed", (r) => logs.push("[requestfailed] " + r.url() + " " + (r.failure() && r.failure().errorText)));

    await page.goto(base + "/test/smoke.html");
    try {
        await page.waitForFunction(() => !!window.__SMOKE_RESULT__, null, { timeout: 10000 });
    } catch (e) {
        console.log("--- lite-gl smoke page diagnostics ---\n" + (logs.join("\n") || "(no console/request output)"));
        throw e;
    }

    const result = await page.evaluate(() => window.__SMOKE_RESULT__);

    // Surface each in-page check as a readable assertion (skipped checks pass through).
    for (const c of result.checks) {
        if (c.ok === null) continue;
        expect(c.ok, c.name + (c.detail ? " -- " + c.detail : "")).toBe(true);
    }
    expect(result.pass).toBe(true);
});

// GL backend args (software rendering for headless CI) live in playwright.config.mjs.
