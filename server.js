require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!JWT_SECRET || !ADMIN_PASSWORD_HASH) {
  console.error(
    '\nMissing JWT_SECRET or ADMIN_PASSWORD_HASH.\n' +
    'Copy .env.example to .env, then run "node hash-password.js yourPassword" to fill it in.\n'
  );
  process.exit(1);
}

// ---------- storage backend ----------
// R2 mode (recommended): media files AND the gallery's metadata (categories,
// captions, ordering) both live in your R2 bucket, so nothing depends on the
// server's own disk. Restarts, redeploys, even moving to a different host
// are all safe.
// Local mode (dev only): media + metadata live on this machine's disk in
// uploads/ and data.db. Fine for testing, not safe on most free hosts.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // e.g. https://pub-xxxx.r2.dev or a custom domain

const USE_R2 = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL);
const METADATA_KEY = 'gallery-items.json';

let s3 = null;
if (USE_R2) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
  });
  console.log('Storage: Cloudflare R2 (persistent) — bucket "' + R2_BUCKET_NAME + '". Media and gallery data both live there.');
} else {
  console.log('Storage: local disk (uploads/ + data.db) — fine for local dev, NOT persistent on most free hosts.');
  console.log('Set the R2_... variables in .env to switch to persistent Cloudflare R2 storage.');
}

const uploadsDir = path.join(__dirname, 'uploads');
if (!USE_R2) fs.mkdirSync(uploadsDir, { recursive: true });

// ---------- local-mode database (only used when R2 isn't configured) ----------
let db = null;
if (!USE_R2) {
  db = new Database(path.join(__dirname, 'data.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      caption TEXT,
      storage TEXT NOT NULL,
      object_key TEXT,
      external_url TEXT,
      created_at INTEGER NOT NULL
    )
  `);
}

// ---------- metadata store abstraction ----------
// Every item shape: { id, type, category, caption, storage, object_key, external_url, created_at }

async function r2GetJson(key, fallback) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return fallback;
    throw e;
  }
}
async function r2PutJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME, Key: key,
    Body: JSON.stringify(value), ContentType: 'application/json'
  }));
}

async function getAllItems() {
  if (USE_R2) {
    const items = await r2GetJson(METADATA_KEY, []);
    return items.sort((a, b) => b.created_at - a.created_at);
  }
  return db.prepare('SELECT * FROM gallery_items ORDER BY created_at DESC').all();
}

async function addItem(item) {
  if (USE_R2) {
    const items = await r2GetJson(METADATA_KEY, []);
    items.push(item);
    await r2PutJson(METADATA_KEY, items);
    return;
  }
  db.prepare(
    'INSERT INTO gallery_items (id, type, category, caption, storage, object_key, external_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(item.id, item.type, item.category, item.caption, item.storage, item.object_key, item.external_url, item.created_at);
}

async function getItem(id) {
  if (USE_R2) {
    const items = await r2GetJson(METADATA_KEY, []);
    return items.find(i => i.id === id) || null;
  }
  return db.prepare('SELECT * FROM gallery_items WHERE id = ?').get(id) || null;
}

async function removeItem(id) {
  if (USE_R2) {
    const items = await r2GetJson(METADATA_KEY, []);
    const next = items.filter(i => i.id !== id);
    await r2PutJson(METADATA_KEY, next);
    return;
  }
  db.prepare('DELETE FROM gallery_items WHERE id = ?').run(id);
}

// ---------- app setup ----------
const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true, credentials: false }));
app.use(express.json());
if (!USE_R2) app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session, please sign in again' });
  }
}

// ---------- upload handling ----------
const storageEngine = USE_R2
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '').slice(0, 10);
        cb(null, 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
      }
    });

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

const upload = multer({
  storage: storageEngine,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB, enough for short clips
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type: ' + file.mimetype));
  }
});

function makeObjectKey(originalName) {
  const ext = (path.extname(originalName) || '').slice(0, 10);
  return 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
}

async function uploadToR2(file) {
  const key = makeObjectKey(file.originalname);
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME, Key: key,
    Body: file.buffer, ContentType: file.mimetype
  }));
  return key;
}

function publicUrlFor(item) {
  if (item.storage === 'r2') return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${item.object_key}`;
  if (item.storage === 'local') return `/uploads/${item.object_key}`;
  return item.external_url;
}

// ---------- routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, storage: USE_R2 ? 'r2' : 'local' }));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const ok = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.admin.role });
});

app.get('/api/gallery', async (req, res) => {
  try {
    const rows = await getAllItems();
    res.json(rows.map(r => ({
      id: r.id, type: r.type, category: r.category, caption: r.caption || '',
      url: publicUrlFor(r), created_at: r.created_at
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load gallery' });
  }
});

app.post('/api/gallery', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { category, caption, type, url } = req.body;
    if (!category || !type) return res.status(400).json({ error: 'category and type are required' });
    if (!req.file && !url) return res.status(400).json({ error: 'Provide a file or a video URL' });

    try {
      const id = 'i_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const createdAt = Date.now();
      let storageType, objectKey = null, externalUrl = null;

      if (req.file && USE_R2) {
        objectKey = await uploadToR2(req.file);
        storageType = 'r2';
      } else if (req.file) {
        objectKey = req.file.filename;
        storageType = 'local';
      } else {
        externalUrl = url;
        storageType = 'external';
      }

      const item = {
        id, type, category, caption: caption || '',
        storage: storageType, object_key: objectKey, external_url: externalUrl,
        created_at: createdAt
      };
      await addItem(item);
      res.json({ id, type, category, caption: caption || '', url: publicUrlFor(item), created_at: createdAt });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Upload failed, please try again' });
    }
  });
});

app.delete('/api/gallery/:id', requireAuth, async (req, res) => {
  try {
    const row = await getItem(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row.storage === 'r2') {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: row.object_key }));
    } else if (row.storage === 'local') {
      const fp = path.join(uploadsDir, row.object_key);
      fs.existsSync(fp) && fs.unlinkSync(fp);
    }

    await removeItem(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed, please try again' });
  }
});

// Fallback: serve the frontend for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Sangam Films backend running at http://localhost:${PORT}`);
});
