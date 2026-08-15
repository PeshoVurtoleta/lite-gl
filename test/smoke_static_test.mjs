import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// GL8c static regression guard for the real-GPU smoke harness (test/smoke.html,
// test/smoke.spec.mjs, playwright.config.mjs). Playwright itself never runs here
// (no browser in this sandbox); these are cheap source-level assertions that pin
// the fail-closed discipline the planner called out in GL8c so a future edit that
// silently reverts it (e.g. swallows a skip, drops a finally, or lets an unknown
// scene fall through to WebGL2) fails a `node --test` run instead of shipping.

const root = new URL("../", import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

const html = read("test/smoke.html");
const spec = read("test/smoke.spec.mjs");
const cfg = read("playwright.config.mjs");

// Isolate the WebGPU scene's function body (the fail-closed surface under test).
const wgMatch = html.match(/async function runWebGPU\(\)\s*\{([\s\S]*?)\n\}\n/);
assert.ok(wgMatch, "test/smoke.html must define runWebGPU()");
const runWebGPU = wgMatch[1];

test("smoke.html: unknown scene dispatch records a FAIL, not a silent WebGL2 fall-through", () => {
    assert.match(
        html,
        /if \(!runner\) \{\s*add\("known scene requested", false,/,
        "an unrecognised ?scene= must add(..., false, ...) -- never default to runWebGL2"
    );
    // The dispatcher must not unconditionally alias an unknown scene to runWebGL2.
    assert.doesNotMatch(
        html.slice(html.indexOf("const scene = new URLSearchParams")),
        /^\s*let runner = runWebGL2;/,
        "runner must start unassigned/null, not default to runWebGL2"
    );
});

test("smoke.html: every ok:null SKIP in the WebGPU scene occurs pre-device-acquisition", () => {
    // Once GLWebGPU.js is imported, real work begins; a later `add(..., null, ...)` would
    // be an undiscovered SKIP hiding a post-acquisition failure (planner risk, assertion 9a).
    const importIdx = runWebGPU.indexOf('await import("../GLWebGPU.js")');
    assert.ok(importIdx > -1, "runWebGPU must dynamically import GLWebGPU.js");
    const before = runWebGPU.slice(0, importIdx);
    const after = runWebGPU.slice(importIdx);

    const nullAdds = (before.match(/add\([^)]*,\s*null,/g) || []).length;
    assert.ok(nullAdds >= 3, "expects null-SKIP adds for: no navigator.gpu, no adapter, no device (got " + nullAdds + ")");
    assert.doesNotMatch(after, /add\([^)]*,\s*null,/, "no ok:null SKIP may appear after the GLWebGPU import (post-acquisition)");
});

test("smoke.html: a post-acquisition throw is caught and recorded as ok:false, never swallowed", () => {
    assert.match(
        runWebGPU,
        /\} catch \(e\) \{\s*\/\/ Adapter existed[\s\S]*?add\("webgpu scene runs without error after adapter acquisition", false,/,
        "the catch around the acquired-adapter work must add(..., false, ...) -- a FAIL, not a skip"
    );
});

test("smoke.html: WebGPU sink disposals run in a finally block", () => {
    const finallyIdx = runWebGPU.indexOf("} finally {");
    assert.ok(finallyIdx > -1, "runWebGPU must have a finally block");
    const finallyBody = runWebGPU.slice(finallyIdx);
    for (const handle of ["pt", "quad", "target"]) {
        assert.match(
            finallyBody,
            new RegExp("if \\(" + handle + "\\) " + handle + "\\.dispose\\(\\)"),
            "finally must dispose " + handle + " (guarded, since it may be null on an early throw)"
        );
    }
});

test("smoke.html: the deferred-pick sequence asserts PICK_PENDING first, then a concrete hit, then a miss", () => {
    assert.match(runWebGPU, /firstPick === PICK_PENDING/, "first pick() call must be asserted === PICK_PENDING");
    assert.match(runWebGPU, /hitId === 0/, "the polled hit must resolve to a concrete instance id (0)");
    assert.match(runWebGPU, /missId === -1/, "the polled miss must resolve to -1");
});

test("smoke.html: WebGPU point/quad checks assert BOTH a lit (>200) and a dark (<40) pixel", () => {
    assert.match(runWebGPU, /> 200/, "must assert a lit pixel");
    assert.match(runWebGPU, /< 40/, "must assert a dark pixel -- otherwise a blank frame false-passes");
});

test("smoke.html: the WebGL2 scene also pairs lit() and dark() (blank-frame guard)", () => {
    const wg2Match = html.match(/async function runWebGL2\(\)\s*\{([\s\S]*?)\nasync function pollPick/);
    assert.ok(wg2Match, "test/smoke.html must define runWebGL2()");
    const body = wg2Match[1];
    assert.match(body, /\blit\(/, "runWebGL2 must call lit(...)");
    assert.match(body, /\bdark\(/, "runWebGL2 must call dark(...)");
});

test("smoke.spec.mjs: a skip (ok:null) is surfaced via an annotation and a console line, never swallowed", () => {
    assert.doesNotMatch(spec, /if \(c\.ok === null\) continue;/, "a bare continue would swallow the skip silently");
    assert.match(spec, /testInfo\.annotations\.push\(\{ type: "skip:" \+ scene/, "skip must be recorded as a test annotation");
    assert.match(spec, /console\.log\("\[smoke skip\]/, "skip must also be logged to the console");
});

test("smoke.spec.mjs: expect(result.pass).toBe(true) runs unconditionally, outside the per-check skip branch", () => {
    const lines = spec.split("\n");
    const idx = lines.findIndex((l) => l.includes("expect(result.pass).toBe(true)"));
    assert.ok(idx > -1, "must assert on result.pass");
    // Must be a top-level statement inside the test body, not nested inside the for-loop's
    // `if (c.ok === null)` branch (which would make it conditional on the last check only).
    const indent = lines[idx].match(/^\s*/)[0].length;
    const loopIdx = lines.findIndex((l) => l.includes("for (const c of result.checks)"));
    const loopIndent = lines[loopIdx].match(/^\s*/)[0].length;
    assert.ok(indent <= loopIndent, "expect(result.pass) must sit outside/after the per-check loop, not nested inside it");
});

test("smoke.spec.mjs: the scene query is derived from the project's use.scene, not hard-coded", () => {
    assert.match(spec, /testInfo\.project\.use && testInfo\.project\.use\.scene/, "must read use.scene off the active project");
});

test("playwright.config.mjs: a 'webgpu' project exists and carries use.scene:\"webgpu\"", () => {
    const m = cfg.match(/name:\s*"webgpu"[\s\S]{0,40}use:\s*\{([\s\S]*?)\},\s*\},/);
    assert.ok(m, "playwright.config.mjs must declare a 'webgpu' project");
    assert.match(m[1], /scene:\s*"webgpu"/, "the webgpu project's use block must set scene: \"webgpu\"");
});

test("playwright.config.mjs: a 'webgl2' project exists and carries use.scene:\"webgl2\"", () => {
    const m = cfg.match(/name:\s*"webgl2"[\s\S]{0,40}use:\s*\{([\s\S]*?)\},\s*\},/);
    assert.ok(m, "playwright.config.mjs must declare a 'webgl2' project");
    assert.match(m[1], /scene:\s*"webgl2"/, "the webgl2 project's use block must set scene: \"webgl2\"");
});
