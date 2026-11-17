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
  const mockRequire = (name) => name in dependencies ? dependencies[name] : require(name);
  new Function("require", "exports", "fetch", compiled)(mockRequire, exports, fetchMock);
  return exports;
}

async function runPublish(fetchMock, initialStatus = "queued", allowTransition = () => true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "instagram-publish-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, "video");
  let status = initialStatus;
  let active = 1;
  let mediaId;
  let message;
  const updates = [];
  const execute = async (sql, params) => {
    updates.push({ sql, params });
    if (sql.includes("SET status = ?, container_id")) {
      if (params[3] !== status || active !== 1 || !allowTransition(params[3], params[0])) {
        return [{ affectedRows: 0 }];
      }
      status = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("status = 'published'")) {
      mediaId = params[0];
      status = "published";
      active = null;
      return [{ affectedRows: 1 }];
    }
    status = params[0];
    active = params[1];
    message = params[2];
    return [{ affectedRows: 1 }];
  };
  try {
    const lib = await load("src/lib/instagram-publish.ts", {
      "@/src/lib/db": { db: { execute } },
      "@/src/lib/videos": { uploadFilePath: () => file },
    }, fetchMock);
    await lib.publishInstagramReel({
      id: "job-id", accountId: "123", caption: "caption", filepath: "uploads/clip.mp4", token: "secret-token",
    });
    return { status, active, mediaId, message, updates };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("uploads, waits for processing and publishes a Reel", async () => {
  const calls = [];
  const result = await runPublish(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ id: "456" });
    if (calls.length === 2) {
      assert.equal(await new Response(options.body).text(), "video");
      return Response.json({ success: true });
    }
    if (calls.length === 3) return Response.json({ status_code: "FINISHED" });
    return Response.json({ id: "789" });
  });
  assert.equal(result.status, "published");
  assert.equal(result.active, null);
  assert.equal(result.mediaId, "789");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.body.get("media_type"), "REELS");
  assert.equal(calls[0].options.body.get("upload_type"), "resumable");
  assert.equal(calls[0].options.body.get("caption"), "caption");
  assert.equal(calls[1].url, "https://rupload.facebook.com/ig-api-upload/v27.0/456");
  assert.equal(calls[1].options.headers.file_size, "5");
  assert.equal(calls[3].options.body.get("creation_id"), "456");
  assert.ok(calls.every(({ url }) => !url.includes("secret-token")));
});

test("does not publish when upload or processing fails", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    return calls === 1 ? Response.json({ id: "456" }) : Response.json({ success: false });
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.active, null);
});

test("keeps an uncertain publish result active to prevent accidental retries", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    if (calls === 1) return Response.json({ id: "456" });
    if (calls === 2) return Response.json({ success: true });
    if (calls === 3) return Response.json({ status_code: "FINISHED" });
    throw new Error("Connection interrupted");
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.active, 1);
  assert.match(result.message, /Check Instagram/);
});

test("does not publish a job that was already resolved", async () => {
  let calls = 0;
  const result = await runPublish(async () => { calls++; }, "resolved");
  assert.equal(calls, 0);
  assert.equal(result.status, "resolved");
});

test("does not publish if the job is resolved while Meta is processing", async () => {
  let calls = 0;
  await runPublish(async () => {
    calls++;
    if (calls === 1) return Response.json({ id: "456" });
    if (calls === 2) return Response.json({ success: true });
    return Response.json({ status_code: "FINISHED" });
  }, "queued", (from, to) => from !== "processing" || to !== "publishing");
  assert.equal(calls, 3);
});

test("publishing route permits signed-in users and schedules only selected connected accounts", async () => {
  const jobs = [];
  const calls = [];
  const db = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT filename")) return [[{ filename: "clip.mp4", filepath: "uploads/clip.mp4" }]];
    if (sql.includes("INSERT INTO")) return [{ affectedRows: 1 }];
    return [[]];
  } };
  const route = await load("app/api/library/publish/instagram/route.ts", {
    "next/server": { after: (callback) => jobs.push(callback) },
    "@/src/lib/access": { requireApiAccess: async (_request, adminOnly) => {
      assert.notEqual(adminOnly, true);
      return null;
    } },
    "@/src/lib/db": { db },
    "@/src/lib/instagram": {
      instagramConfig: () => ({ key: Buffer.alloc(32) }),
      instagramPublishingConnection: async () => ({
        accounts: [{ id: "123", username: "test" }], token: "secret",
      }),
      savedInstagramAccounts: async () => [{ id: "123", username: "test" }],
    },
    "@/src/lib/instagram-publish": { publishInstagramReel: async (job) => calls.push(job) },
    "@/src/lib/videos": { validVideoId: (id) => /^\d+$/.test(id) },
  });
  const body = {
    id: "ec48471f-46a1-44db-ac93-851c5ab316de",
    videoId: "1", filename: "clip.mp4", accountId: "123", caption: "caption",
  };
  const request = (input) => new Request("https://example.test/api/library/publish/instagram", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await route.POST(request({ ...body, accountId: "999" }))).status, 400);
  assert.equal((await route.POST(request({ ...body, filename: "old.mp4" }))).status, 409);
  assert.equal(jobs.length, 0);
  const response = await route.POST(request(body));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: body.id });
  assert.equal(jobs.length, 1);
  await jobs[0]();
  assert.equal(calls.at(-1).token, "secret");
  assert.equal(calls.at(-1).accountId, "123");
});

test("duplicate publication attempts are rejected without scheduling another upload", async () => {
  let scheduled = 0;
  const route = await load("app/api/library/publish/instagram/route.ts", {
    "next/server": { after: () => { scheduled++; } },
    "@/src/lib/access": { requireApiAccess: async () => null },
    "@/src/lib/db": { db: { execute: async (sql) => {
      if (sql.startsWith("SELECT filename")) return [[{ filename: "clip.mp4", filepath: "uploads/clip.mp4" }]];
      const error = new Error("Duplicate");
      error.code = "ER_DUP_ENTRY";
      throw error;
    } } },
    "@/src/lib/instagram": {
      instagramConfig: () => ({ key: Buffer.alloc(32) }),
      instagramPublishingConnection: async () => ({ accounts: [{ id: "123", username: "test" }], token: "secret" }),
    },
    "@/src/lib/instagram-publish": { publishInstagramReel: async () => {} },
    "@/src/lib/videos": { validVideoId: () => true },
  });
  const response = await route.POST(new Request("https://example.test/api/library/publish/instagram", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "ec48471f-46a1-44db-ac93-851c5ab316de",
      videoId: "1", filename: "clip.mp4", accountId: "123", caption: "",
    }),
  }));
  assert.equal(response.status, 409);
  assert.equal(scheduled, 0);
});
