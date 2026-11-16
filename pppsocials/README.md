This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Upload database setup

Configure `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` for
the MySQL database, then apply the schema once to that database:

```bash
mysql -u YOUR_USER -p YOUR_DATABASE < docs/videos.sql
```

New uploads save their title, description, and path relative to the application
directory in the `videos` table. Files are stored in the application's `uploads`
directory with unique names. If saving metadata fails, the new file is removed
when possible and the upload reports an error. Existing files are not imported.

## Instagram connection

The Instagram connection uses Meta's Instagram API with Unified Login and stores
one shared business connection for the app. It does not publish videos yet.

**The app does not have team login yet.** The connections are disabled by default.
Before enabling it, protect the entire application, including `/settings` and
all `/api/instagram/*` and `/api/facebook/*` routes, with authentication at Nginx or another trusted
reverse proxy. Restrict direct access to the Node.js port so the proxy cannot be
bypassed. Anyone who can access these routes can replace the shared connection.

1. Apply `docs/instagram.sql` to the same MySQL database as the app:

   ```bash
   mysql -u YOUR_USER -p YOUR_DATABASE < docs/instagram.sql
   ```

2. Set these server-side environment variables (never commit them to GitHub):
   - `APP_URL`: the app's public HTTPS origin, for example `https://mbasocials.mbattractions.com`
   - `META_APP_ID` and `META_APP_SECRET`: the Meta app ID and app secret (not the Instagram app credentials)
   - `META_CONFIG_ID`: the Unified Login configuration ID
   - `INSTAGRAM_TOKEN_KEY`: a persistent, randomly generated 32-byte key encoded as 64 hex characters; generate one privately with `openssl rand -hex 32`
   - `INSTAGRAM_CONNECTION_ENABLED=true`: set only after access is protected

   Keep a secure backup of the encryption key. Changing or losing it makes
   existing saved tokens unusable; reconnect the account if that happens.
3. In Meta's Unified Login setup, register and select the exact redirect URL
   `<APP_URL>/api/instagram/callback` (not just the site root). The URL must
   match `APP_URL` exactly. Configure HTTPS and restart the Node.js app after
   setting its environment variables.
4. Open Settings and select **Connect Instagram**. Approve access and select
   the intended business portfolio and Instagram account(s). Reconnecting
   replaces the previously saved connection.

The callback URL contains a temporary authorization code. Configure Nginx and
any other proxy or monitoring system not to log query strings for
`/api/instagram/callback`. Tokens are encrypted before storage and are not
returned to the browser. Do not share screenshots containing tokens or secrets.
Meta app review and appropriate access levels may be needed for users without
app roles. Webhooks and Instagram publishing are not implemented yet.

## Facebook Page connection

Facebook Pages use a separate Facebook Login for Business configuration with a
user access token and the Page permissions required by Meta's Stories API.
Apply `docs/facebook.sql` to the app database and set `FACEBOOK_CONFIG_ID` to
that configuration's ID. Register `<APP_URL>/api/facebook/callback` in Meta's
valid OAuth redirect URLs and exclude its query string from proxy access logs.
Set `FACEBOOK_CONNECTION_ENABLED=true` only after protecting the entire app and
blocking direct access to the Node.js port. The connection shares `APP_URL`,
`META_APP_ID`, `META_APP_SECRET`, and `INSTAGRAM_TOKEN_KEY` with Instagram.

Use **Connect Facebook Pages** in Settings to grant access. Reconnecting
replaces the saved Pages. Page tokens are encrypted on the server and never
sent to the browser. App Review, Page permissions, and Page publishing
authorization may be required. This connection does not publish Stories yet.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
