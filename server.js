// DevHub backend: zero dependencies. Needs Node 22.5+ (uses built-in SQLite).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'dev-secret-change-me';
const PUBLIC = path.join(__dirname, 'public');

const db = new DatabaseSync(path.join(__dirname, 'devhub.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS snippets (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
    lang TEXT NOT NULL, code TEXT NOT NULL, tags TEXT DEFAULT '', created TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS progress (user_id INTEGER NOT NULL, topic TEXT NOT NULL, PRIMARY KEY (user_id, topic));
`);

// ---------- Auth helpers: scrypt password hashes + signed expiring tokens ----------
const hmac = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');
const sign = payload => { const d = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${d}.${hmac(d)}`; };
function verify(token = '') {
  try {
    const [d, sig] = token.split('.'), ok = hmac(d);
    if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
    const p = JSON.parse(Buffer.from(d, 'base64url'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return `${s}:${crypto.scryptSync(pw, s, 64).toString('hex')}`; };
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, s, 64)); };
const session = u => ({ token: sign({ uid: u.id, exp: Date.now() + 7 * 864e5 }), email: u.email });

// ---------- HTTP helpers ----------
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const readBody = req => new Promise((ok, fail) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e5) { req.destroy(); fail(new Error('Request too large.')); } });
  req.on('end', () => { try { ok(JSON.parse(raw || '{}')); } catch { fail(new Error('Invalid JSON.')); } });
});
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

// ---------- API ----------
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const data = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
  const uid = (verify((req.headers.authorization || '').slice(7)) || {}).uid;
  if (!uid && !['POST /api/register', 'POST /api/login'].includes(route)) return send(res, 401, { error: 'Please log in first.' });

  if (route === 'POST /api/register') {
    const email = str(data.email, 200).toLowerCase(), pw = str(data.password, 200);
    if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return send(res, 400, { error: 'Use a valid email and a password of 8+ characters.' });
    try {
      const r = db.prepare('INSERT INTO users (email, hash) VALUES (?, ?)').run(email, hashPw(pw));
      return send(res, 201, session({ id: Number(r.lastInsertRowid), email }));
    } catch { return send(res, 409, { error: 'That email is already registered. Log in instead.' }); }
  }
  if (route === 'POST /api/login') {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(str(data.email, 200).toLowerCase());
    if (!u || !checkPw(str(data.password, 200), u.hash)) return send(res, 401, { error: 'Wrong email or password.' });
    return send(res, 200, session(u));
  }
  if (route === 'GET /api/snippets') {
    const q = `%${str(url.searchParams.get('q') || '', 100)}%`;
    return send(res, 200, db.prepare(`SELECT * FROM snippets WHERE user_id = ? AND (title LIKE ? OR tags LIKE ? OR code LIKE ?) ORDER BY id DESC`).all(uid, q, q, q));
  }
  if (route === 'POST /api/snippets') {
    const title = str(data.title, 120), lang = str(data.lang, 30), code = str(data.code, 20000);
    if (!title || !code) return send(res, 400, { error: 'Add a title and some code.' });
    const r = db.prepare('INSERT INTO snippets (user_id, title, lang, code, tags) VALUES (?,?,?,?,?)').run(uid, title, lang || 'text', code, str(data.tags, 120));
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  const del = url.pathname.match(/^\/api\/snippets\/(\d+)$/);
  if (req.method === 'DELETE' && del) {
    db.prepare('DELETE FROM snippets WHERE id = ? AND user_id = ?').run(del[1], uid);
    return send(res, 200, { ok: true });
  }
  if (route === 'GET /api/progress') return send(res, 200, db.prepare('SELECT topic FROM progress WHERE user_id = ?').all(uid).map(r => r.topic));
  if (route === 'POST /api/progress') {
    const topic = str(data.topic, 80);
    const had = db.prepare('DELETE FROM progress WHERE user_id = ? AND topic = ?').run(uid, topic).changes;
    if (!had) db.prepare('INSERT INTO progress (user_id, topic) VALUES (?, ?)').run(uid, topic);
    return send(res, 200, { done: !had });
  }
  send(res, 404, { error: 'Not found.' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) { send(res, 400, { error: e.message || 'Bad request.' }); }
}).listen(PORT, () => console.log(`DevHub running at http://localhost:${PORT}`));
