import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(file, dependencies, fetchMock) {
  const source = await readFile(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "fetch", compiled)(
    (name) => name in dependencies ? dependencies[name] : require(name), exports, fetchMock
  );
  return exports;
}

const url = "https://open-upload.tiktokapis.com/video/?upload_id=abc&upload_token=secret";
const ok = (data) => Response.json({ data, error: { code: "ok" } });

async function runUpload(fetchMock, size = 10) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiktok-upload-"));
  const filepath = path.join(directory, "clip.mp4");
  await writeFile(filepath, Buffer.alloc(size));
  let status = "queued";
  let active = 1;
  let publishId = null;
  const progress = [];
  const db = { execute: async (sql, params) => {
    if (sql.includes("status = 'uploading'") && sql.includes("status = 'queued'")) {
      status = "uploading";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET publish_id")) {
      publishId = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET upload_percent")) {
      progress.push(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET status = 'processing'")) {
      status = "processing";
      return [{ affectedRows: 1 }];
    }
    [status, active] = params;
    return [{ affectedRows: 1 }];
  } };
  class TikTokConnectionError extends Error {}
  try {
    const lib = await load("src/lib/tiktok-upload.ts", {
      "@/src/lib/db": { db },
      "@/src/lib/tiktok": { tiktokConfig: () => ({ uploadEnabled: true }), tiktokUploadToken: async () => "access-token", TikTokConnectionError },
      "@/src/lib/videos": { uploadFilePath: () => filepath },
    }, fetchMock);
    await lib.uploadTikTokDraft({ id: "job", accountId: "account", filepath: "uploads/clip.mp4" });
    return { status, active, publishId, progress };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("uploads the video to TikTok and reports processing rather than a completed post", async () => {
  const calls = [];
  const result = await runUpload(async (target, options) => {
    calls.push({ target, options });
    return calls.length === 1 ? ok({ publish_id: "v_inbox_file~v2.123", upload_url: url })
      : new Response(null, { status: 201 });
  });
  assert.equal(result.status, "processing");
  assert.equal(result.active, 1);
  assert.equal(result.publishId, "v_inbox_file~v2.123");
  assert.deepEqual(result.progress, [100]);
  assert.equal(calls[0].target, "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    source_info: { source: "FILE_UPLOAD", video_size: 10, chunk_size: 10, total_chunk_count: 1 },
  });
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers["Content-Range"], "bytes 0-9/10");
});

test("rejects untrusted upload URLs and preserves uncertain transfers", async () => {
  let calls = 0;
  const unsafe = await runUpload(async () => {
    calls++;
    return ok({ publish_id: "id", upload_url: "https://evil.example/video/?upload_id=x&upload_token=y" });
  });
  assert.equal(calls, 1);
  assert.equal(unsafe.status, "failed");
  const uncertain = await runUpload(async () => {
    if (++calls === 2) return ok({ publish_id: "id", upload_url: url });
    throw new Error("network interruption");
  });
  assert.equal(uncertain.status, "unknown");
  assert.equal(uncertain.active, 1);
});

test("splits large uploads according to TikTok's final-chunk rules", async () => {
  const ranges = [];
  let init;
  const result = await runUpload(async (_target, options) => {
    if (!init) {
      init = JSON.parse(options.body);
      return ok({ publish_id: "id", upload_url: url });
    }
    ranges.push(options.headers["Content-Range"]);
    return new Response(null, { status: ranges.length === 6 ? 201 : 206 });
  }, 65_000_001);
  assert.equal(init.source_info.total_chunk_count, 6);
  assert.equal(ranges.at(-1), "bytes 50000000-65000000/65000001");
  assert.equal(result.status, "processing");
});

test("checks inbox delivery without claiming the video was published", async () => {
  const writes = [];
  class TikTokConnectionError extends Error {}
  const lib = await load("src/lib/tiktok-upload.ts", {
    "@/src/lib/db": { db: { execute: async (sql, params) => {
      if (sql.startsWith("SELECT")) return [[{ account_id: "account", publish_id: "id" }]];
      writes.push(params);
      return [{ affectedRows: 1 }];
    } } },
    "@/src/lib/tiktok": { tiktokConfig: () => ({ uploadEnabled: true }), tiktokUploadToken: async () => "token", TikTokConnectionError },
    "@/src/lib/videos": {},
  }, async () => ok({ status: "SEND_TO_USER_INBOX" }));
  await lib.checkTikTokUpload("job");
  assert.equal(writes[0][0], "delivered");
  assert.equal(writes[0][1], null);
  assert.match(writes[0][2], /inbox notification/);
});

test("upload route requires access and confirmation and blocks duplicate requests", async () => {
  let deny = true;
  let duplicate = false;
  const jobs = [];
  const readInput = await load("src/lib/auth-input.ts", {});
  class TikTokConnectionError extends Error {}
  class TikTokUploadError extends Error {}
  const route = await load("app/api/library/publish/tiktok/route.ts", {
    "next/server": { after: (callback) => jobs.push(callback) },
    "@/src/lib/access": { requireApiAccess: async () => deny ? new Response(null, { status: 401 }) : null },
    "@/src/lib/auth-input": readInput,
    "@/src/lib/db": { db: { execute: async (sql) => {
      if (sql.startsWith("SELECT filename")) return [[{ filename: "clip.mp4", filepath: "uploads/clip.mp4" }]];
      if (sql.includes("INSERT INTO") && duplicate) {
        const error = new Error("Duplicate"); error.code = "ER_DUP_ENTRY"; throw error;
      }
      return [{ affectedRows: 1 }];
    } } },
    "@/src/lib/tiktok": { tiktokConfig: () => ({ uploadEnabled: true }), savedTikTokAccounts: async () => [{ id: "acct", displayName: "Account" }], TikTokConnectionError },
    "@/src/lib/tiktok-upload": { uploadTikTokDraft: async () => {}, checkTikTokUpload: async () => {}, TikTokUploadError },
    "@/src/lib/videos": { validVideoId: (id) => /^\d+$/.test(id) },
  });
  const body = { id: "ec48471f-46a1-44db-ac93-851c5ab316de", videoId: "1", filename: "clip.mp4", accountId: "acct", confirm: true };
  const request = (input) => new Request("https://example.test/api/library/publish/tiktok", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await route.POST(request(body))).status, 401);
  deny = false;
  assert.equal((await route.POST(request({ ...body, confirm: false }))).status, 400);
  assert.equal((await route.POST(request({ ...body, accountId: "other" }))).status, 400);
  duplicate = true;
  assert.equal((await route.POST(request(body))).status, 409);
  assert.equal(jobs.length, 0);
  duplicate = false;
  assert.equal((await route.POST(request(body))).status, 202);
  assert.equal(jobs.length, 1);
});
