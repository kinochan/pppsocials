import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));

async function loadHandler(directory, execute) {
  const source = await readFile(
    path.join(testDir, "..", "app", "api", "upload", "route.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name) =>
    name === "@/src/lib/db" ? { db: { execute } } : require(name);
  const load = new Function("require", "exports", "process", compiled);
  load(mockRequire, exports, { cwd: () => directory });
  return exports.POST;
}

function request(title, description = "Post description") {
  const form = new FormData();
  form.set("title", title);
  form.set("description", description);
  form.set("file", new File(["video content"], "clip.mp4", { type: "video/mp4" }));
  return new Request("http://localhost/api/upload", { method: "POST", body: form });
}

test("saves metadata and distinct files for uploads with the same name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  try {
    const calls = [];
    const post = await loadHandler(directory, async (...args) => calls.push(args));
    const first = await post(request(" My title "));
    const second = await post(request("Another title", ""));
    const firstResult = await first.json();
    const secondResult = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(firstResult.filename, secondResult.filename);
    assert.equal(await readFile(firstResult.savedTo, "utf8"), "video content");
    assert.equal(await readFile(secondResult.savedTo, "utf8"), "video content");
    assert.match(calls[0][0], /INSERT INTO videos/);
    assert.deepEqual(calls[0][1], [
      "My title",
      "Post description",
      path.join("uploads", firstResult.filename),
    ]);
    assert.deepEqual(calls[1][1], [
      "Another title",
      "",
      path.join("uploads", secondResult.filename),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an empty title without writing a file or database record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  try {
    let called = false;
    const post = await loadHandler(directory, async () => { called = true; });
    const response = await post(request("   "));
    assert.equal(response.status, 400);
    assert.equal(called, false);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes the uploaded file and reports a database failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  try {
    const post = await loadHandler(directory, async () => {
      throw new Error("database unavailable");
    });
    const response = await post(request("Title"));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).success, false);
    assert.deepEqual(await readdir(path.join(directory, "uploads")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
