import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));

async function loadHandler(directory, execute, busboyOverride, customConnection) {
  const helperSource = await readFile(path.join(testDir, "..", "src", "lib", "videos.ts"), "utf8");
  const helperCompiled = ts.transpileModule(helperSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const connection = customConnection ?? {
    async execute(sql, params) {
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }]];
      if (sql.includes("original_filename FROM videos")) return [[]];
      return execute(sql, params);
    },
    release() {},
    destroy() {},
  };
  const db = { execute, getConnection: async () => connection };
  const helper = {};
  const helperRequire = (name) => name === "@/src/lib/db" ? { db } : require(name);
  new Function("require", "exports", "process", helperCompiled)(helperRequire, helper, { cwd: () => directory });
  const source = await readFile(
    path.join(testDir, "..", "app", "api", "upload", "route.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => {
    if (name === "@/src/lib/access") return { requireApiAccess: async () => null };
    if (name === "@/src/lib/videos") return helper;
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

test("saves the original filename with each upload", async () => {
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
    assert.equal(calls[0][0], "INSERT INTO videos (title, description, filename, original_filename, filepath) VALUES (?, ?, ?, ?, ?)");
    assert.deepEqual(calls[0][1], [
      "My title",
      "Post description",
      firstResult.filename,
      "clip.mp4",
      path.join("uploads", firstResult.filename),
    ]);
    assert.deepEqual(calls[1][1], [
      "Another title",
      "",
      secondResult.filename,
      "clip.mp4",
      path.join("uploads", secondResult.filename),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires confirmation and replaces only the selected unchanged match", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  const oldFilename = "12345678-1234-1234-1234-123456789abc-clip.mp4";
  const record = {
    id: "4", title: "Original", description: "Old description", filename: oldFilename,
    original_filename: null, filepath: path.join("uploads", oldFilename),
  };
  try {
    await mkdir(path.join(directory, "uploads"));
    await writeFile(path.join(directory, record.filepath), "old video");
    const connection = {
      async execute(sql, params) {
        if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }]];
        if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }]];
        if (sql.includes("original_filename FROM videos")) {
          assert.deepEqual(params, ["CLIP.mp4", "CLIP.mp4", "CLIP.mp4"]);
          return [[record]];
        }
        if (sql.startsWith("SELECT filepath")) return [[{ filepath: record.filepath }]];
        if (sql.startsWith("UPDATE videos")) {
          assert.equal(params[0], "New title");
          assert.equal(params[1], "New description");
          assert.equal(params[3], "CLIP.mp4");
          assert.equal(params[5], "4");
          Object.assign(record, { title: params[0], description: params[1], filename: params[2], original_filename: params[3], filepath: params[4] });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("SELECT COUNT")) return [[{ count: 0 }]];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {},
      destroy() {},
    };
    const post = await loadHandler(directory, async () => {}, undefined, connection);
    const makeRequest = (replacement, expected = oldFilename) => {
      const form = new FormData();
      form.set("title", "New title");
      form.set("description", "New description");
      form.set("file", new File(["new video"], "CLIP.mp4", { type: "video/mp4" }));
      if (replacement) {
        form.set("replaceId", "4");
        form.set("expectedFilename", expected);
      }
      return new Request("http://localhost/api/upload", { method: "POST", body: form });
    };
    assert.equal((await post(makeRequest(false))).status, 409);
    assert.equal((await post(makeRequest(true, "outdated.mp4"))).status, 409);
    assert.equal(await readFile(path.join(directory, record.filepath), "utf8"), "old video");
    assert.deepEqual(await readdir(path.join(directory, "uploads")), [oldFilename]);

    const response = await post(makeRequest(true));
    assert.equal(response.status, 200);
    assert.equal(record.title, "New title");
    assert.equal(record.description, "New description");
    assert.equal(await readFile(path.join(directory, record.filepath), "utf8"), "new video");
    assert.deepEqual(await readdir(path.join(directory, "uploads")), [record.filename]);
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

test("saves a video larger than Next.js Proxy's default 10 MB limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pppsocials-upload-"));
  try {
    const post = await loadHandler(directory, async () => {});
    const form = new FormData();
    form.set("title", "Large video");
    form.set("description", "");
    form.set("file", new File([Buffer.alloc(10 * 1024 * 1024 + 1)], "clip.mp4"));
    const response = await post(new Request("http://localhost/api/upload", { method: "POST", body: form }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal((await stat(result.savedTo)).size, 10 * 1024 * 1024 + 1);
  } finally {
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
