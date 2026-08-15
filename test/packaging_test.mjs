import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, LAYOUT, PICK_MAX_ID as CORE_PICK_MAX_ID, PICK_PENDING as CORE_PICK_PENDING } from "../GL.js";
import { PICK_MAX_ID as BACKEND_PICK_MAX_ID } from "../GLBackend.js";
import { PICK_MAX_ID as WEBGPU_PICK_MAX_ID, PICK_PENDING as WEBGPU_PICK_PENDING } from "../GLWebGPU.js";

// Cheap guards for the GL0 packaging invariants -- a future edit that drifts the
// version across the three surfaces, or breaks the LAYOUT table, fails here
// instead of shipping. No runtime deps; reads the shipped files directly.

const root = new URL("../", import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

const pkg = JSON.parse(read("package.json"));
const llms = read("llms.txt");
const readme = read("README.md");

test("VERSION const matches package.json version", () => {
    assert.equal(VERSION, pkg.version);
});

test("llms.txt documents the current VERSION string", () => {
    assert.ok(
        llms.includes('VERSION = "' + VERSION + '"'),
        "llms.txt must reference the shipped VERSION -- version drift across surfaces"
    );
});

test("LAYOUT strides are pinned (POINT/QUAD/LINE/POINT_HI)", () => {
    assert.equal(LAYOUT.POINT, 8);
    assert.equal(LAYOUT.QUAD, 9);
    assert.equal(LAYOUT.LINE, 9);
    assert.equal(LAYOUT.POINT_HI, 10);
});

test("README LAYOUT table lists POINT_HI: 10", () => {
    assert.ok(
        /POINT_HI[^0-9]*10/.test(readme),
        "README LAYOUT table must carry POINT_HI: 10 to match the runtime"
    );
});

test("no shipped file imports the blocked /GLBackend.js subpath", () => {
    for (const [name, src] of [["README.md", readme], ["llms.txt", llms]]) {
        assert.ok(
            !src.includes("lite-gl/GLBackend.js"),
            name + " uses the exports-mapped '/backend' specifier, never '/GLBackend.js'"
        );
    }
});

test("no shipped file imports the blocked deep /GLWebGPU.js subpath", () => {
    // Consumers must use the exports-mapped '/webgpu' specifier, never the deep file path
    // (the GL-01 packaging class: a deep import bypasses the exports map).
    for (const [name, src] of [["README.md", readme], ["llms.txt", llms]]) {
        assert.ok(
            !src.includes("lite-gl/GLWebGPU.js"),
            name + " uses the exports-mapped '/webgpu' specifier, never '/GLWebGPU.js'"
        );
    }
});

test("the WebGPU backend ships (GLWebGPU.js + GLWebGPU.d.ts in files[]) via a 4-key '/webgpu' export", () => {
    assert.ok(pkg.files.includes("GLWebGPU.js"), "GLWebGPU.js must be in package.json files[]");
    assert.ok(pkg.files.includes("GLWebGPU.d.ts"), "GLWebGPU.d.ts must be in package.json files[]");
    const webgpu = pkg.exports["./webgpu"];
    assert.ok(webgpu, "package.json exports must map './webgpu'");
    assert.deepEqual(
        Object.keys(webgpu), ["types", "node", "import", "default"],
        "the './webgpu' export uses the same 4-key shape as './backend'"
    );
    assert.equal(webgpu.types, "./GLWebGPU.d.ts");
    assert.equal(webgpu.import, "./GLWebGPU.js");
});

test("test-only helpers never ship (mockWebGPU.mjs is not in files[])", () => {
    assert.ok(!pkg.files.includes("test/mockWebGPU.mjs"), "the shared mock is a test helper, not shipped");
    for (const f of pkg.files) assert.ok(!f.startsWith("test/"), "no test file may appear in files[]: " + f);
});

test("PICK_MAX_ID is identical across GL.js, GLBackend.js and GLWebGPU.js", () => {
    assert.equal(CORE_PICK_MAX_ID, 0xFFFFFE, "the core value is the 24-bit space minus the miss sentinel");
    assert.equal(BACKEND_PICK_MAX_ID, CORE_PICK_MAX_ID, "the WebGL2 backend re-exports the SAME value");
    assert.equal(WEBGPU_PICK_MAX_ID, CORE_PICK_MAX_ID, "the WebGPU backend re-exports the SAME value");
});

test("PICK_PENDING is the deferred sentinel (-2) and matches across GL.js and the WebGPU backend", () => {
    assert.equal(CORE_PICK_PENDING, -2, "PICK_PENDING is -2 (readback not yet resolved)");
    assert.equal(WEBGPU_PICK_PENDING, CORE_PICK_PENDING, "the WebGPU backend re-exports the SAME PICK_PENDING");
});
