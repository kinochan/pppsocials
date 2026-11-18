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
  const directory = await mkdtemp(path.join(os.tmpdir(), "facebook-publish-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, Buffer.alloc(256 * 1024));
  let status = initialStatus;
  let active = 1;
  let postId;
  let message;
  const progress = [];
  const execute = async (sql, params) => {
    if (sql.includes("SET upload_percent")) {
      progress.push(params[0]);
      return [{ affectedRows: status === "uploading" && active === 1 ? 1 : 0 }];
    }
    if (sql.includes("SET status = ?, meta_video_id")) {
      if (params[3] !== status || active !== 1 || !allowTransition(params[3], params[0])) {
        return [{ affectedRows: 0 }];
      }
      status = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("status = 'published'")) {
      [postId, message] = params;
      status = "published";
      active = null;
      return [{ affectedRows: 1 }];
    }
    [status, active, message] = params;
    return [{ affectedRows: 1 }];
  };
  try {
    const metaPublish = await load("src/lib/meta-publish.ts", {}, fetchMock);
    const lib = await load("src/lib/facebook-publish.ts", {
      "@/src/lib/db": { db: { execute } },
      "@/src/lib/videos": { uploadFilePath: () => file },
      "@/src/lib/meta-publish": metaPublish,
    }, fetchMock);
    await lib.publishFacebookStory({
      id: "job-id", pageId: "123", filepath: "uploads/clip.mp4", token: "secret-token",
    });
    return { status, active, postId, message, progress };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const startResponse = () => Response.json({
  video_id: "456", upload_url: "https://rupload.facebook.com/video-upload/v27.0/456",
});

test("uploads and publishes a Page Story with progress", async () => {
  const calls = [];
  const result = await runPublish(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return startResponse();
    if (calls.length === 2) {
      assert.equal((await new Response(options.body).arrayBuffer()).byteLength, 256 * 1024);
      return Response.json({ success: true });
    }
    return Response.json({ success: true, post_id: "123_789" });
  });
  assert.equal(result.status, "published");
  assert.equal(result.active, null);
  assert.equal(result.postId, "123_789");
  assert.ok(result.progress.some((value) => value > 0 && value < 100));
  assert.equal(result.progress.at(-1), 100);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://graph.facebook.com/v27.0/123/video_stories");
  assert.equal(calls[0].options.body.get("upload_phase"), "start");
  assert.equal(calls[1].url, "https://rupload.facebook.com/video-upload/v27.0/456");
  assert.equal(calls[1].options.headers.Authorization, "OAuth secret-token");
  assert.equal(calls[1].options.headers.file_size, String(256 * 1024));
  assert.equal(calls[2].options.body.get("upload_phase"), "finish");
  assert.equal(calls[2].options.body.get("video_id"), "456");
  assert.equal(calls[2].options.body.has("caption"), false);
  assert.ok(calls.every(({ url }) => !url.includes("secret-token")));
});

test("rejects untrusted upload URLs before sending a Page token", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    return Response.json({ video_id: "456", upload_url: "https://evil.example/video-upload/v27.0/456" });
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.active, null);
});

test("does not publish after an upload failure", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    return calls === 1 ? startResponse() : Response.json({ success: false });
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.active, null);
  assert.ok(!result.progress.includes(100));
});

test("keeps an uncertain finish active to prevent accidental retries", async () => {
  let calls = 0;
  const result = await runPublish(async (_url, options) => {
    calls++;
    if (calls === 1) return startResponse();
    if (calls === 2) {
      await new Response(options.body).arrayBuffer();
      return Response.json({ success: true });
    }
    throw new Error("Connection interrupted");
  });
  assert.equal(calls, 3);
  assert.equal(result.status, "unknown");
  assert.equal(result.active, 1);
  assert.match(result.message, /Check the Facebook Page/);
});

test("does not publish a resolved job or one resolved before finishing", async () => {
  let calls = 0;
  const fetchMock = async (_url, options) => {
    calls++;
    if (calls === 1) return startResponse();
    await new Response(options.body).arrayBuffer();
    return Response.json({ success: true });
  };
  await runPublish(fetchMock, "resolved");
  assert.equal(calls, 0);
  await runPublish(fetchMock, "queued", (_from, to) => to !== "publishing");
  assert.equal(calls, 2);
});

test("route requires access, keeps Page tokens private, and protects active attempts", async () => {
  const jobs = [];
  let deny = true;
  let duplicate = false;
  const calls = [];
  const readInput = await load("src/lib/auth-input.ts", {});
  const route = await load("app/api/library/publish/facebook/route.ts", {
    "next/server": { after: (callback) => jobs.push(callback) },
    "@/src/lib/access": { requireApiAccess: async (_request, adminOnly) => {
      assert.notEqual(adminOnly, true);
      return deny ? new Response(null, { status: 401 }) : null;
    } },
    "@/src/lib/auth-input": readInput,
    "@/src/lib/db": { db: { execute: async (sql) => {
      if (sql.startsWith("SELECT filename")) return [[{ filename: "clip.mp4", filepath: "uploads/clip.mp4" }]];
      if (sql.includes("INSERT INTO") && duplicate) {
        const error = new Error("Duplicate");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      if (sql.includes("INSERT INTO")) return [{ affectedRows: 1 }];
      if (sql.includes("UPDATE facebook_publications")) return [{ affectedRows: 0 }];
      return [[]];
    } } },
    "@/src/lib/facebook": {
      facebookConfig: () => ({ key: Buffer.alloc(32) }),
      savedFacebookPages: async () => [{ id: "123", name: "Our Page", accessToken: "secret-token" }],
    },
    "@/src/lib/facebook-publish": { publishFacebookStory: async (job) => calls.push(job) },
    "@/src/lib/videos": { validVideoId: (id) => /^\d+$/.test(id) },
  });
  const body = {
    id: "ec48471f-46a1-44db-ac93-851c5ab316de",
    videoId: "1", filename: "clip.mp4", accountId: "123", mediaType: "STORIES",
  };
  const request = (method, input) => new Request("https://example.test/api/library/publish/facebook", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await route.POST(request("POST", body))).status, 401);
  assert.equal((await route.PATCH(request("PATCH", { id: body.id, confirm: true }))).status, 401);
  assert.equal((await route.GET(new Request("https://example.test/?video=1"))).status, 401);
  deny = false;
  const getResponse = await route.GET(new Request("https://example.test/?video=1"));
  assert.deepEqual((await getResponse.json()).accounts, [{ id: "123", username: "Our Page" }]);
  assert.equal((await route.POST(request("POST", { ...body, accountId: "999" }))).status, 400);
  assert.equal((await route.POST(request("POST", { ...body, filename: "old.mp4" }))).status, 409);
  assert.equal((await route.POST(request("POST", { ...body, mediaType: "REELS" }))).status, 400);
  assert.equal((await route.PATCH(request("PATCH", { id: body.id, confirm: true }))).status, 409);
  duplicate = true;
  assert.equal((await route.POST(request("POST", body))).status, 409);
  assert.equal(jobs.length, 0);
  duplicate = false;
  assert.equal((await route.POST(request("POST", body))).status, 202);
  assert.equal(jobs.length, 1);
  await jobs[0]();
  assert.equal(calls[0].pageId, "123");
  assert.equal(calls[0].token, "secret-token");
});
