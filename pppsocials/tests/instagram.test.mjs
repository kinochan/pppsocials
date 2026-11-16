import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
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
  INSTAGRAM_CONNECTION_ENABLED: "true",
  APP_URL: "https://example.test",
  META_APP_ID: "app-id",
  META_APP_SECRET: "app-secret",
  META_CONFIG_ID: "configuration-id",
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
  const lib = await load(path.join("src", "lib", "instagram.ts"), { "@/src/lib/db": { db: { execute } } }, fetchMock);
  const dependencies = { "@/src/lib/instagram": lib };
  const connect = await load(path.join("app", "api", "instagram", "connect", "route.ts"), dependencies, fetchMock);
  const callback = await load(path.join("app", "api", "instagram", "callback", "route.ts"), dependencies, fetchMock);
  return { lib, connect, callback };
}

async function start(connect) {
  return connect.POST(new Request("https://example.test/api/instagram/connect", {
    method: "POST",
    headers: { origin: "https://example.test" },
  }));
}

function callbackRequest(state, cookie, extra = "code=test-code") {
  return new NextRequest(`https://example.test/api/instagram/callback?state=${state}&${extra}`, {
    headers: { cookie: `__Host-instagram-oauth-state=${cookie}` },
  });
}

test("connects accounts across pages and saves the token encrypted", async () => {
  const calls = [];
  const saved = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === 1) return Response.json({ access_token: "private-token" });
    if (calls.length === 2) return Response.json({ client_business_id: "business-1" });
    if (calls.length === 3) return Response.json({
      data: [{ id: "1", username: "first" }],
      paging: { next: "https://ignored.example", cursors: { after: "cursor-1" } },
    });
    return Response.json({ data: [{ id: "2", username: "second" }] });
  };
  const { connect, callback } = await setup(fetchMock, async (...args) => saved.push(args));
  const startResponse = await start(connect);
  const loginUrl = new URL(startResponse.headers.get("location"));
  const state = loginUrl.searchParams.get("state");
  assert.equal(startResponse.status, 303);
  assert.equal(loginUrl.searchParams.get("redirect_uri"), "https://example.test/api/instagram/callback");
  assert.match(startResponse.headers.get("set-cookie"), /;\s*HttpOnly/i);
  assert.match(startResponse.headers.get("set-cookie"), /;\s*Secure/i);
  assert.match(startResponse.headers.get("set-cookie"), /;\s*SameSite=lax/i);
  assert.ok(state);

  const response = await callback.GET(callbackRequest(state, state));
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("instagram"), "connected");
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(calls[3].url.searchParams.get("after"), "cursor-1");
  assert.equal(calls[2].options.headers.Authorization, "Bearer private-token");
  assert.equal(saved.length, 1);
  const [business, config, accounts, encrypted] = saved[0][1];
  assert.equal(business, "business-1");
  assert.equal(config, "configuration-id");
  assert.deepEqual(JSON.parse(accounts), [{ id: "1", username: "first" }, { id: "2", username: "second" }]);
  assert.ok(!encrypted.includes("private-token"));
  const [iv, tag, ciphertext] = encrypted.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(env.INSTAGRAM_TOKEN_KEY, "hex"), iv);
  decipher.setAuthTag(tag);
  assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(), "private-token");
});

test("rejects invalid OAuth state before contacting Meta", async () => {
  let called = false;
  const { callback } = await setup(async () => { called = true; });
  const response = await callback.GET(callbackRequest("a".repeat(64), "b".repeat(64)));
  assert.equal(new URL(response.headers.get("location")).searchParams.get("instagram"), "invalid-state");
  assert.equal(called, false);
});

test("does not replace the saved connection when Meta returns no accounts", async () => {
  let count = 0;
  let saved = false;
  const { callback } = await setup(async () => {
    count++;
    return Response.json(count === 1 ? { access_token: "token" } :
      count === 2 ? { client_business_id: "business" } : { data: [] });
  }, async () => { saved = true; });
  const state = "a".repeat(64);
  const response = await callback.GET(callbackRequest(state, state));
  assert.equal(new URL(response.headers.get("location")).searchParams.get("instagram"), "failed");
  assert.equal(saved, false);
});

test("reports a database failure without exposing the token", async () => {
  let count = 0;
  const { callback } = await setup(async () => {
    count++;
    return Response.json(count === 1 ? { access_token: "private-token" } :
      count === 2 ? { client_business_id: "business" } : { data: [{ id: "1", username: "test" }] });
  }, async () => { throw new Error("database failure"); });
  const state = "a".repeat(64);
  const response = await callback.GET(callbackRequest(state, state));
  assert.equal(new URL(response.headers.get("location")).searchParams.get("instagram"), "failed");
  assert.ok(!response.headers.get("location").includes("private-token"));
});

test("requires explicit enablement and a same-origin connection request", async () => {
  const lib = await load(path.join("src", "lib", "instagram.ts"), { "@/src/lib/db": { db: {} } }, fetch, {});
  assert.equal(lib.instagramConfig(), null);
  const { connect } = await setup(fetch);
  const response = await connect.POST(new Request("https://example.test/api/instagram/connect", {
    method: "POST", headers: { origin: "https://attacker.test" },
  }));
  assert.equal(response.status, 403);
});
