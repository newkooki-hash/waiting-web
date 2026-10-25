// 오란다 볼링 대기 접수 MVP: 의존성 없음 (node:http + node:sqlite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const LANES = 18;
const MAX_PARTY = 8;
const PUBLIC = path.join(__dirname, 'public');

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'waiting.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING',
  lanes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  called_at TEXT,
  finished_at TEXT
);`);
try { db.exec('ALTER TABLE entries ADD COLUMN assigned_at TEXT'); } catch {} // 기존 DB 보강

const ACTIVE = "('WAITING','CALLED')"; // 중복 접수 판단: 배정 완료되면 다시 접수 가능
const sessions = new Set();
const listeners = new Set();
const notify = () => listeners.forEach((res) => res.write('data: changed\n\n'));

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
const cookie = (req, name) =>
  (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const isAdmin = (req) => sessions.has(cookie(req, 'admin'));

const publicView = (e) => ({
  token: e.token,
  name: e.name,
  partySize: e.party_size,
  status: e.status,
  lanes: e.lanes,
  position: e.status === 'WAITING' || e.status === 'CALLED'
    ? db.prepare("SELECT COUNT(*) n FROM entries WHERE status IN ('WAITING','CALLED') AND id < ?").get(e.id).n + 1
    : null,
});

// 상태 전이: 허용되는 이전 상태
const TRANSITIONS = {
  call: { from: ['WAITING'], to: 'CALLED' },
  assign: { from: ['WAITING', 'CALLED'], to: 'ASSIGNED' },
  finish: { from: ['ASSIGNED'], to: 'FINISHED' },
  cancel: { from: ['WAITING', 'CALLED', 'ASSIGNED'], to: 'CANCELED' },
};

const api = {
  'POST /api/entries': async (req, res) => {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 20);
    const phone = String(b.phone || '').replace(/\D/g, '');
    const party = Number(b.partySize);
    if (!name) return json(res, 400, { error: '이름을 입력하세요.' });
    if (!/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' });
    if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY)
      return json(res, 400, { error: `인원은 1~${MAX_PARTY}명입니다.` });
    const dup = db.prepare(`SELECT token FROM entries WHERE phone=? AND status IN ${ACTIVE}`).get(phone);
    if (dup) return json(res, 409, { error: '이미 접수된 대기가 있습니다.', token: dup.token });
    const token = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO entries (token,name,phone,party_size) VALUES (?,?,?,?)').run(token, name, phone, party);
    notify();
    json(res, 201, { token });
  },
  'POST /api/admin/login': async (req, res) => {
    const b = await readBody(req);
    if (b.password !== ADMIN_PASSWORD) return json(res, 401, { error: '비밀번호가 틀렸습니다.' });
    const s = crypto.randomBytes(24).toString('hex');
    sessions.add(s);
    res.setHeader('Set-Cookie', `admin=${s}; HttpOnly; SameSite=Strict; Path=/`);
    json(res, 200, { ok: true });
  },
  'GET /api/admin/entries': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const rows = db.prepare(`SELECT * FROM entries WHERE status IN ${ACTIVE}
      OR (status='ASSIGNED' AND date(assigned_at)=date('now','localtime')) ORDER BY id`).all();
    json(res, 200, {
      lanes: LANES,
      entries: rows.map((e) => ({
        id: e.id, name: e.name, phone: e.phone, partySize: e.party_size,
        status: e.status, lanes: e.lanes, createdAt: e.created_at, assignedAt: e.assigned_at,
      })),
    });
  },
};

async function handleAction(req, res, id, action) {
  if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
  const t = TRANSITIONS[action];
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
  if (!t || !e) return json(res, 404, { error: 'not found' });
  if (!t.from.includes(e.status)) return json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` });
  let lanes = e.lanes;
  if (action === 'assign') {
    const b = await readBody(req);
    const picked = [...new Set(String(b.lanes || '').split(',').map((s) => Number(s.trim())))];
    if (!picked.length || picked.some((n) => !Number.isInteger(n) || n < 1 || n > LANES))
      return json(res, 400, { error: `레인은 1~${LANES} 번호로 입력하세요. 예: 5,6` });
    lanes = picked.sort((a, c) => a - c).join(',');
  }
  const now = "datetime('now','localtime')";
  db.prepare(`UPDATE entries SET status=?, lanes=?,
    assigned_at = CASE WHEN ?='assign' THEN ${now} ELSE assigned_at END,
    called_at = CASE WHEN ?='call' THEN ${now} ELSE called_at END,
    finished_at = CASE WHEN ? IN ('finish','cancel') THEN ${now} ELSE finished_at END
    WHERE id=?`).run(t.to, lanes, action, action, action, id);
  notify();
  json(res, 200, { ok: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (api[route]) return await api[route](req, res);

    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      listeners.add(res);
      return req.on('close', () => listeners.delete(res));
    }
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/entries\/([0-9a-f]+)$/))) {
      const e = db.prepare('SELECT * FROM entries WHERE token=?').get(m[1]);
      return e ? json(res, 200, publicView(e)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/entries\/([0-9a-f]+)\/cancel$/))) {
      const e = db.prepare('SELECT * FROM entries WHERE token=?').get(m[1]);
      if (!e) return json(res, 404, { error: 'not found' });
      if (e.status !== 'WAITING' && e.status !== 'CALLED')
        return json(res, 409, { error: '취소할 수 없는 상태입니다.' });
      db.prepare("UPDATE entries SET status='CANCELED', finished_at=datetime('now','localtime') WHERE id=?").run(e.id);
      notify();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/(\w+)$/)))
      return await handleAction(req, res, Number(m[1]), m[2]);

    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname.slice(1);
      const full = path.join(PUBLIC, file);
      if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(full));
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}  (관리자: /admin)`);
    if (!process.env.ADMIN_PASSWORD) console.log('주의: 기본 관리자 비밀번호 사용 중. ADMIN_PASSWORD 환경변수를 설정하세요.');
  });
}
module.exports = server;
