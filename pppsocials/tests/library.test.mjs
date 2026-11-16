import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));

async function loadHandler(route, directory, execute) {
  const source = await readFile(path.join(testDir, "..", "app", "api", "library", route), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => {
    if (name === "@/src/lib/db") return { db: { execute } };
    if (name === "next/server") return { ...require(name), connection: async () => {} };
    return require(name);
  };
  new Function("require", "exports", "process", compiled)(mockRequire, exports, { cwd: () => directory });
  return exports.GET;
}

function request(range) {
  return new Request("http://localhost/api/library/1", {
    headers: range ? { range } : {},
  });
}

function context(id = "1") {
  return { params: Promise.resolve({ id }) };
}

test("library returns saved metadata and reports database errors", async () => {
  const rows = [{ id: "9007199254740993", title: "Video", description: "Details" }];
  const get = await loadHandler("route.ts", "", async (sql) => {
    assert.match(sql, /CAST\(id AS CHAR\)/);
    return [rows];
  });
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), rows);

  const failed = await loadHandler("route.ts", "", async () => { throw new Error("database unavailable"); });
  assert.equal((await failed()).status, 500);
});

test("streams whole videos and byte ranges for browser seeking", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-library-"));
  try {
    await mkdir(path.join(directory, "uploads"));
    await writeFile(path.join(directory, "uploads", "clip.mp4"), "0123456789");
    const get = await loadHandler("[id]/route.ts", directory, async (sql, params) => {
      assert.deepEqual(params, ["1"]);
      return [[{ filepath: "uploads/clip.mp4" }]];
    });

    const whole = await get(request(), context());
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(whole.headers.get("content-length"), "10");
    assert.equal(await whole.text(), "0123456789");

    for (const [range, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-99", "89", "bytes 8-9/10"],
    ]) {
      const partial = await get(request(range), context());
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get("content-range"), contentRange);
      assert.equal(await partial.text(), expected);
    }

    for (const range of ["bytes=10-", "bytes=-0", "bytes=3-1", "bytes=0-1,3-4"]) {
      const invalid = await get(request(range), context());
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get("content-range"), "bytes */10");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing videos and paths outside the upload directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-library-"));
  try {
    await mkdir(path.join(directory, "uploads"));
    const missing = await loadHandler("[id]/route.ts", directory, async () => [[]]);
    assert.equal((await missing(request(), context("not-an-id"))).status, 404);
    assert.equal((await missing(request(), context())).status, 404);

    const absent = await loadHandler("[id]/route.ts", directory, async () => [[{ filepath: "uploads/missing.mp4" }]]);
    assert.equal((await absent(request(), context())).status, 404);

    const outside = await loadHandler("[id]/route.ts", directory, async () => [[{ filepath: "../secret.mp4" }]]);
    assert.equal((await outside(request(), context())).status, 500);

    await writeFile(path.join(directory, "secret.mp4"), "secret");
    await symlink(path.join(directory, "secret.mp4"), path.join(directory, "uploads", "link.mp4"));
    const link = await loadHandler("[id]/route.ts", directory, async () => [[{ filepath: "uploads/link.mp4" }]]);
    assert.equal((await link(request(), context())).status, 500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
