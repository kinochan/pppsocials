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
  FACEBOOK_CONNECTION_ENABLED: "true",
  APP_URL: "https://example.test",
  META_APP_ID: "app-id",
  META_APP_SECRET: "app-secret",
  FACEBOOK_CONFIG_ID: "configuration-id",
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
  const crypto = await load(path.join("src", "lib", "meta-crypto.ts"), {}, fetchMock);
  const lib = await load(path.join("src", "lib", "facebook.ts"), {
    "@/src/lib/db": { db: { execute } },
    "@/src/lib/meta-crypto": crypto,
  }, fetchMock);
  const dependencies = { "@/src/lib/facebook": lib };
  const connect = await load(path.join("app", "api", "facebook", "connect", "route.ts"), dependencies, fetchMock);
  const callback = await load(path.join("app", "api", "facebook", "callback", "route.ts"), dependencies, fetchMock);
  return { lib, connect, callback };
}

test("connects eligible Pages and encrypts their tokens", async () => {
  const calls = [];
  let encrypted;
  const execute = async (sql, params) => {
    if (sql.startsWith("SELECT")) return [[{ encrypted_pages: encrypted }]];
    encrypted = params[0];
  };
  const fetchMock = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === 1) return Response.json({ access_token: "short-token" });
    if (calls.length === 2) return Response.json({ access_token: "long-token" });
    return Response.json({ data: [
      { id: "1", name: "Eligible", access_token: "page-secret", tasks: ["CREATE_CONTENT"] },
      { id: "2", name: "Read only", access_token: "other-secret", tasks: ["ANALYZE"] },
    ] });
  };
  const { lib, connect, callback } = await setup(fetchMock, execute);
  const start = await connect.POST(new Request("https://example.test/api/facebook/connect", {
    method: "POST", headers: { origin: "https://example.test" },
  }));
  const login = new URL(start.headers.get("location"));
  const state = login.searchParams.get("state");
  assert.equal(login.searchParams.get("response_type"), "code");
  assert.equal(login.searchParams.get("override_default_response_type"), "true");
  assert.ok(state);
  const response = await callback.GET(new NextRequest(
    `https://example.test/api/facebook/callback?state=${state}&code=auth-code`,
    { headers: { cookie: `__Host-facebook-oauth-state=${state}` } }
  ));
  assert.equal(new URL(response.headers.get("location")).searchParams.get("facebook"), "connected");
  assert.equal(calls[0].url.searchParams.get("redirect_uri"), "https://example.test/api/facebook/callback");
  assert.equal(calls[2].options.headers.Authorization, "Bearer long-token");
  assert.ok(!encrypted.includes("page-secret"));
  assert.deepEqual(await lib.savedFacebookPages(Buffer.from(env.INSTAGRAM_TOKEN_KEY, "hex")), [
    { id: "1", name: "Eligible", accessToken: "page-secret" },
  ]);
});

test("invalid state and missing Page access never replace the connection", async () => {
  let requests = 0;
  let writes = 0;
  const { callback } = await setup(async () => {
    requests++;
    return Response.json(requests < 3 ? { access_token: "token" } : { data: [] });
  }, async () => { writes++; });
  const bad = await callback.GET(new NextRequest(
    `https://example.test/api/facebook/callback?state=${"a".repeat(64)}&code=code`,
    { headers: { cookie: `__Host-facebook-oauth-state=${"b".repeat(64)}` } }
  ));
  assert.equal(new URL(bad.headers.get("location")).searchParams.get("facebook"), "invalid-state");
  assert.equal(requests, 0);
  const state = "a".repeat(64);
  const noPages = await callback.GET(new NextRequest(
    `https://example.test/api/facebook/callback?state=${state}&code=code`,
    { headers: { cookie: `__Host-facebook-oauth-state=${state}` } }
  ));
  assert.equal(new URL(noPages.headers.get("location")).searchParams.get("facebook"), "failed");
  assert.equal(writes, 0);
});
