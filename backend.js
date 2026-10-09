/**
 * ComplaintDesk — Backend API
 * Stack : Node.js + Express + better-sqlite3
 * Auth  : JWT (access token) + bcrypt password hashing
 *
 * Install:
 *   npm install express better-sqlite3 bcryptjs jsonwebtoken cors dotenv
 *
 * Run:
 *   node backend.js          (or: nodemon backend.js)
 *
 * Environment variables (.env):
 *   PORT=3000
 *   JWT_SECRET=your_super_secret_key_change_this
 *   JWT_EXPIRES_IN=7d
 */

require('dotenv').config();
const express    = require('express');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const path       = require('path');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'complaintdesk_secret_change_in_prod';
const JWT_EXP    = process.env.JWT_EXPIRES_IN || '7d';

// ─────────────────────────────────────────────
// Database bootstrap
// ─────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'complaintdesk.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    phone       TEXT,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS complaints (
    id          TEXT    PRIMARY KEY,               -- e.g. CMP-001
    owner_email TEXT    NOT NULL REFERENCES users(email) COLLATE NOCASE,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    phone       TEXT,
    address     TEXT,
    category    TEXT    NOT NULL,
    department  TEXT,
    subject     TEXT    NOT NULL,
    description TEXT    NOT NULL,
    priority    TEXT    NOT NULL DEFAULT 'Medium',
    status      TEXT    NOT NULL DEFAULT 'Pending',
    note        TEXT    DEFAULT '',
    date        TEXT    NOT NULL DEFAULT (date('now')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS counters (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO counters (key, value) VALUES ('complaint_seq', 0);
`);

// Seed a demo admin if none exists
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (name, email, phone, password, role) VALUES (?,?,?,?,?)")
    .run('Admin User', 'admin@complaintdesk.com', '', hash, 'admin');
}

// ─────────────────────────────────────────────
// Express setup
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend files from same folder
app.use(express.static(__dirname));

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXP }
  );
}

function nextComplaintId() {
  const upd = db.prepare("UPDATE counters SET value = value + 1 WHERE key = 'complaint_seq'");
  const sel = db.prepare("SELECT value FROM counters WHERE key = 'complaint_seq'");
  const inc = db.transaction(() => { upd.run(); return sel.get().value; });
  const seq = inc();
  return 'CMP-' + String(seq).padStart(3, '0');
}

function ok(res, data, status = 200)  { res.status(status).json({ success: true,  ...data }); }
function err(res, msg, status = 400)  { res.status(status).json({ success: false, error: msg }); }

// ─────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return err(res, 'No token provided', 401);
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return err(res, 'Invalid or expired token', 401);
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return err(res, 'Admin access only', 403);
    next();
  });
}

// ─────────────────────────────────────────────
// ── AUTH routes ──────────────────────────────
// ─────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { name, email, phone, password }
 */
app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !password)
    return err(res, 'name, email and password are required');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return err(res, 'Invalid email address');

  if (password.length < 8)
    return err(res, 'Password must be at least 8 characters');

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return err(res, 'An account with this email already exists', 409);

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (name, email, phone, password, role) VALUES (?,?,?,?,?)'
  ).run(name, email, phone || '', hash, 'user');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  const token = makeToken(user);

  return ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role }
  }, 201);
});

/**
 * POST /api/auth/login
 * Body: { email, password }          ← for regular users
 *       { email, password, role:'admin' }  ← for admin (email = admin email)
 */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return err(res, 'email and password are required');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return err(res, 'Invalid credentials', 401);

  const token = makeToken(user);
  return ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role }
  });
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's profile.
 */
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,phone,role,created_at FROM users WHERE id=?').get(req.user.id);
  if (!user) return err(res, 'User not found', 404);
  return ok(res, { user });
});

// ─────────────────────────────────────────────
// ── COMPLAINT routes (User) ──────────────────
// ─────────────────────────────────────────────

/**
 * POST /api/complaints
 * Create a new complaint — owner is set from the JWT (cannot be spoofed).
 */
app.post('/api/complaints', requireAuth, (req, res) => {
  if (req.user.role !== 'user') return err(res, 'Only users can file complaints', 403);

  const { name, phone, address, category, department, subject, description, priority } = req.body;

  if (!category || !subject || !description)
    return err(res, 'category, subject and description are required');
  if (description.length < 20)
    return err(res, 'Description must be at least 20 characters');

  const validPriorities = ['Low', 'Medium', 'High', 'Critical'];
  const pri = validPriorities.includes(priority) ? priority : 'Medium';

  const id = nextComplaintId();
  db.prepare(`
    INSERT INTO complaints
      (id, owner_email, name, email, phone, address, category, department, subject, description, priority)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    req.user.email,          // ← always taken from verified JWT
    name || req.user.name,
    req.user.email,
    phone || '',
    address || '',
    category,
    department || 'Unassigned',
    subject,
    description,
    pri
  );

  const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
  return ok(res, { complaint }, 201);
});

