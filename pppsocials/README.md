This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Application login

The app uses individual email/password accounts. Administrators can manage
users and social connections; standard users can access the dashboard, uploads,
and Library. There is no public signup. All accounts share the same video
library and social connections.

Before deploying this version:

1. Back up the database. In aaPanel's database console, run the statements in
   `docs/auth.sql` once against the app's existing database. These are new
   tables; do not overwrite existing tables or delete existing videos.
2. Privately generate **two different** random secrets, for example by running
   `openssl rand -hex 32` twice on your own computer. Do not send them in chat,
   commit them, or use an online generator.
3. In the Node app's private environment in aaPanel, set:
   - `APP_URL` to the exact public HTTPS origin, with no trailing slash
     (for example `https://example.com`).
   - `BETTER_AUTH_SECRET` to the first 64-character hexadecimal secret. Keep
     it stable and backed up; changing it signs everyone out.
   - `AUTH_SETUP_SECRET` to the second 64-character hexadecimal secret.
   - The existing `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.
4. Deploy the code, install its dependencies, build using Node 20.9 or later
   (use the same Node 26 installation already configured for this app), and
   restart the Node app. A successful Git pull alone does not build or restart
   it. Keep HTTPS enabled, and restrict direct access to the Node.js port.
5. Visit `<APP_URL>/setup` and enter the setup secret, administrator email,
   and a unique password of 12–128 characters. Setup is allowed only while
   there are no users, and simultaneous setup attempts are serialized.
6. Remove `AUTH_SETUP_SECRET` from the server environment and restart the app.
   Sign in at `<APP_URL>/login` and use **Users** to create accounts. Share
   temporary passwords through a secure channel, not in public messages.

Administrators can reset passwords and disable or re-enable standard users.
Resetting a password or disabling a user revokes that user's sessions.
Administrator accounts cannot be disabled from this screen, preventing an
accidental lockout. Sessions expire after 24 hours, or when the browser
session ends. Login attempts are limited to 10 per 15 minutes across the app
as a whole; this deliberately avoids trusting client-supplied IP headers. If
the limit is reached, everyone must wait for the window to expire.

The login protects dashboard pages, APIs, video streams, and connection
callbacks. Continue to restrict the Node port and uploaded files from direct
web-server access. Users who were signed in on a shared device should use
**Sign out**. An administrator must reset forgotten passwords; email-based
recovery is not configured.

## Upload database setup

Configure `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` for
the MySQL database, then apply the schema once to that database:

```bash
mysql -u YOUR_USER -p YOUR_DATABASE < docs/videos.sql
```

New uploads save their title, description, generated filename, and path relative
to the application directory in the `videos` table. Files are stored in the
application's `uploads` directory with unique names. If saving metadata fails,
the new file is removed when possible and the upload reports an error. Existing
files are not imported.

The Library lists uploaded records and streams their files for playback. Playback
depends on the video format and codec supported by the browser. Instagram and
Facebook Page Story publishing and YouTube uploads are available as described
below; other publishing integrations are not implemented yet. The Library and
video endpoints require an application login.

If an existing `videos` table was created from an older version of
`docs/videos.sql` and has no `filename` column, back up the database, stop
uploads, and run the following before deploying the updated app:

```sql
ALTER TABLE videos ADD COLUMN filename VARCHAR(255) NULL;
UPDATE videos SET filename = SUBSTRING_INDEX(REPLACE(filepath, CHAR(92), '/'), '/', -1)
  WHERE filename IS NULL;
