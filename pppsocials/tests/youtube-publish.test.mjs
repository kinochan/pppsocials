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
const uploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=test-session";
const job = {
  id: "job-id", channelId: "channel-1", filepath: "uploads/clip.mp4",
  title: "Test title", description: "Test description", privacy: "public",
  madeForKids: false, syntheticMedia: true,
};

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

async function runPublish(fetchMock, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-publish-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, Buffer.alloc(options.size ?? 8 * 1024 * 1024 + 42));
  let status = options.status ?? "queued";
  let active = 1;
  let message;
  let youtubeVideoId;
  let actualPrivacy;
  const progress = [];
  const execute = async (sql, params) => {
    if (sql.includes("status = 'uploading'") && sql.includes("status = 'queued'")) {
      if (status !== "queued" || active !== 1) return [{ affectedRows: 0 }];
      status = "uploading";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET upload_percent")) {
      progress.push(params[0]);
      return [{ affectedRows: status === "uploading" && active === 1 ? 1 : 0 }];
    }
    if (sql.includes("status = 'uploaded'")) {
      [youtubeVideoId, actualPrivacy, message] = params;
      status = "uploaded";
      active = null;
      progress.push(100);
      return [{ affectedRows: 1 }];
    }
    [status, active, message] = params;
    return [{ affectedRows: 1 }];
  };
  class YouTubeConnectionError extends Error {}
  class ShortsValidationError extends Error {}
  try {
    const lib = await load("src/lib/youtube-publish.ts", {
      "@/src/lib/db": { db: { execute } },
      "@/src/lib/videos": { uploadFilePath: () => file },
      "@/src/lib/youtube-short": {
        ShortsValidationError,
        validateYouTubeShort: options.validate ?? (async () => {}),
      },
      "@/src/lib/youtube": {
        youtubeConfig: () => ({}),
        youtubePublishingToken: options.token ?? (async () => "access-secret"),
        YouTubeConnectionError,
      },
    }, fetchMock);
    await lib.publishYouTubeVideo(job);
    return { status, active, message, youtubeVideoId, actualPrivacy, progress };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("uploads in chunks, shows acknowledged progress and records actual privacy", async () => {
  const calls = [];
  const result = await runPublish(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(null, { status: 200, headers: { location: uploadUrl } });
    if (calls.length === 2) return new Response(null, { status: 308, headers: { range: "bytes=0-8388607" } });
    return Response.json({ id: "youtube-id", status: { privacyStatus: "private" } }, { status: 201 });
  });
  assert.equal(result.status, "uploaded");
  assert.equal(result.active, null);
  assert.equal(result.youtubeVideoId, "youtube-id");
  assert.equal(result.actualPrivacy, "private");
  assert.match(result.message, /different privacy/);
  assert.deepEqual(result.progress, [0, 99, 100]);
  assert.equal(calls.length, 3);
  const metadata = JSON.parse(calls[0].options.body);
  assert.deepEqual(metadata, {
    snippet: { title: job.title, description: job.description },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  });
  assert.equal(calls[1].options.headers["Content-Range"], "bytes 0-8388607/8388650");
  assert.equal(calls[2].options.headers["Content-Range"], "bytes 8388608-8388649/8388650");
  assert.ok(calls.every(({ url }) => !url.includes("access-secret")));
});

test("rejects an unsafe resumable session URL without sending the token", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    return new Response(null, { headers: { location: "https://evil.example/upload?upload_id=test" } });
  }, { size: 10 });
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.active, null);
});

test("keeps an uncertain result active after upload begins", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    if (calls === 1) return new Response(null, { headers: { location: uploadUrl } });
    throw new Error("Connection interrupted");
  }, { size: 10 });
  assert.equal(calls, 2);
  assert.equal(result.status, "unknown");
  assert.equal(result.active, 1);
  assert.match(result.message, /YouTube Studio/);
  assert.ok(!result.progress.includes(100));
});

test("does not claim a video was uploaded for an invalid progress response", async () => {
  let calls = 0;
  const result = await runPublish(async () => {
    calls++;
    return calls === 1 ? new Response(null, { headers: { location: uploadUrl } })
      : new Response(null, { status: 308, headers: { range: "bytes=0-999999999" } });
  }, { size: 10 });
  assert.equal(result.status, "unknown");
  assert.equal(result.active, 1);
});

test("does not upload a resolved job or a channel without authorization", async () => {
  let calls = 0;
  const fetchMock = async () => { calls++; };
  const resolved = await runPublish(fetchMock, { status: "resolved", size: 10 });
  assert.equal(resolved.status, "resolved");
  const failed = await runPublish(fetchMock, { size: 10, token: async () => { throw new Error("No permission"); } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.active, null);
  assert.equal(calls, 0);
});

test("does not contact YouTube when the video fails Shorts validation", async () => {
  let calls = 0;
  const result = await runPublish(async () => { calls++; }, {
    size: 10, validate: async () => { throw new Error("Not a Short"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.active, null);
  assert.equal(calls, 0);
});

test("YouTube route validates requests, requires access, and blocks duplicates", async () => {
  const jobs = [];
  const calls = [];
  let deny = true;
  let duplicate = false;
  const readInput = await load("src/lib/auth-input.ts", {});
  const route = await load("app/api/library/publish/youtube/route.ts", {
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
      if (sql.includes("UPDATE youtube_publications")) return [{ affectedRows: 0 }];
      return [[]];
    } } },
    "@/src/lib/youtube": {
      youtubeConfig: () => ({}),
      savedYouTubeChannels: async () => [{ id: "channel-1", title: "Our Channel" }],
    },
    "@/src/lib/youtube-publish": { publishYouTubeVideo: async (input) => calls.push(input) },
    "@/src/lib/videos": { validVideoId: (id) => /^\d+$/.test(id) },
  });
  const body = {
    id: "ec48471f-46a1-44db-ac93-851c5ab316de", videoId: "1",
    filename: "clip.mp4", channelId: "channel-1", title: "Title",
    description: "Description", privacy: "public", madeForKids: false, syntheticMedia: false, certify: true,
  };
  const request = (method, input) => new Request("https://example.test/api/library/publish/youtube", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await route.POST(request("POST", body))).status, 401);
  assert.equal((await route.PATCH(request("PATCH", { id: body.id, confirm: true }))).status, 401);
  assert.equal((await route.GET(new Request("https://example.test/?video=1"))).status, 401);
  deny = false;
  const invalid = [
    { channelId: "other" }, { filename: "old.mp4" }, { privacy: "friends" },
    { title: "a".repeat(101) }, { title: "<bad>" }, { description: "é".repeat(2501) },
    { madeForKids: null }, { syntheticMedia: null }, { certify: false },
  ];
  for (const change of invalid) {
    const response = await route.POST(request("POST", { ...body, ...change }));
    assert.ok(response.status === 400 || response.status === 409, JSON.stringify(change));
  }
  assert.equal(jobs.length, 0);
  duplicate = true;
  assert.equal((await route.POST(request("POST", body))).status, 409);
  assert.equal(jobs.length, 0);
  duplicate = false;
  const valid = { ...body, title: "a".repeat(100), description: "é".repeat(2500), privacy: "unlisted" };
  assert.equal((await route.POST(request("POST", valid))).status, 202);
  assert.equal(jobs.length, 1);
  await jobs[0]();
  assert.equal(calls[0].privacy, "unlisted");
  assert.equal(calls[0].description, valid.description);
  assert.equal((await route.PATCH(request("PATCH", { id: body.id, confirm: true }))).status, 409);
});
