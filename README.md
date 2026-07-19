# Sangam Films — website + backend

A Node.js/Express backend with real login (bcrypt + JWT) and photo/video
uploads. This version stores uploaded media in **Cloudflare R2** so it
survives redeploys and restarts — the earlier local-disk version would
lose uploads on most free hosts.

## Is this free?

Yes, with this combination:

| Piece | Service | Cost |
|---|---|---|
| Server (runs the code) | Render free web service | Free, no card required |
| Uploaded photos/videos | Cloudflare R2 | Free up to 10GB storage, no time limit |
| Gallery data (categories, captions) | SQLite file on the server | Free (small, part of the app) |

The one trade-off on Render's free tier: the server "spins down" after 15
minutes with no visitors and takes 30-60 seconds to wake up on the next
visit. Your uploaded media itself is unaffected either way, since it lives
in R2, not on Render's disk. If that wake-up delay bothers you later, a
paid Render instance (~$7/month) removes it — but it's not required.

## 1. Set up Cloudflare R2 (where your uploads live)

This is the part that makes your uploads permanent. Takes about 5 minutes.

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up if you don't have one.
2. In the dashboard sidebar, go to **R2 Object Storage** → **Create bucket**. Name it something like `sangam-films-media`. Location: Automatic.
3. Open the bucket → **Settings** → under **Public Access**, enable the **R2.dev subdomain**. Copy the public URL it gives you (looks like `https://pub-xxxxxxxx.r2.dev`) — this is your `R2_PUBLIC_URL`.
4. Go to **R2 Object Storage** → **Manage R2 API Tokens** → **Create API Token**. Give it **Object Read & Write** permission, scoped to your bucket. After creating it, copy:
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
   - Your **Account ID** (shown on the main R2 page, or in your Cloudflare account dashboard URL) → `R2_ACCOUNT_ID`
5. Your bucket name from step 2 → `R2_BUCKET_NAME`.

You'll paste these five values into `.env` in step 3 below.

## 2. Install dependencies

Requires Node.js 18+.

```bash
npm install
```

## 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

- Generate your admin password hash: `node hash-password.js "yourChosenPassword"`, then paste the output into `ADMIN_PASSWORD_HASH`.
- Generate a random `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Paste in the five `R2_...` values from step 1.

If you leave the `R2_...` values blank, the app automatically falls back to
saving uploads on local disk instead — handy for quick testing on your own
machine, but don't rely on it once deployed (see the persistence note below).

## 4. Run locally

```bash
npm start
```

Visit `http://localhost:4000`. The startup log tells you which storage mode
is active ("Cloudflare R2" or "local disk").

## 5. Deploy to Render (free)

1. Push this project to a GitHub repository (`.gitignore` already excludes `node_modules`, `.env`, `data.db`, `uploads/`).
2. At https://render.com, sign up (no card required for the free tier) and click **New → Web Service**, connecting your repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment**, add every variable from your `.env` file (`JWT_SECRET`, `ADMIN_PASSWORD_HASH`, the five `R2_...` values). Don't set `PORT` — Render provides it automatically.
5. Deploy. Render gives you a URL like `https://sangam-films.onrender.com` — that's your live site.

Render's free web service pricing/limits do shift over time, so it's worth
a quick glance at https://render.com/pricing before you deploy in case
anything's changed since this was written.

## Why your uploads will actually stay uploaded now

Previously, both the uploaded files and the gallery's data (categories,
captions) were saved to the server's own disk. Most free hosts (Render
included) don't guarantee that disk survives restarts or redeploys, so
everything could quietly vanish.

Now, when R2 is configured, **both** the media files and the gallery's data
are stored in your R2 bucket — nothing gallery-related is written to the
server's local disk at all. The server itself becomes disposable: restarts,
redeploys, even moving to an entirely different host are all safe, because
none of your data lives there.

## Project structure

```
sangam-films/
  server.js          — Express API + static file server
  hash-password.js   — one-time helper to generate your admin password hash
  package.json
  .env.example        — copy to .env and fill in
  public/
    index.html        — the site itself (frontend)
  uploads/             — only used in local-disk fallback mode
  data.db              — created automatically, SQLite database
```

## API reference

| Method | Route              | Auth | Purpose                                  |
|--------|--------------------|------|-------------------------------------------|
| POST   | `/api/login`       | —    | `{ password }` → `{ token }`              |
| GET    | `/api/me`          | yes  | Verify a saved token is still valid       |
| GET    | `/api/gallery`     | —    | List all gallery items (public)           |
| POST   | `/api/gallery`     | yes  | Upload a photo/video (multipart form)     |
| DELETE | `/api/gallery/:id` | yes  | Remove an item and its stored file        |

Authenticated requests send `Authorization: Bearer <token>`.
