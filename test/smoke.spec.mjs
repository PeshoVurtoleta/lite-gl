/**
 * CI smoke test for the browser backends (GLBackend.js + GLWebGPU.js).
 *
 * The automated counterpart to test/smoke.html. It loads that page in headless
 * Chromium -- which provides real WebGL2 (SwiftShader) and, where the runner has
 * a Vulkan/Dawn adapter, real WebGPU -- and asserts the in-page pixel-readback
 * checks all passed.
 *
 * Two Playwright projects (see playwright.config.mjs) drive the two backends:
 *   - webgl2: loads the default page (the v1.x WebGL2 baseline).
 *   - webgpu: loads ?scene=webgpu (the v2.0.0 sink + deferred pick).
 * Each project carries its scene in `use.scene`; this spec reads it below.
 *
 * Runs in CI (e.g. GitHub Actions); it does NOT run in a plain Node sandbox,
 * because it needs a browser binary:
 *
 *   npm i -D @playwright/test
 *   npx playwright install chromium
 *   npx playwright test test/smoke.spec.mjs
 *
 * A static server is started inline so the backends resolve at ../GLBackend.js
 * and ../GLWebGPU.js.
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

test("backend renders primitives and picks on real pixels", async ({ page }, testInfo) => {
    // The project decides which backend page to load (see playwright.config.mjs).
    const scene = (testInfo.project.use && testInfo.project.use.scene) || "webgl2";
    const query = scene === "webgl2" ? "" : "?scene=" + scene;

    const logs = [];
    page.on("console", (m) => logs.push("[console." + m.type() + "] " + m.text()));
    page.on("pageerror", (e) => logs.push("[pageerror] " + String(e)));
    page.on("requestfailed", (r) => logs.push("[requestfailed] " + r.url() + " " + (r.failure() && r.failure().errorText)));

    await page.goto(base + "/test/smoke.html" + query);
    try {
        await page.waitForFunction(() => !!window.__SMOKE_RESULT__, null, { timeout: 15000 });
    } catch (e) {
        console.log("--- lite-gl smoke page diagnostics (" + scene + ") ---\n" + (logs.join("\n") || "(no console/request output)"));
        throw e;
    }

    const result = await page.evaluate(() => window.__SMOKE_RESULT__);

    // Surface each in-page check. A skip (ok:null) is NOT swallowed silently: it leaves a
    // visible trace (an annotation + a console line) so an all-skipped backend is obvious in
    // the report. A real check (ok:true/false) is asserted; a post-adapter throw fails here.
    for (const c of result.checks) {
        if (c.ok === null) {
            const detail = c.name + (c.detail ? " -- " + c.detail : "");
            testInfo.annotations.push({ type: "skip:" + scene, description: detail });
            console.log("[smoke skip][" + scene + "] " + detail);
            continue;
        }
        expect(c.ok, c.name + (c.detail ? " -- " + c.detail : "")).toBe(true);
    }
    expect(result.pass).toBe(true);
});

// Backend launch args (software rendering for headless CI) live per-project in
// playwright.config.mjs.