/**
 * GET /api/complaints
 * Returns ONLY the complaints belonging to the authenticated user.
 * Query params: status, search, page, limit
 */
app.get('/api/complaints', requireAuth, (req, res) => {
  if (req.user.role !== 'user') return err(res, 'Use /api/admin/complaints for admin', 403);

  const { status, search, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query  = 'SELECT * FROM complaints WHERE owner_email = ?';
  let countQ = 'SELECT COUNT(*) as total FROM complaints WHERE owner_email = ?';
  const params = [req.user.email];

  if (status) {
    query  += ' AND status = ?';
    countQ += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    const like = `%${search}%`;
    query  += ' AND (subject LIKE ? OR id LIKE ? OR category LIKE ?)';
    countQ += ' AND (subject LIKE ? OR id LIKE ? OR category LIKE ?)';
    params.push(like, like, like);
  }

  const total      = db.prepare(countQ).get(...params).total;
  const complaints = db.prepare(query + ' ORDER BY created_at DESC LIMIT ? OFFSET ?')
                       .all(...params, parseInt(limit), offset);

  return ok(res, { complaints, total, page: parseInt(page), limit: parseInt(limit) });
});

/**
 * GET /api/complaints/:id
 * Returns a single complaint — only if it belongs to the authenticated user.
 * ★ KEY ISOLATION: users cannot see other users' complaints by guessing the ID.
 */
app.get('/api/complaints/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'user') return err(res, 'Use /api/admin/complaints/:id for admin', 403);

  const complaint = db.prepare(
    'SELECT * FROM complaints WHERE id = ? AND owner_email = ?'
  ).get(req.params.id, req.user.email);   // ← owner_email check is the isolation gate

  if (!complaint) return err(res, 'Complaint not found or access denied', 404);
  return ok(res, { complaint });
});

// ─────────────────────────────────────────────
// ── ADMIN routes ─────────────────────────────
// ─────────────────────────────────────────────

/**
 * GET /api/admin/complaints
 * Returns ALL complaints (admin sees everything).
 */
app.get('/api/admin/complaints', requireAdmin, (req, res) => {
  const { status, search, priority, page = 1, limit = 30 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query  = 'SELECT * FROM complaints WHERE 1=1';
  let countQ = 'SELECT COUNT(*) as total FROM complaints WHERE 1=1';
  const params = [];

  if (status)   { query += ' AND status = ?';   countQ += ' AND status = ?';   params.push(status); }
  if (priority) { query += ' AND priority = ?'; countQ += ' AND priority = ?'; params.push(priority); }
  if (search) {
    const like = `%${search}%`;
    query  += ' AND (subject LIKE ? OR id LIKE ? OR owner_email LIKE ? OR name LIKE ?)';
    countQ += ' AND (subject LIKE ? OR id LIKE ? OR owner_email LIKE ? OR name LIKE ?)';
    params.push(like, like, like, like);
  }

  const total      = db.prepare(countQ).get(...params).total;
  const complaints = db.prepare(query + ' ORDER BY created_at DESC LIMIT ? OFFSET ?')
                       .all(...params, parseInt(limit), offset);

  return ok(res, { complaints, total, page: parseInt(page), limit: parseInt(limit) });
});

/**
 * GET /api/admin/complaints/:id
 * Admin can fetch any complaint by ID.
 */
app.get('/api/admin/complaints/:id', requireAdmin, (req, res) => {
  const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!complaint) return err(res, 'Complaint not found', 404);
  return ok(res, { complaint });
});

