import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);

test("proxy excludes only the streaming upload endpoint", async () => {
  const source = await readFile(fileURLToPath(new URL("../proxy.ts", import.meta.url)), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => name.startsWith("@/") ? {} : require(name);
  new Function("require", "exports", compiled)(mockRequire, exports);
  const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server");
  const matches = (url) => unstable_doesMiddlewareMatch({ config: exports.config, nextConfig: {}, url });
  assert.equal(matches("/api/upload"), false);
  assert.equal(matches("/api/upload/"), false);
  assert.equal(matches("/api/upload/check"), true);
  assert.equal(matches("/api/upload-other"), true);
  assert.equal(matches("/api/library"), true);
  assert.equal(matches("/library"), true);
});

test("proxy permits only the signed TikTok media route without a session", async () => {
  const source = await readFile(fileURLToPath(new URL("../proxy.ts", import.meta.url)), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const mockRequire = (name) => name === "@/src/lib/access"
    ? { requireApiAccess: async () => new Response(null, { status: 401 }) }
    : name === "@/src/lib/auth" ? {} : require(name);
  new Function("require", "exports", compiled)(mockRequire, exports);
  const { NextRequest } = require("next/server");
  const valid = await exports.proxy(new NextRequest("https://example.test/api/tiktok-media/ec48471f-46a1-44db-ac93-851c5ab316de"));
  assert.equal(valid.headers.get("x-middleware-next"), "1");
  const invalid = await exports.proxy(new NextRequest("https://example.test/api/tiktok-media/other"));
  assert.equal(invalid.status, 401);
  const other = await exports.proxy(new NextRequest("https://example.test/api/library"));
  assert.equal(other.status, 401);
});
