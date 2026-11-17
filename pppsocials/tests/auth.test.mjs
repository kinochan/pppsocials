import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://localhost:3000";
const setupSecret = "41".repeat(32);
const env = {
  NODE_ENV: "development",
  APP_URL: origin,
  BETTER_AUTH_SECRET: "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef",
  AUTH_SETUP_SECRET: setupSecret,
};

async function load(file, dependencies, fetchMock = globalThis.fetch) {
  const source = await readFile(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const mockRequire = (name) => name in dependencies ? dependencies[name] : require(name);
  new Function("require", "exports", "process", "fetch", compiled)(mockRequire, exports, { env }, fetchMock);
  return exports;
}

function request(pathname, body, cookie, requestOrigin = origin) {
  return new Request(`${origin}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", origin: requestOrigin }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("sign-out sends the JSON request expected by the authentication endpoint", async () => {
  const calls = [];
  const navigation = [];
  const component = await load("app/components/SignOut.tsx", {
    react: { useState: () => ["", () => {}] },
    "next/navigation": { useRouter: () => ({
      replace: (url) => navigation.push(url),
      refresh: () => navigation.push("refresh"),
    }) },
  }, async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 200 });
  });
  const element = component.default();
  await element.props.children[0].props.onClick();
  assert.equal(calls[0].url, "/api/auth/sign-out");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(navigation, ["/login", "refresh"]);
});

test("bootstrap, login, roles, reset, disabling and logout enforce access", async (t) => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
    t.skip("This test requires Node's built-in SQLite support.");
    return;
  }
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  let releaseLock;
  let locked = false;
  const connection = {
    async query(sql) {
      if (sql.includes("GET_LOCK")) {
        while (locked) await new Promise((resolve) => { releaseLock = resolve; });
        locked = true;
        return [[{ acquired: 1 }]];
      }
      if (sql.includes("RELEASE_LOCK")) {
        locked = false;
        releaseLock?.();
        return [[{ released: 1 }]];
      }
      if (sql.includes("COUNT")) return [[database.prepare("SELECT COUNT(*) AS count FROM auth_user").get()]];
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
    destroy() {},
  };
  const authModule = await load("src/lib/auth.ts", { "mysql2/promise": { createPool: () => database } });
  const auth = authModule.getAuth();
  const { getMigrations } = require("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  const access = await load("src/lib/access.ts", { "@/src/lib/auth": authModule });
  const input = await load("src/lib/auth-input.ts", {});
  const lock = await load("src/lib/auth-lock.ts", { "@/src/lib/db": { db: { getConnection: async () => connection } } });
  const dependencies = {
    "@/src/lib/auth": authModule,
    "@/src/lib/access": access,
    "@/src/lib/auth-input": input,
    "@/src/lib/auth-lock": lock,
    "@/src/lib/db": { db: { getConnection: async () => connection, execute: async () => [[]] } },
    "next/server": { ...require("next/server"), connection: async () => {} },
  };
  const setup = await load("app/api/setup/route.ts", dependencies);
  const authRoute = await load("app/api/auth/[...all]/route.ts", dependencies);
  const users = await load("app/api/users/route.ts", dependencies);
  const library = await load("app/api/library/route.ts", dependencies);
  const social = await load("app/api/youtube/status/route.ts", {
    ...dependencies, "@/src/lib/youtube": { youtubeConfig: () => null },
  });
  const media = await load("app/api/library/[id]/route.ts", {
    ...dependencies, "@/src/lib/videos": {},
  });

  const credentials = { email: "admin@example.test", password: "correct horse battery staple" };
  assert.equal((await setup.POST(request("/api/setup", { ...credentials, secret: setupSecret }, null, "http://attacker.test"))).status, 403);
  assert.equal((await setup.POST(request("/api/setup", { ...credentials, secret: "incorrect" }))).status, 403);
  const initial = await Promise.all([
    setup.POST(request("/api/setup", { ...credentials, secret: setupSecret })),
    setup.POST(request("/api/setup", { ...credentials, secret: setupSecret })),
  ]);
  assert.deepEqual(initial.map((response) => response.status).sort(), [200, 403]);
  assert.equal((await authRoute.POST(request("/api/auth/sign-up/email", credentials))).status, 404);
  assert.equal((await library.GET(request("/api/library"))).status, 401);
  assert.equal((await media.GET(request("/api/library/1"), { params: Promise.resolve({ id: "1" }) })).status, 401);
  assert.equal((await authRoute.POST(request("/api/auth/sign-in/email", credentials, null, "http://attacker.test"))).status, 403);

  async function signIn(email, password) {
    const response = await authRoute.POST(request("/api/auth/sign-in/email", { email, password }));
    return {
      response,
      cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
    };
  }
  const admin = await signIn(credentials.email, credentials.password);
  assert.equal(admin.response.status, 200);
  assert.equal((await users.GET(request("/api/users", undefined, admin.cookie))).status, 200);
  const standardCredentials = { email: "user@example.test", password: "another strong password" };
  assert.equal((await users.POST(request("/api/users", { action: "create", ...standardCredentials, role: "user" }, admin.cookie))).status, 200);
  const standard = await signIn(standardCredentials.email, standardCredentials.password);
  assert.equal(standard.response.status, 200);
  assert.equal((await library.GET(request("/api/library", undefined, standard.cookie))).status, 200);
  assert.equal((await social.GET(request("/api/youtube/status", undefined, standard.cookie))).status, 403);
  assert.equal((await users.GET(request("/api/users", undefined, standard.cookie))).status, 403);
  assert.equal((await users.POST(request("/api/users", { action: "create", ...standardCredentials, role: "admin" }, standard.cookie))).status, 403);
  assert.equal((await users.POST(request("/api/users", { action: "create", ...standardCredentials, role: "admin" }, admin.cookie, "http://attacker.test"))).status, 403);
  for (const provider of ["facebook", "instagram", "youtube", "tiktok"]) {
    for (const endpoint of ["connect", "callback", "status"]) {
      const route = await load(`app/api/${provider}/${endpoint}/route.ts`, {
        ...dependencies, [`@/src/lib/${provider}`]: {},
      });
      const pathname = `/api/${provider}/${endpoint}`;
      const method = endpoint === "connect" ? "POST" : "GET";
      const body = method === "POST" ? {} : undefined;
      assert.equal((await route[method](request(pathname, body))).status, 401, pathname);
      assert.equal((await route[method](request(pathname, body, standard.cookie))).status, 403, pathname);
    }
  }
  for (const pathname of ["/api/upload", "/api/upload/check"]) {
    const route = await load(`app${pathname}/route.ts`, { ...dependencies, "@/src/lib/videos": {} });
    assert.equal((await route.POST(request(pathname, {}))).status, 401, pathname);
  }

  const list = await (await users.GET(request("/api/users", undefined, admin.cookie))).json();
  const userId = list.users.find((user) => user.email === standardCredentials.email).id;
  const replacement = "replacement password 123";
  assert.equal((await users.POST(request("/api/users", { action: "reset", userId, password: replacement }, admin.cookie))).status, 200);
  assert.equal((await library.GET(request("/api/library", undefined, standard.cookie))).status, 401);
  assert.notEqual((await signIn(standardCredentials.email, standardCredentials.password)).response.status, 200);
  const afterReset = await signIn(standardCredentials.email, replacement);
  assert.equal(afterReset.response.status, 200);
  assert.equal((await users.POST(request("/api/users", { action: "disable", userId }, admin.cookie))).status, 200);
  assert.equal((await library.GET(request("/api/library", undefined, afterReset.cookie))).status, 401);
  assert.notEqual((await signIn(standardCredentials.email, replacement)).response.status, 200);
  assert.equal((await users.POST(request("/api/users", { action: "enable", userId }, admin.cookie))).status, 200);
  const enabled = await signIn(standardCredentials.email, replacement);
  assert.equal(enabled.response.status, 200);
  database.prepare("UPDATE auth_session SET expiresAt = 0 WHERE userId = ?").run(userId);
  assert.equal((await library.GET(request("/api/library", undefined, enabled.cookie))).status, 401);
  assert.equal((await authRoute.POST(request("/api/auth/sign-out", {}, admin.cookie))).status, 200);
  assert.equal((await users.GET(request("/api/users", undefined, admin.cookie))).status, 401);
  const adminAgain = await signIn(credentials.email, credentials.password);
  const adminId = list.users.find((user) => user.email === credentials.email).id;
  const newAdminPassword = "new administrator password";
  assert.equal((await users.POST(request("/api/users", { action: "reset", userId: adminId, password: newAdminPassword }, adminAgain.cookie))).status, 200);
  assert.equal((await users.GET(request("/api/users", undefined, adminAgain.cookie))).status, 401);
  assert.equal((await signIn(credentials.email, newAdminPassword)).response.status, 200);

  database.prepare("DELETE FROM auth_rate_limit").run();
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await signIn("nonexistent@example.test", "wrong password here")).response.status, 401);
  }
  assert.equal((await signIn(credentials.email, newAdminPassword)).response.status, 429);

  const order = [];
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const first = lock.withAuthLock(standardCredentials.email, async () => {
    order.push("first");
    entered();
    await started;
  });
  await firstEntered;
  const second = lock.withAuthLock(standardCredentials.email, async () => { order.push("second"); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  database.close();
});
