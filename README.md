# Sangam Films — website + backend

Node/Express backend with **Supabase Storage** for uploaded photos/videos
and **Supabase Postgres** for gallery metadata. Both live in Supabase, which
is completely separate from your app server — so redeploys, restarts, or
free-tier spin-downs never touch your uploads.

## How the pieces fit

```
Browser  ──→  Render (Express app)  ──→  Supabase Postgres  (gallery metadata)
                                    ──→  Supabase Storage   (photo/video files)
```

Everything important lives in Supabase. The Express app is stateless — you
can redeploy it, let it sleep, or move it to a different host without losing
a single upload.

---

## Setup (do this once)

### Step 1 — Supabase project

1. Go to **supabase.com** → **New project** → choose a name and a strong
   database password → **Create project** (takes ~1 minute).

2. **Create the storage bucket:**
   Left sidebar → **Storage** → **New bucket** → name it `media` →
   **make it Public** (toggle on) → **Create bucket**.

3. **Create the database table:**
   Left sidebar → **SQL Editor** → **New query** → paste the contents of
   `supabase-setup.sql` → **Run**.

4. **Copy your API keys:**
   Left sidebar → **Project Settings** → **API**. You need:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role** secret (under "Project API keys", click reveal) →
     this is `SUPABASE_SERVICE_ROLE_KEY`
   
   Keep the service_role key private — it bypasses all access rules.
   It's only used by your backend server, never sent to the browser.

---

### Step 2 — configure the app locally

```bash
npm install
cp .env.example .env
```

Generate your admin password hash:
```bash
node hash-password.js "yourChosenPassword"
```
Paste the output into `.env` as `ADMIN_PASSWORD_HASH`.

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste into `.env` as `JWT_SECRET`.

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from step 1.

---

### Step 3 — run locally

```bash
npm start
```

Open `http://localhost:4000` → click **Admin** → sign in → **Upload**.
Check your Supabase Storage bucket — uploaded files appear there immediately.

---

### Step 4 — deploy to Render (free, no credit card)

1. Push the project to GitHub (`.gitignore` excludes `node_modules` and `.env`).
2. **render.com** → **New** → **Web Service** → connect your GitHub repo.
3. Build command: `npm install`
   Start command: `npm start`
4. Under **Environment** → add every variable from your `.env`:
   - `JWT_SECRET`
   - `ADMIN_PASSWORD_HASH`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_BUCKET` (value: `media`)
   - Leave `PORT` out — Render sets it automatically
5. Click **Deploy**. You'll get a free `yoursite.onrender.com` URL with HTTPS.

**Free tier note:** Render's free web services sleep after 15 minutes of no
traffic, and take ~30–60 seconds to wake on the next visit. That's the main
tradeoff of the free tier. Your uploads are completely safe because they live
in Supabase, not on Render's disk — but visitors may see a loading delay if
the site hasn't been visited in a while. For a portfolio site this is usually
fine.

---

## Project structure

```
sangam-films/
  server.js             Express backend + Supabase integration
  hash-password.js      One-time helper: generate your admin password hash
  supabase-setup.sql    Run once in Supabase SQL Editor to create the table
  package.json
  .env.example          Copy to .env and fill in
  public/
    index.html          The frontend (served by Express)
```

## API

| Method | Route              | Auth | What it does                          |
|--------|--------------------|------|---------------------------------------|
| POST   | `/api/login`       | —    | `{ password }` → `{ token }`          |
| GET    | `/api/me`          | yes  | Check token is still valid            |
| GET    | `/api/gallery`     | —    | List all items (public)               |
| POST   | `/api/gallery`     | yes  | Upload photo/video (multipart)        |
| DELETE | `/api/gallery/:id` | yes  | Delete item + file from Storage       |

Authenticated requests: `Authorization: Bearer <token>`
