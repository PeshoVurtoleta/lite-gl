import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, LAYOUT } from "../GL.js";

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