/**
 * PATCH /api/admin/complaints/:id
 * Admin updates status and/or admin note.
 * Body: { status?, note? }
 */
app.patch('/api/admin/complaints/:id', requireAdmin, (req, res) => {
  const { status, note, priority, department } = req.body;
  const validStatuses = ['Pending', 'In Progress', 'Resolved', 'Rejected'];

  const c = db.prepare('SELECT id FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return err(res, 'Complaint not found', 404);

  const updates = [];
  const vals    = [];

  if (status !== undefined) {
    if (!validStatuses.includes(status)) return err(res, 'Invalid status');
    updates.push('status = ?'); vals.push(status);
  }
  if (note       !== undefined) { updates.push('note = ?');       vals.push(note); }
  if (priority   !== undefined) { updates.push('priority = ?');   vals.push(priority); }
  if (department !== undefined) { updates.push('department = ?'); vals.push(department); }

  if (!updates.length) return err(res, 'Nothing to update');

  vals.push(req.params.id);
  db.prepare(`UPDATE complaints SET ${updates.join(', ')} WHERE id = ?`).run(...vals);

  const updated = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  return ok(res, { complaint: updated });
});

/**
 * GET /api/admin/stats
 * Dashboard numbers for admin.
 */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const total    = db.prepare("SELECT COUNT(*) as n FROM complaints").get().n;
  const pending  = db.prepare("SELECT COUNT(*) as n FROM complaints WHERE status='Pending'").get().n;
  const progress = db.prepare("SELECT COUNT(*) as n FROM complaints WHERE status='In Progress'").get().n;
  const resolved = db.prepare("SELECT COUNT(*) as n FROM complaints WHERE status='Resolved'").get().n;
  const rejected = db.prepare("SELECT COUNT(*) as n FROM complaints WHERE status='Rejected'").get().n;
  const users    = db.prepare("SELECT COUNT(*) as n FROM users WHERE role='user'").get().n;

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count FROM complaints GROUP BY category ORDER BY count DESC
  `).all();

  const byPriority = db.prepare(`
    SELECT priority, COUNT(*) as count FROM complaints GROUP BY priority
  `).all();

  return ok(res, { total, pending, progress, resolved, rejected, users, byCategory, byPriority });
});

/**
 * GET /api/admin/users
 * List all registered users.
 */
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    "SELECT id, name, email, phone, role, created_at FROM users WHERE role='user' ORDER BY created_at DESC"
  ).all();
  return ok(res, { users });
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  ComplaintDesk API running at http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     POST   /api/auth/register`);
  console.log(`     POST   /api/auth/login`);
  console.log(`     GET    /api/auth/me`);
  console.log(`     POST   /api/complaints          (user)`);
  console.log(`     GET    /api/complaints           (user — own only)`);
  console.log(`     GET    /api/complaints/:id       (user — own only)`);
  console.log(`     GET    /api/admin/complaints     (admin — all)`);
  console.log(`     GET    /api/admin/complaints/:id (admin)`);
  console.log(`     PATCH  /api/admin/complaints/:id (admin)`);
  console.log(`     GET    /api/admin/stats          (admin)`);
  console.log(`     GET    /api/admin/users          (admin)\n`);
});
