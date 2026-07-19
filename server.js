require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const multer   = require('multer');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ── env validation ──────────────────────────────────────────────────────────
const {
  PORT = 4000,
  JWT_SECRET,
  ADMIN_PASSWORD_HASH,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = 'media',
} = process.env;

const missing = ['JWT_SECRET','ADMIN_PASSWORD_HASH','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error('\nMissing env vars: ' + missing.join(', ') + '\nSee README.md.\n');
  process.exit(1);
}

// ── Supabase client (service-role = full access, never exposed to browser) ──
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session — please sign in again' });
  }
}

// ── multer (memory storage — files go straight to Supabase, never touch disk) ──
const ALLOWED = new Set([
  'image/jpeg','image/png','image/webp','image/gif',
  'video/mp4','video/webm','video/quicktime',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) =>
    ALLOWED.has(file.mimetype) ? cb(null, true) : cb(new Error('Unsupported file type: ' + file.mimetype)),
});

// ── helpers ──────────────────────────────────────────────────────────────────
function uid() {
  return 'i_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function uploadToSupabase(buffer, mimetype, originalname) {
  const ext  = path.extname(originalname).slice(0, 10) || '';
  const key  = 'media/m_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + ext;
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(key, buffer, { contentType: mimetype, upsert: false });
  if (error) throw new Error('Storage upload failed: ' + error.message);

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key);
  return { key, url: data.publicUrl };
}

async function deleteFromSupabase(key) {
  if (!key) return;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([key]);
  if (error) console.error('Storage delete failed:', error.message);
}

// ── routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!bcrypt.compareSync(password, ADMIN_PASSWORD_HASH))
    return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// Verify session
app.get('/api/me', requireAuth, (_req, res) => res.json({ ok: true }));

// List gallery (public)
app.get('/api/gallery', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('gallery_items')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load gallery' });
  }
});

// Upload (admin only)
app.post('/api/gallery', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { category, caption, type, url } = req.body;
    if (!category || !type)
      return res.status(400).json({ error: 'category and type are required' });
    if (!req.file && !url)
      return res.status(400).json({ error: 'Provide a file or a video URL' });

    try {
      let fileUrl = url || null;
      let storageKey = null;

      if (req.file) {
        const up = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname);
        storageKey = up.key;
        fileUrl    = up.url;
      }

      const item = {
        id: uid(), type, category,
        caption: caption || '',
        url: fileUrl,
        storage_key: storageKey,
      };

      const { data, error } = await supabase.from('gallery_items').insert(item).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Upload failed: ' + e.message });
    }
  });
});

// Delete (admin only)
app.delete('/api/gallery/:id', requireAuth, async (req, res) => {
  try {
    const { data: item, error: fetchErr } = await supabase
      .from('gallery_items').select('*').eq('id', req.params.id).single();
    if (fetchErr || !item) return res.status(404).json({ error: 'Not found' });

    await deleteFromSupabase(item.storage_key);

    const { error: delErr } = await supabase.from('gallery_items').delete().eq('id', req.params.id);
    if (delErr) throw delErr;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
});

// Frontend fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`Sangam Films running at http://localhost:${PORT}`));
