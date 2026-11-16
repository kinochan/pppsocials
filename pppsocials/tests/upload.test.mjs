import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));

async function loadHandler(directory, execute, busboyOverride) {
  const source = await readFile(
    path.join(testDir, "..", "app", "api", "upload", "route.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => {
    if (name === "@/src/lib/db") return { db: { execute } };
    if (name === "busboy" && busboyOverride) return busboyOverride;
    return require(name);
  };
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

test("accepts the maximum video size and rejects one byte more, removing the partial file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  try {
    let writes = 0;
    const parser = (options) => {
      assert.equal(options.limits.fileSize, 1_000_000_001);
      return require("busboy")({ ...options, limits: { ...options.limits, fileSize: 11 } });
    };
    const post = await loadHandler(directory, async () => { writes++; }, parser);
    const makeRequest = (contents) => {
      const form = new FormData();
      form.set("title", "Title");
      form.set("description", "");
      form.set("file", new File([contents], "clip.mp4", { type: "video/mp4" }));
      return new Request("http://localhost/api/upload", { method: "POST", body: form });
    };
    const accepted = await post(makeRequest("0123456789"));
    assert.equal(accepted.status, 200);
    const rejected = await post(makeRequest("01234567890"));
    assert.equal(rejected.status, 413);
    assert.equal(writes, 1);
    assert.equal((await readdir(path.join(directory, "uploads"))).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes video data before the complete request has arrived", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  let release;
  const waitForRelease = new Promise((resolve) => { release = resolve; });
  try {
    const post = await loadHandler(directory, async () => {});
    const prefix = Buffer.from(
      '--boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\nTitle\r\n' +
      '--boundary\r\nContent-Disposition: form-data; name="description"\r\n\r\nDescription\r\n' +
      '--boundary\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\n' +
      "Content-Type: video/mp4\r\n\r\n"
    );
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(prefix);
        controller.enqueue(Buffer.alloc(100_000, 120));
        await waitForRelease;
        controller.enqueue(Buffer.from("\r\n--boundary--\r\n"));
        controller.close();
      },
    });
    const result = post(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=boundary" },
      body,
      duplex: "half",
    }));
    let bytesWritten = 0;
    for (let attempt = 0; attempt < 50 && !bytesWritten; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const files = await readdir(path.join(directory, "uploads")).catch(() => []);
      if (files.length) bytesWritten = (await stat(path.join(directory, "uploads", files[0]))).size;
    }
    release();
    assert.equal((await result).status, 200);
    assert.ok(bytesWritten > 0, "video should be written before the request finishes");
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans up an interrupted multipart upload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  try {
    let writes = 0;
    const post = await loadHandler(directory, async () => { writes++; });
    const body = [
      "--boundary\r\n",
      'Content-Disposition: form-data; name="file"; filename="clip.mp4"\r\n',
      "Content-Type: video/mp4\r\n\r\n",
      "partial video",
    ].join("");
    const response = await post(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=boundary" },
      body,
    }));
    assert.equal(response.status, 500);
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(path.join(directory, "uploads")), []);
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
    assert.deepEqual(await readdir(path.join(directory, "uploads")), []);
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
