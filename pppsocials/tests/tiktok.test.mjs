import assert from "node:assert/strict";
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
  TIKTOK_CONNECTION_ENABLED: "true",
  APP_URL: "https://example.test",
  TIKTOK_CLIENT_KEY: "client-key",
  TIKTOK_CLIENT_SECRET: "client-secret",
  INSTAGRAM_TOKEN_KEY: "12".repeat(32),
};

async function load(file, dependencies, fetchMock, variables = env) {
  const source = await readFile(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => name in dependencies ? dependencies[name] : require(name);
  new Function("require", "exports", "process", "fetch", compiled)(
    mockRequire, exports, { env: variables }, fetchMock
  );
  return exports;
}

async function setup(fetchMock, execute = async () => {}) {
  const crypto = await load("src/lib/meta-crypto.ts", {}, fetchMock);
  const lib = await load("src/lib/tiktok.ts", {
    "@/src/lib/db": { db: { execute } },
    "@/src/lib/meta-crypto": crypto,
  }, fetchMock);
  const dependencies = { "@/src/lib/tiktok": lib };
  const connect = await load("app/api/tiktok/connect/route.ts", dependencies, fetchMock);
  const callback = await load("app/api/tiktok/callback/route.ts", dependencies, fetchMock);
  const status = await load("app/api/tiktok/status/route.ts", {
    ...dependencies, "next/server": { ...require("next/server"), connection: async () => {} },
  }, fetchMock);
  return { lib, connect, callback, status, crypto };
}

function token(id) {
  return {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    open_id: id,
    scope: "user.info.basic",
    expires_in: 7200,
    refresh_expires_in: 15552000,
  };
}

async function start(connect) {
  return connect.POST(new Request("https://example.test/api/tiktok/connect", {
    method: "POST", headers: { origin: "https://example.test" },
  }));
}

function callbackRequest(state, cookie, extra = "code=test-code") {
  return new NextRequest(`https://example.test/api/tiktok/callback?state=${state}&${extra}`, {
    headers: { cookie: `__Host-tiktok-oauth-state=${cookie}` },
  });
}

test("connects multiple accounts and encrypts their tokens and expiry times", async () => {
  const saved = new Map();
  const requests = [];
  const execute = async (sql, params) => {
    if (sql.startsWith("SELECT")) {
      return [[...saved.entries()].map(([id, value]) => ({ id, displayName: value.displayName }))];
    }
    saved.set(params[0], { displayName: params[1], encrypted: params[2] });
  };
  const fetchMock = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (requests.length % 2 === 1) return Response.json(token(options.body.get("code")));
    const id = options.headers.Authorization.replace("Bearer access-", "");
    return Response.json({ data: { user: { open_id: id, display_name: `Account ${id}` } }, error: { code: "ok" } });
  };
  const { connect, callback, status, crypto } = await setup(fetchMock, execute);

  for (const id of ["first", "second", "first"]) {
    const response = await start(connect);
    const login = new URL(response.headers.get("location"));
    const state = login.searchParams.get("state");
    assert.equal(login.origin, "https://www.tiktok.com");
    assert.equal(login.searchParams.get("scope"), "user.info.basic");
    assert.equal(login.searchParams.get("disable_auto_auth"), "1");
    assert.match(response.headers.get("set-cookie"), /HttpOnly.*Secure|Secure.*HttpOnly/i);

    const result = await callback.GET(callbackRequest(state, state, `code=${id}`));
    assert.equal(new URL(result.headers.get("location")).searchParams.get("tiktok"), "connected");
    assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(requests.at(-2).options.body.get("redirect_uri"), "https://example.test/api/tiktok/callback");
    assert.equal(requests.at(-2).options.body.get("client_key"), env.TIKTOK_CLIENT_KEY);
    assert.equal(requests.at(-1).url.searchParams.get("fields"), "open_id,display_name");
    assert.equal(requests.at(-1).options.headers.Authorization, `Bearer access-${id}`);
  }
  assert.equal(saved.size, 2);
  const encrypted = saved.get("first").encrypted;
  assert.ok(!encrypted.includes("refresh-first"));
  const secrets = JSON.parse(crypto.decryptMetaSecret(encrypted, Buffer.from(env.INSTAGRAM_TOKEN_KEY, "hex")));
  assert.equal(secrets.accessToken, "access-first");
  assert.equal(secrets.refreshToken, "refresh-first");
  assert.equal(secrets.scope, "user.info.basic");
  assert.ok(secrets.refreshExpiresAt > secrets.accessExpiresAt && secrets.accessExpiresAt > Date.now());
  const statusResponse = await status.GET();
  assert.deepEqual(await statusResponse.json(), {
    enabled: true,
    accounts: [{ id: "first", displayName: "Account first" }, { id: "second", displayName: "Account second" }],
  });
  assert.equal(statusResponse.headers.get("cache-control"), "no-store");
});

test("rejects cross-origin starts and invalid OAuth state before contacting TikTok", async () => {
  let requests = 0;
  const { connect, callback } = await setup(async () => { requests++; });
  const denied = await connect.POST(new Request("https://example.test/api/tiktok/connect", {
    method: "POST", headers: { origin: "https://other.test" },
  }));
  assert.equal(denied.status, 403);
  const response = await callback.GET(callbackRequest("a".repeat(64), "b".repeat(64)));
  assert.equal(new URL(response.headers.get("location")).searchParams.get("tiktok"), "invalid-state");
  assert.equal(requests, 0);
});

test("does not save missing permissions, invalid tokens, or mismatched accounts", async () => {
  for (const [tokenResponse, account] of [
    [{ ...token("first"), scope: "other" }, null],
    [{ ...token("first"), refresh_token: "" }, null],
    [{ ...token("first"), refresh_expires_in: 0 }, null],
    [token("first"), { data: { user: { open_id: "other", display_name: "Other" } }, error: { code: "ok" } }],
    [token("first"), { data: { user: { open_id: "first", display_name: "Account" } }, error: { code: "access_token_invalid" } }],
  ]) {
    let calls = 0;
    let writes = 0;
    const { connect, callback } = await setup(
      async () => Response.json(++calls === 1 ? tokenResponse : account),
      async () => { writes++; }
    );
    const startResponse = await start(connect);
    const state = new URL(startResponse.headers.get("location")).searchParams.get("state");
    const result = await callback.GET(callbackRequest(state, state));
    assert.equal(new URL(result.headers.get("location")).searchParams.get("tiktok"), "failed");
    assert.equal(writes, 0);
  }
});

test("reports provider and database failures without exposing tokens", async () => {
  for (const failure of ["provider", "database"]) {
    let calls = 0;
    const { lib } = await setup(async () => {
      if (++calls === 1) return Response.json(token("first"));
      if (failure === "provider") return new Response("private token", { status: 403 });
      return Response.json({ data: { user: { open_id: "first", display_name: "First" } }, error: { code: "ok" } });
    }, async () => { throw new Error("private token"); });
    const expected = failure === "provider"
      ? "TikTok account lookup request failed with HTTP 403."
      : "Could not save the TikTok connection in the database.";
    await assert.rejects(lib.connectTikTok("code", lib.tiktokConfig()), (error) => error.message === expected);
  }
});