ALTER TABLE videos MODIFY COLUMN filename VARCHAR(255) NOT NULL;
```

Do not run this migration if the table already has a `filename` column. Resume
uploads after deploying and restarting the app.

For an existing table without `original_filename`, back up the database, stop
uploads, and run the following once in aaPanel's database console before
deploying this version:

```sql
ALTER TABLE videos ADD COLUMN original_filename VARCHAR(255) NULL;
```

Do not run it if the column already exists. New uploads retain their original
filenames and check for matches without regard to capitalization. Older uploads
only retain sanitized names, so they are shown as possible matches and require
extra care when selecting a replacement. Replacement updates the title and
description. The Library can delete an individual video after confirmation;
deletion and replacement cannot be undone. Resume uploads after deploying and
restarting the app.

Videos can be up to 1 GB (1,000,000,000 bytes). Uploads are streamed to disk,
and text fields are limited to 1 MiB. In the Nginx server configuration, allow
enough space for the video and multipart form overhead:

```nginx
client_max_body_size 1001m;
```

Check for a lower limit in any `/api/upload` location or upstream proxy, then
test the Nginx configuration and reload it. Ensure the app's `uploads` directory
is writable and has enough free disk space.

The upload endpoint is excluded from Next.js Proxy so large uploads are streamed
without Proxy's request-body buffering limit. The upload route itself enforces
the application login and same-origin checks.

## Instagram connection

The Instagram connection uses Meta's Instagram API with Unified Login and stores
one shared business connection for the app.

The connections are disabled by default. Complete application login setup before
enabling them, and restrict direct access to the Node.js port. Only application
administrators can access social settings and connection routes.

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
app roles. Webhooks are not implemented.

### Publishing Instagram Stories

Back up the database and wait for ongoing publishing attempts to finish before
stopping the app for deployment. If the `instagram_publications` table does not
exist, apply `docs/instagram-publications.sql` once. If it already exists from
the earlier Reel publisher, apply `docs/instagram-publications-story-progress.sql`
once instead; do not rerun either script if its changes already exist. The
migration preserves existing attempts and identifies them as Reels.

Configure the Unified Login permissions to include `instagram_content_publish`,
and reconnect the Instagram account if necessary to grant it. Meta access levels,
app review, or Page publishing authorization may also be required.

Every signed-in user can select a Library video, choose connected Instagram
accounts, and confirm Story publishing. The Library description is not added as
text to the Story. The app streams the video directly to Meta; it does not make
the Library publicly accessible. Meta specifies Story videos of 3-60 seconds
and at most 100 MB (100,000,000 bytes), along with other format requirements.
The app rejects larger files but does not check duration or convert videos.
Check [Meta's specifications](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media)
before publishing.

The Library records each account's status and refreshes it while open. The
upload percentage measures bytes read for transfer to Meta, not receipt by Meta;
100% is shown only once Meta confirms the upload. Processing and publishing
have indeterminate progress because Meta does not report a percentage.

The app must remain running during uploads and processing. If the server stops,
the request is interrupted, or the final Meta response is lost, the result may
be uncertain. Check the Instagram account before resolving an uncertain or
stalled attempt and trying again: otherwise a duplicate may be published.
Uncertain attempts can be resolved immediately; interrupted attempts become
resolvable after 90 minutes. Meta may take additional time to show a published
Story. A webhook is not used for this publishing flow.

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
authorization may be required.

### Publishing Facebook Page Stories

Back up the database, then apply `docs/facebook-publications.sql` once to the
app database before deploying this version. Do not rerun it if the table already
exists. Rebuild and restart the app after deployment.

The Facebook Login for Business configuration must grant `pages_manage_posts`,
`pages_read_engagement`, and `pages_show_list`; the Page must grant the user
`CREATE_CONTENT`. Reconnect the Pages if new permissions need to be granted.
App Review and Page publishing authorization may also be needed.

Every signed-in user can open **Publish** on a Library video, choose connected
Facebook Pages, and confirm a Story for those Pages. Instagram and Facebook
are submitted separately. The Library description is not added as text.
The video is streamed directly to Meta, without making the Library public. Meta
requires videos of at least 3 seconds and states that video Stories cannot exceed
60 seconds, with additional [format requirements](https://developers.facebook.com/docs/page-stories-api/).
The app does not check duration or convert videos.

Upload progress measures bytes read for transfer; 100% appears only after Meta
confirms the upload. A successful finish response is recorded as published,
although Meta may take additional time to process or display the Story. Keep the
app running during publishing. If a final response is lost or the app stops,
check the Facebook Page before resolving or retrying, to avoid duplicates.
Uncertain attempts can be resolved immediately; interrupted attempts become
resolvable after 90 minutes.

## YouTube channels

The YouTube connection stores multiple channels, authorized one at a time. It
requests `youtube.readonly` to identify the channel and `youtube.upload` to
upload videos.

Complete application login setup and block direct access to the Node.js port
before enabling this feature. Administrators can add or reconnect channels.

1. Apply `docs/youtube.sql` to the app database once.
2. In Google Cloud, enable **YouTube Data API v3** and configure the OAuth
   consent screen. Create a **Web application** OAuth client and register the
   exact redirect URI `<APP_URL>/api/youtube/callback`.
3. Configure these server-side environment variables (never commit or share
   the client secret):
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: the web OAuth client credentials.
   - `APP_URL`: the app's public HTTPS origin.
   - `INSTAGRAM_TOKEN_KEY`: the same persistent 32-byte encryption key used by
     the existing integrations, encoded as 64 hex characters. Back it up
     securely; changing it makes saved refresh tokens unreadable.
   - `YOUTUBE_CONNECTION_ENABLED=true`: set only after protecting the app.
4. Back up the database and apply `docs/youtube-publications.sql` once if the
   `youtube_publications` table does not already exist. Deploy, rebuild, and
   restart the Node app. In Settings, choose **Connect a YouTube channel** and
   grant both permissions for the intended channel. Repeat for each channel;
   reconnecting one updates only that channel. Channels connected before YouTube
   uploading was added must be reconnected to grant upload access.

Google may require OAuth verification, and an external app in testing must add
the relevant Google accounts as test users. Testing-mode refresh tokens can
expire after seven days; revoked or expired tokens require reconnecting.
Settings shows saved channels without checking whether their tokens still work.
Do not log query strings or sensitive referrers for `/api/youtube/callback`;
the callback contains a temporary authorization code.

### Uploading YouTube Shorts

Every signed-in user can open **Publish** on a Library video and select YouTube
channels. The YouTube title and description are prefilled from the Library and
can be edited for the upload; changes do not modify the Library. Choose public
(the default), private, or unlisted, declare the audience and altered-content
setting, certify compliance with YouTube's Community Guidelines, and confirm the
upload. Uploads to different platforms are submitted separately.

Install `ffprobe` (part of FFmpeg) on the app server and ensure it is available
on the Node app's `PATH`. Before uploading, the app checks that the video is
square or vertical and no longer than three minutes, including rotation metadata.
The check requires exactly one non-cover-art video stream.
If `ffprobe` is unavailable or cannot read the video, the upload is blocked.
Videos are not converted. YouTube makes the final classification; see
[YouTube's Shorts guidance](https://support.google.com/youtube/answer/15424877).

Progress shows bytes acknowledged by YouTube. Once YouTube accepts the upload,
the app shows the returned privacy setting if available; check YouTube Studio for
the actual privacy and processing status, since YouTube or channel settings may
change the requested privacy. Keep the app running during uploads. If the result
is uncertain or the app stops, check YouTube Studio before resolving or retrying
to avoid duplicates. Uncertain attempts can be resolved immediately; interrupted
attempts become resolvable after 90 minutes.

Before making the integration available to users, the operator must also review
and meet [YouTube's API policies](https://developers.google.com/youtube/terms/developer-policies),
including its terms, privacy policy, and data-deletion requirements.

## TikTok accounts

The TikTok connection stores multiple accounts, authorized one at a time using
Login Kit's `user.info.basic` scope. It does not publish videos; posting requires
additional TikTok permissions, review, and implementation.

Complete application login setup and block direct access to the Node.js port
before enabling this feature. Administrators can add or reconnect accounts.

1. Apply `docs/tiktok.sql` to the app database once.
2. Create an app at [TikTok for Developers](https://developers.tiktok.com/),
   add **Login Kit** for web, and register the exact redirect URI
   `<APP_URL>/api/tiktok/callback`. Configure the `user.info.basic` scope.
3. Configure these server-side environment variables (never commit or share
   the client secret):
   - `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`: the selected TikTok app's credentials.
   - `APP_URL`: the app's public HTTPS origin.
   - `INSTAGRAM_TOKEN_KEY`: the same persistent encryption key used by the
     existing integrations. Back it up securely; changing it makes saved
     tokens unreadable.
   - `TIKTOK_CONNECTION_ENABLED=true`: set only after protecting the app.
4. Deploy, rebuild, and restart the Node app. In Settings, choose **Connect a
   TikTok account** and authorize the intended account. Repeat for each account;
   reconnecting one updates only that account. Switch TikTok accounts if needed.

TikTok offers [sandbox testing](https://developers.tiktok.com/doc/add-a-sandbox/)
with separate sandbox credentials and target users. Production access requires
TikTok review. The stored access and refresh tokens are encrypted; this app does
not yet refresh them automatically. Expired or revoked connections require
reconnecting. Settings shows saved accounts without checking token validity.
Do not log query strings or sensitive referrers for `/api/tiktok/callback`;
the callback contains a temporary authorization code.

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
