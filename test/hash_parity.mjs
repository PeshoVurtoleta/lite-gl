// test/hash_parity.mjs -- node test/hash_parity.mjs
//
// GL8a hot-path fence. The v2.0.0 caps seam is allowed to touch EXACTLY two cold
// functions -- reactiveField and didYouMean. Every hot body must be byte-unchanged.
// This gate hashes the SOURCE TEXT of each hot function and compares it to a committed
// SHA256 baseline; any drift exits non-zero. Only reactiveField and didYouMean are
// deliberately NOT hashed (they are the sanctioned change surface).
//
// Extraction is deterministic: a stable header marker locates each function, then a
// brace matcher that skips string and comment content slices the exact body (the point
// sink's upload error string contains a literal "{ capacity }", so naive brace counting
// would mis-slice -- hence the string/comment awareness).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

const GL = read("GL.js");
const BK = read("GLBackend.js");

// Slice the balanced { ... } block that opens at `headerMarker` (which must END in "{").
// Skips // line comments, /* block comments */, and ' " ` string literals so braces
// inside them never affect the depth count.
function sliceBlock(src, headerMarker, from) {
    const at = src.indexOf(headerMarker, from || 0);
    if (at < 0) throw new Error("hash_parity: marker not found -> " + JSON.stringify(headerMarker));
    let i = at + headerMarker.length - 1;   // index of the opening "{"
    const begin = at;
    let depth = 0, mode = 0;   // 0 code, 1 line-comment, 2 block-comment, 3 ' , 4 " , 5 `
    for (; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (mode === 0) {
            if (c === "/" && n === "/") { mode = 1; i++; continue; }
            if (c === "/" && n === "*") { mode = 2; i++; continue; }
            if (c === "'") { mode = 3; continue; }
            if (c === '"') { mode = 4; continue; }
            if (c === "`") { mode = 5; continue; }
            if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) return { text: src.slice(begin, i + 1), end: i + 1 }; }
        } else if (mode === 1) {
            if (c === "\n") mode = 0;
        } else if (mode === 2) {
            if (c === "*" && n === "/") { mode = 0; i++; }
        } else if (mode === 3) {
            if (c === "\\") i++; else if (c === "'") mode = 0;
        } else if (mode === 4) {
            if (c === "\\") i++; else if (c === '"') mode = 0;
        } else if (mode === 5) {
            if (c === "\\") i++; else if (c === "`") mode = 0;
        }
    }
    throw new Error("hash_parity: unbalanced braces from " + JSON.stringify(headerMarker));
}

// A marker that must appear EXACTLY ONCE -> the whole body is that single block.
function one(src, marker) {
    const first = sliceBlock(src, marker);
    if (src.indexOf(marker, first.end) >= 0) {
        throw new Error("hash_parity: marker not unique -> " + JSON.stringify(marker));
    }
    return first.text;
}

// A marker that repeats (upload/draw exist once per sink) -> concatenate every block in
// file order so a drift in ANY sink's copy is caught.
function all(src, marker) {
    let from = 0, out = "", n = 0;
    for (;;) {
        const at = src.indexOf(marker, from);
        if (at < 0) break;
        const b = sliceBlock(src, marker, at);
        out += b.text + "\n";
        from = b.end;
        n++;
    }
    if (n === 0) throw new Error("hash_parity: no occurrences of " + JSON.stringify(marker));
    return out;
}

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Hot functions under fence. Markers are the exact header lines (indentation included).
const targets = {
    "GL.js push":            sha(one(GL, "        push(write) {")),
    "GL.js set":             sha(one(GL, "        set(i, write) {")),
    "GL.js swapRemove":      sha(one(GL, "        swapRemove(i) {")),
    "GL.js flush":           sha(one(GL, "        flush(sink) {")),
    "GLBackend.js pickAt":   sha(one(BK, "function pickAt(gl, picker, use, vao, primitive, resW, resH, count, px, py, sc, applyExtra, clearRGBA) {")),
    "GLBackend.js upload":   sha(all(BK, "        upload(data, floatOffset, floatCount) {")),
    "GLBackend.js draw":     sha(all(BK, "        draw(count) {")),
};

// Committed baselines. GL8a must change NONE of these. If a legitimate hot-path change
// lands in a FUTURE session, update these in the same commit -- never to silence GL8a.
const BASELINE = {
    "GL.js push":          "a81cad62f0a330480d6755f0de96ed1467d60df6e19190528678a53a29200337",
    "GL.js set":           "bc13bd442c06e063cfbf959c270c077cdbf3251bf736cfada062a2e5c3ea4171",
    "GL.js swapRemove":    "54feb3381c15f6abfdfe73b5e22451825ca813e30893550515cf294d9219bdf7",
    "GL.js flush":         "4f95e631ccae787efc702e483f16cb9948c5386f1f9030f4316bdf28b3984e75",
    "GLBackend.js pickAt": "013e05b7f6ff7a991745476fde3f5041337cebafe40fa3706302fe4c17117f2a",
    "GLBackend.js upload": "01b1e349c71d52db425d504a8aa253373d98fc7e264d95f9e392a910a8132a99",
    "GLBackend.js draw":   "02154b481e6edabac5d1253392aa27c6eaa4e174381cf61ec4d1004dd89bac82",
};

let fail = 0;
for (const k of Object.keys(targets)) {
    const got = targets[k];
    const want = BASELINE[k];
    if (want !== got) {
        fail++;
        console.error("FAIL hash drift " + k + "\n  baseline " + (want || "(unset)") + "\n  current  " + got);
    }
}

if (fail === 0) {
    console.log("PASS hash_parity: " + Object.keys(targets).length + " hot functions unchanged");
} else {
    console.error("FAIL hash_parity: " + fail + " hot function(s) drifted -- GL8a may touch only reactiveField/didYouMean");
    process.exitCode = 1;
}
