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

async function runPublish(fetchMock, initialStatus = "queued", allowTransition = () => true,
  fileContents = "video", onProgress = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "instagram-publish-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, fileContents);
  let status = initialStatus;
  let active = 1;
  let mediaId;
  let message;
  const updates = [];
  const execute = async (sql, params) => {
    updates.push({ sql, params });
    if (sql.includes("SET upload_percent")) {
      onProgress(params[0]);
      return [{ affectedRows: status === "uploading" && active === 1 ? 1 : 0 }];
    }
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
    const metaPublish = await load("src/lib/meta-publish.ts", {}, fetchMock);
    const lib = await load("src/lib/instagram-publish.ts", {
      "@/src/lib/db": { db: { execute } },
      "@/src/lib/videos": { uploadFilePath: () => file },
      "@/src/lib/meta-publish": metaPublish,
    }, fetchMock);
    await lib.publishInstagramStory({
      id: "job-id", accountId: "123", filepath: "uploads/clip.mp4", token: "secret-token",
    });
    return { status, active, mediaId, message, updates };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("tracks transfer progress, waits for processing and publishes a Story", async () => {
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
  assert.equal(calls[0].options.body.get("media_type"), "STORIES");
  assert.equal(calls[0].options.body.get("upload_type"), "resumable");
  assert.equal(calls[0].options.body.has("caption"), false);
  assert.equal(calls[1].url, "https://rupload.facebook.com/ig-api-upload/v27.0/456");
  assert.equal(calls[1].options.headers.file_size, "5");
  assert.equal(calls[3].options.body.get("creation_id"), "456");
  assert.ok(calls.every(({ url }) => !url.includes("secret-token")));
  assert.deepEqual(result.updates.filter(({ sql }) => sql.includes("SET upload_percent")).map(({ params }) => params[0]), [0, 99, 100]);
});

test("reports intermediate transfer progress without claiming Meta accepted it early", async () => {
  const progress = [];
  let calls = 0;
  const result = await runPublish(async (_url, options) => {
    calls++;
    if (calls === 1) return Response.json({ id: "456" });
    if (calls === 2) {
      await new Response(options.body).arrayBuffer();
      assert.equal(progress.includes(100), false);
      return Response.json({ success: true });
    }
    return Response.json(calls === 3 ? { status_code: "FINISHED" } : { id: "789" });
  }, "queued", () => true, Buffer.alloc(256 * 1024), (percent) => progress.push(percent));
  assert.equal(result.status, "published");
  assert.ok(progress.some((percent) => percent > 0 && percent < 99));
  assert.equal(progress.at(-1), 100);
});

test("does not publish when progress cannot be saved", async () => {
  let calls = 0;
  const progress = [];
  const result = await runPublish(async (_url, options) => {
    calls++;
    if (calls === 1) return Response.json({ id: "456" });
    await new Response(options.body).arrayBuffer();
    return Response.json({ success: true });
  }, "queued", () => true, Buffer.alloc(256 * 1024), (percent) => {
    progress.push(percent);
    if (percent > 0) throw new Error("Database unavailable");
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(progress.includes(100), false);
});

test("does not mark an unconsumed upload as complete", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    return calls === 1 ? Response.json({ id: "456" }) : Response.json({ success: true });
  }, "queued", () => true, Buffer.alloc(256 * 1024));
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.match(result.message, /incomplete upload/);
  assert.ok(!result.updates.some(({ sql, params }) => sql.includes("SET upload_percent") && params[0] === 100));
});

test("rejects Story files over the 100 MB limit before contacting Meta", async () => {
  for (const [size, expectedCalls] of [[100_000_000, 1], [100_000_001, 0]]) {
    let status = "queued";
    let message;
    let calls = 0;
    const fetchMock = async () => {
      calls++;
      throw new Error("Stop before uploading");
    };
    const metaPublish = await load("src/lib/meta-publish.ts", {}, fetchMock);
    const lib = await load("src/lib/instagram-publish.ts", {
      "fs/promises": { open: async () => ({
        stat: async () => ({ size, isFile: () => true }),
        close: async () => {},
      }) },
      "@/src/lib/videos": { uploadFilePath: () => "unused" },
      "@/src/lib/meta-publish": metaPublish,
      "@/src/lib/db": { db: { execute: async (sql, params) => {
        if (sql.includes("SET status = ?, container_id")) {
          status = params[0];
        } else if (sql.includes("SET status = ?, active")) {
          status = params[0];
          message = params[2];
        }
        return [{ affectedRows: 1 }];
      } } },
    }, fetchMock);
    await lib.publishInstagramStory({
      id: "job-id", accountId: "123", filepath: "uploads/clip.mp4", token: "secret-token",
    });
    assert.equal(calls, expectedCalls);
    assert.equal(status, "failed");
    if (!expectedCalls) assert.match(message, /100 MB/);
  }
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
  const result = await runPublish(async (_url, options) => {
    calls++;
    if (calls === 1) return Response.json({ id: "456" });
    if (calls === 2) {
      await new Response(options.body).text();
      return Response.json({ success: true });
    }
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
  await runPublish(async (_url, options) => {
    calls++;
    if (calls === 1) return Response.json({ id: "456" });
    if (calls === 2) {
      await new Response(options.body).text();
      return Response.json({ success: true });
    }
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
      instagramPublishingConnection: async (accountId) => accountId === "123" ? ({
        account: { id: accountId, username: "test" }, token: "secret",
      }) : null,
      savedInstagramAccounts: async () => [{ id: "123", username: "test" }],
    },
    "@/src/lib/instagram-publish": { publishInstagramStory: async (job) => calls.push(job) },
    "@/src/lib/videos": { validVideoId: (id) => /^\d+$/.test(id) },
  });
  const body = {
    id: "ec48471f-46a1-44db-ac93-851c5ab316de",
    videoId: "1", filename: "clip.mp4", accountId: "123", mediaType: "STORIES",
  };
  const request = (input) => new Request("https://example.test/api/library/publish/instagram", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await route.POST(request({ ...body, accountId: "999" }))).status, 400);
  assert.equal((await route.POST(request({ ...body, filename: "old.mp4" }))).status, 409);
  assert.equal((await route.POST(request({ ...body, mediaType: undefined }))).status, 400);
  assert.equal((await route.POST(request({ ...body, mediaType: "REELS" }))).status, 400);
  assert.equal(jobs.length, 0);
  const response = await route.POST(request(body));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: body.id });
  assert.equal(jobs.length, 1);
  await jobs[0]();
  assert.equal(calls.at(-1).token, "secret");
  assert.equal(calls.at(-1).accountId, "123");
});

