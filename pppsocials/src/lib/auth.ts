import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import mysql from "mysql2/promise";

function publicOrigin() {
  const value = process.env.APP_URL;
  if (!value) throw new Error("APP_URL is required for authentication.");
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && url.hostname === "localhost" && url.protocol === "http:"))) {
    throw new Error("APP_URL must be an HTTPS origin without a trailing slash.");
  }
  return value;
}

export { publicOrigin };

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error("BETTER_AUTH_SECRET must be a random 32-byte hexadecimal value.");
  }
  return betterAuth({
    baseURL: publicOrigin(),
    secret,
    database: mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      timezone: "Z",
    }),
    user: { modelName: "auth_user" },
    session: {
      modelName: "auth_session",
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limit",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 900, max: 10 } },
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      ipAddress: { ipAddressHeaders: [] },
    },
    plugins: [admin()],
    telemetry: { enabled: false },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  instance ??= createAuth();
  return instance;
}
