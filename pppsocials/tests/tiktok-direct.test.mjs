import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load(file, dependencies) {
  const source = await readFile(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((name) => name in dependencies ? dependencies[name] : require(name), exports);
  return exports;
}

const id = "ec48471f-46a1-44db-ac93-851c5ab316de";
const secret = "1".repeat(64);
const creator = {
  creator_nickname: "Creator", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
  comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 180,
};
const input = {
  id, accountId: "account", secret, title: "Caption", privacy: "SELF_ONLY",
  comment: false, duet: false, stitch: false, brandContent: false, brandOrganic: true, aiGenerated: false,
};

async function direct(execute, request, probe = async () => ({ streams: [{}], format: { duration: "180" } })) {
  class TikTokConnectionError extends Error {}
  class TikTokUploadError extends Error {}
  class VideoProbeError extends Error {}
  return load("src/lib/tiktok-direct.ts", {
    "@/src/lib/db": { db: { execute } },
    "@/src/lib/tiktok": { tiktokConfig: () => ({ directEnabled: true, baseUrl: "https://example.test" }),
      tiktokUploadToken: async () => "access-token", tiktokPublishScope: "video.publish", TikTokConnectionError },
    "@/src/lib/tiktok-upload": { tiktokPublishRequest: request, TikTokUploadError },
    "@/src/lib/video-probe": { probeVideo: probe, VideoProbeError },
    "@/src/lib/videos": { uploadFilePath: (filepath) => filepath },
  });
}

test("validates current creator settings and duration against the account limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiktok-direct-"));
  const filepath = path.join(directory, "video.mp4");
  await writeFile(filepath, Buffer.alloc(20));
  try {
    const lib = await direct(async () => {}, async () => creator);
    const settings = await lib.creatorInfo("account");
    assert.deepEqual(settings.privacy, ["SELF_ONLY", "PUBLIC_TO_EVERYONE"]);
    assert.equal(settings.duetDisabled, true);
    const file = await lib.inspectDirectVideo(filepath, 180);
    assert.equal(file.size, "20");
    await assert.rejects(() => lib.inspectDirectVideo(filepath, 179), /179 seconds/);
    const invalid = await direct(async () => {}, async () => ({ ...creator, privacy_level_options: ["UNKNOWN"] }));
    await assert.rejects(() => invalid.creatorInfo("account"), /incomplete creator settings/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("direct post uses a temporary pull URL and preserves uncertain initialization", async () => {
  const writes = [];
  const calls = [];
  const execute = async (sql, params) => { writes.push({ sql, params }); return [{ affectedRows: 1 }]; };
  const lib = await direct(execute, async (endpoint, token, body) => {
    calls.push({ endpoint, token, body });
    return { publish_id: "v_pub_url~v2.123" };
  });
  await lib.startTikTokDirectPost(input);
  assert.equal(calls[0].endpoint, "video/init");
  assert.equal(calls[0].body.post_info.privacy_level, "SELF_ONLY");
  assert.equal(calls[0].body.post_info.brand_organic_toggle, true);
  assert.equal(calls[0].body.source_info.source, "PULL_FROM_URL");
  const mediaUrl = new URL(calls[0].body.source_info.video_url);
  assert.equal(mediaUrl.pathname, `/api/tiktok-media/${id}`);
  assert.equal(mediaUrl.searchParams.get("token"), secret);
  assert.ok(writes.some((write) => write.sql.includes("status = 'processing'")));
  const failed = [];
  const uncertain = await direct(async (sql, params) => { failed.push({ sql, params }); return [{ affectedRows: 1 }]; },
    async () => { throw new Error("network interrupted"); });
  await uncertain.startTikTokDirectPost(input);
  assert.equal(failed.at(-1).params[0], "unknown");
  assert.equal(failed.at(-1).params[1], 1);
});

test("processing status checks preserve the stale-resolution clock", async () => {
  let update;
  const lib = await direct(async (sql, params) => {
    if (sql.startsWith("SELECT")) return [[{ account_id: "account", publish_id: "post-id" }]];
    update = { sql, params };
    return [{ affectedRows: 1 }];
  }, async () => ({ status: "PROCESSING_DOWNLOAD" }));
  await lib.checkTikTokDirectPost(id);
  assert.match(update.sql, /updated_at = IF\(status = \?, updated_at, UTC_TIMESTAMP\(\)\)/);
  assert.deepEqual(update.params.slice(0, 3), ["processing", "processing", 1]);
});

test("temporary media endpoint requires a matching live token and serves byte ranges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiktok-media-"));
  const filepath = path.join(directory, "video.mp4");
  await writeFile(filepath, "0123456789");
  const file = await require("node:fs/promises").open(filepath, "r");
  const stats = await file.stat({ bigint: true });
  await file.close();
  const row = {
    filepath, token_hash: createHash("sha256").update(secret, "ascii").digest("hex"),
    file_device: stats.dev.toString(), file_inode: stats.ino.toString(), file_size: stats.size.toString(),
    file_mtime_ns: stats.mtimeNs.toString(),
  };
  let live = true;
  const route = await load("app/api/tiktok-media/[id]/route.ts", {
    "@/src/lib/db": { db: { execute: async (sql) => {
      assert.match(sql, /token_expires_at > UTC_TIMESTAMP/);
      assert.match(sql, /p.active = 1/);
      return [live ? [row] : []];
    } } },
    "@/src/lib/tiktok": { tiktokConfig: () => ({ directEnabled: true }) },
    "@/src/lib/videos": { uploadFilePath: (value) => value },
  });
  const context = { params: Promise.resolve({ id }) };
  const request = (token, headers) => new Request(`https://example.test/api/tiktok-media/${id}?token=${token}`, { headers });
  try {
    assert.equal((await route.GET(request("2".repeat(64)), context)).status, 404);
    const response = await route.GET(request(secret, { range: "bytes=2-5" }), context);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await response.text(), "2345");
    const head = await route.HEAD(new Request(`https://example.test/api/tiktok-media/${id}?token=${secret}`, { method: "HEAD" }), context);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    assert.equal((await route.GET(request(secret, { range: "bytes=20-30" }), context)).status, 416);
    live = false;
    assert.equal((await route.GET(request(secret), context)).status, 404);
    live = true;
    await writeFile(filepath, "changed");
    assert.equal((await route.GET(request(secret), context)).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("direct post route requires explicit choices, current permissions and consent", async () => {
  let deny = true;
  const jobs = [];
  const readInput = await load("src/lib/auth-input.ts", {});
  class TikTokDirectError extends Error {}
  class TikTokUploadError extends Error {}
  class TikTokConnectionError extends Error {}
  class VideoProbeError extends Error {}
  const route = await load("app/api/library/publish/tiktok-direct/route.ts", {
    "next/server": { after: (callback) => jobs.push(callback) },
    "@/src/lib/access": { requireApiAccess: async () => deny ? new Response(null, { status: 401 }) : null },
    "@/src/lib/auth-input": readInput,
    "@/src/lib/db": { db: { execute: async (sql) => sql.startsWith("SELECT filename")
      ? [[{ filename: "clip.mp4", filepath: "uploads/clip.mp4" }]] : [{ affectedRows: 1 }] } },
    "@/src/lib/tiktok": { tiktokConfig: () => ({ directEnabled: true }),
      savedTikTokAccounts: async () => [{ id: "account", displayName: "Account" }], TikTokConnectionError },
    "@/src/lib/tiktok-direct": {
      TikTokDirectError, isTikTokPrivacy: (value) => ["SELF_ONLY", "PUBLIC_TO_EVERYONE"].includes(value),
      creatorInfo: async () => ({ nickname: "Creator", privacy: ["SELF_ONLY"], commentDisabled: false,
        duetDisabled: true, stitchDisabled: false, maxDuration: 180 }),
      inspectDirectVideo: async () => ({ device: "1", inode: "2", size: "20", mtimeNs: "3" }),
      startTikTokDirectPost: async () => {}, checkTikTokDirectPost: async () => {},
    },
    "@/src/lib/tiktok-upload": { TikTokUploadError },
    "@/src/lib/video-probe": { VideoProbeError },
    "@/src/lib/videos": { validVideoId: (value) => /^\d+$/.test(value) },
  });
  const body = { id, videoId: "1", filename: "clip.mp4", accountId: "account", title: "Hi",
    privacy: "SELF_ONLY", comment: false, duet: false, stitch: false, disclosure: false,
    brandContent: false, brandOrganic: false, aiGenerated: false, confirm: true };
  const request = (value) => new Request("https://example.test/api/library/publish/tiktok-direct", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  assert.equal((await route.POST(request(body))).status, 401);
  deny = false;
  for (const change of [{ confirm: false }, { privacy: "" }, { title: "x".repeat(2201) },
    { disclosure: true }, { brandContent: true, disclosure: true }]) {
    assert.equal((await route.POST(request({ ...body, ...change }))).status, 400);
  }
  assert.equal((await route.POST(request({ ...body, duet: true }))).status, 409);
  assert.equal((await route.POST(request({ ...body, privacy: "PUBLIC_TO_EVERYONE" }))).status, 409);
  assert.equal(jobs.length, 0);
  assert.equal((await route.POST(request(body))).status, 202);
  assert.equal(jobs.length, 1);
});