test("returns progress and distinguishes existing Reels from Stories", async () => {
  const publications = [
    { id: "old", mediaType: "REELS", uploadPercent: null, status: "published" },
    { id: "new", mediaType: "STORIES", uploadPercent: 45, status: "uploading" },
  ];
  const route = await load("app/api/library/publish/instagram/route.ts", {
    "next/server": { after: () => {} },
    "@/src/lib/access": { requireApiAccess: async () => null },
    "@/src/lib/db": { db: { execute: async (sql) => {
      assert.match(sql, /media_type AS mediaType/);
      assert.match(sql, /upload_percent AS uploadPercent/);
      return [publications];
    } } },
    "@/src/lib/instagram": {
      instagramConfig: () => ({}),
      savedInstagramAccounts: async () => [],
    },
    "@/src/lib/instagram-publish": {},
    "@/src/lib/videos": { validVideoId: () => true },
  });
  const response = await route.GET(new Request("https://example.test/api/library/publish/instagram?video=1"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).publications, publications);
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
      instagramPublishingConnection: async (accountId) => accountId === "123" ? ({
        account: { id: accountId, username: "test" }, token: "secret",
      }) : null,
    },
    "@/src/lib/instagram-publish": { publishInstagramStory: async () => {} },
    "@/src/lib/videos": { validVideoId: () => true },
  });
  const response = await route.POST(new Request("https://example.test/api/library/publish/instagram", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "ec48471f-46a1-44db-ac93-851c5ab316de",
      videoId: "1", filename: "clip.mp4", accountId: "123", mediaType: "STORIES",
    }),
  }));
  assert.equal(response.status, 409);
  assert.equal(scheduled, 0);
});
