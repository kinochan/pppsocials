import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { NextRequest } = require("next/server");
const env = {
  YOUTUBE_CONNECTION_ENABLED: "true",
  APP_URL: "https://example.test",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  INSTAGRAM_TOKEN_KEY: "12".repeat(32),
};
const scope = "https://www.googleapis.com/auth/youtube.readonly";

async function load(file, dependencies, fetchMock, variables = env) {
  const source = await readFile(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => name === "@/src/lib/access" ? { requireApiAccess: async () => null } :
    name in dependencies ? dependencies[name] : require(name);
  new Function("require", "exports", "process", "fetch", compiled)(
    mockRequire, exports, { env: variables }, fetchMock
  );
  return exports;
}

async function setup(fetchMock, execute = async () => {}) {
  const crypto = await load("src/lib/meta-crypto.ts", {}, fetchMock);
  const lib = await load("src/lib/youtube.ts", {
    "@/src/lib/db": { db: { execute } },
    "@/src/lib/meta-crypto": crypto,
  }, fetchMock);
  const dependencies = { "@/src/lib/youtube": lib };
  const connect = await load("app/api/youtube/connect/route.ts", dependencies, fetchMock);
  const callback = await load("app/api/youtube/callback/route.ts", dependencies, fetchMock);
  const status = await load("app/api/youtube/status/route.ts", {
    ...dependencies, "next/server": { ...require("next/server"), connection: async () => {} },
  }, fetchMock);
  return { lib, connect, callback, status, crypto };
}

async function start(connect) {
  return connect.POST(new Request("https://example.test/api/youtube/connect", {
    method: "POST", headers: { origin: "https://example.test" },
  }));
}

function callbackRequest(state, cookie, extra = "code=test-code") {
  return new NextRequest(`https://example.test/api/youtube/callback?state=${state}&${extra}`, {
    headers: { cookie: `__Host-youtube-oauth=${cookie}` },
  });
}

test("connects multiple channels separately and stores refresh tokens encrypted", async () => {
  const saved = new Map();
  const requests = [];
  const execute = async (sql, params) => {
    if (sql.startsWith("SELECT")) {
      return [[...saved.entries()].map(([id, value]) => ({ id, title: value.title }))];
    }
    saved.set(params[0], { title: params[1], encrypted: params[2] });
  };
  const fetchMock = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (requests.length % 2 === 1) {
      const code = options.body.get("code");
      return Response.json({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, scope });
    }
    const code = options.headers.Authorization.replace("Bearer access-", "");
    return Response.json({ items: [{ id: `channel-${code}`, snippet: { title: `Channel ${code}` } }] });
  };
  const { connect, callback, status, crypto } = await setup(fetchMock, execute);

  for (const code of ["first", "second", "first"]) {
    const response = await start(connect);
    const login = new URL(response.headers.get("location"));
    const state = login.searchParams.get("state");
    const cookie = response.cookies.get("__Host-youtube-oauth").value;
    const verifier = cookie.split(".")[1];
    assert.equal(login.searchParams.get("scope"), scope);
    assert.equal(login.searchParams.get("access_type"), "offline");
    assert.equal(login.searchParams.get("code_challenge_method"), "S256");
    assert.equal(login.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
    assert.match(response.headers.get("set-cookie"), /HttpOnly.*Secure|Secure.*HttpOnly/i);

    const result = await callback.GET(callbackRequest(state, cookie, `code=${code}`));
    assert.equal(new URL(result.headers.get("location")).searchParams.get("youtube"), "connected");
    assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(requests.at(-2).options.body.get("code_verifier"), verifier);
    assert.equal(requests.at(-2).options.body.get("redirect_uri"), "https://example.test/api/youtube/callback");
    assert.equal(requests.at(-1).options.headers.Authorization, `Bearer access-${code}`);
  }
  assert.equal(saved.size, 2);
  assert.ok(!saved.get("channel-first").encrypted.includes("refresh-first"));
  assert.equal(crypto.decryptMetaSecret(saved.get("channel-first").encrypted, Buffer.from(env.INSTAGRAM_TOKEN_KEY, "hex")), "refresh-first");
  const statusResponse = await status.GET();
  assert.deepEqual(await statusResponse.json(), {
    enabled: true,
    channels: [{ id: "channel-first", title: "Channel first" }, { id: "channel-second", title: "Channel second" }],
  });
  assert.equal(statusResponse.headers.get("cache-control"), "no-store");
});

test("rejects cross-origin starts and invalid OAuth state before contacting Google", async () => {
  let requests = 0;
  const { connect, callback } = await setup(async () => { requests++; });
  const denied = await connect.POST(new Request("https://example.test/api/youtube/connect", {
    method: "POST", headers: { origin: "https://other.test" },
  }));
  assert.equal(denied.status, 403);
  const response = await callback.GET(callbackRequest("a".repeat(64), `${"b".repeat(64)}.${"c".repeat(43)}`));
  assert.equal(new URL(response.headers.get("location")).searchParams.get("youtube"), "invalid-state");
  assert.equal(requests, 0);
});

test("does not save when Google omits offline access, permission, or a single channel", async () => {
  for (const [token, channel] of [
    [{ access_token: "access", scope }, null],
    [{ access_token: "access", refresh_token: "refresh", scope: "other" }, null],
    [{ access_token: "access", refresh_token: "refresh", scope }, { items: [] }],
    [{ access_token: "access", refresh_token: "refresh", scope }, { items: [
      { id: "one", snippet: { title: "One" } },
      { id: "two", snippet: { title: "Two" } },
    ] }],
  ]) {
    let calls = 0;
    let writes = 0;
    const { connect, callback } = await setup(
      async () => Response.json(++calls === 1 ? token : channel),
      async () => { writes++; }
    );
    const startResponse = await start(connect);
    const state = new URL(startResponse.headers.get("location")).searchParams.get("state");
    const cookie = startResponse.cookies.get("__Host-youtube-oauth").value;
    const result = await callback.GET(callbackRequest(state, cookie));
    assert.equal(new URL(result.headers.get("location")).searchParams.get("youtube"), "failed");
    assert.equal(writes, 0);
  }
});
