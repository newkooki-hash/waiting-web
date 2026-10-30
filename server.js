// 오란다 볼링 대기 접수 MVP: 의존성 없음 (node:http + node:sqlite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const oauth = require('./oauth');
const sms = require('./sms');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_HOST = process.env.ADMIN_HOST; // 예: admin.orandabowling.co.kr. 비우면 호스트 구분 없음(개발용)
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
try { db.exec('ALTER TABLE entries ADD COLUMN user_id INTEGER'); } catch {}
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (provider, provider_id)
);
CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sms_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);`);
try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN phone_verified_at TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users(phone) WHERE phone IS NOT NULL');

// 접수 설정: 접수 on/off, QR에 담기는 접수 토큰
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const newIntakeToken = () => crypto.randomBytes(16).toString('hex');
if (getSetting('intake_open') === undefined) setSetting('intake_open', '1');
if (getSetting('intake_token') === undefined) setSetting('intake_token', newIntakeToken());
const intakeSwitch = () => getSetting('intake_open') === '1'; // 수동 스위치
// 접수 가능 시간대: 시작 > 종료이면 자정을 넘기는 시간대(예: 18:00~02:00)로 본다. 서버 시간대 기준
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const schedule = () => ({ enabled: getSetting('intake_schedule') === '1', start: getSetting('intake_start') || '10:00', end: getSetting('intake_end') || '22:00' });
const inWindow = (min, start, end) => {
  const s = toMin(start), e = toMin(end);
  return s <= e ? min >= s && min < e : min >= s || min < e;
};
const intakeOpen = (now = new Date()) => {
  if (!intakeSwitch()) return false;
  const sc = schedule();
  return !sc.enabled || inWindow(now.getHours() * 60 + now.getMinutes(), sc.start, sc.end);
};
const outsideWindow = () => { // 스위치는 켜져 있는데 시간대 밖일 때 안내할 시간대
  const sc = schedule();
  return intakeSwitch() && sc.enabled && !intakeOpen() ? `${sc.start}~${sc.end}` : null;
};
const INTAKE_COOKIE_AGE = 12 * 3600; // QR을 스캔한 기기는 12시간 동안 접수 가능

// 인증번호 정책: 6자리, 5분 유효, 재발송 60초 간격, 계정당 24시간 5회, 오입력 5회
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_SENDS_PER_DAY = 5; // 계정당
// 번호당 일일 발송 한도 (PRD 4.5)
const MAX_SENDS_PER_PHONE = Number(process.env.SMS_MAX_PER_PHONE_DAY) || 5;
const MAX_ATTEMPTS = 5;
const CODE_SECRET = process.env.CODE_SECRET || crypto.randomBytes(32).toString('hex');
const hashCode = (code) => crypto.createHmac('sha256', CODE_SECRET).update(code).digest('hex');
const maskPhone = (p) => p && `${p.slice(0, 3)}-****-${p.slice(-4)}`;

const ACTIVE = "('WAITING','CALLED')"; // 중복 접수 판단: 배정 완료되면 다시 접수 가능
// 관리자 세션: DB에 저장하고 쿠키로 유지한다. 사용할 때마다 만료가 7일 뒤로 밀린다(롤링)
db.exec('CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
const ADMIN_SESSION_MS = 7 * 24 * 3600 * 1000;
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
const hasIntakeToken = (req) => {
  const c = Buffer.from(cookie(req, 'intake') || ''), t = Buffer.from(getSetting('intake_token'));
  return c.length === t.length && crypto.timingSafeEqual(c, t);
};
// 접수(SMS 발송·대기 등록) 가능 여부. 불가하면 응답을 보내고 true를 돌려준다.
const intakeBlocked = (req, res) => {
  if (!intakeOpen()) {
    const w = outsideWindow();
    return json(res, 403, { error: w ? `접수 가능 시간은 ${w}입니다.` : '지금은 접수 중이 아닙니다.', code: 'INTAKE_CLOSED' }), true;
  }
  if (!hasIntakeToken(req)) return json(res, 403, { error: '매장의 QR 코드를 스캔해 접수해 주세요.', code: 'QR_REQUIRED' }), true;
  return false;
};
const SECURE = oauth.BASE_URL.startsWith('https') ? '; Secure' : '';
const adminCookie = (token) => `admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}${SECURE}`;
const isAdmin = (req) => {
  const t = cookie(req, 'admin');
  return !!t && !!db.prepare('SELECT 1 FROM admin_sessions WHERE token=? AND expires_at > ?').get(t, Date.now());
};
const currentUser = (req) => {
  const sid = cookie(req, 'sid');
  return sid ? db.prepare('SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(sid) : undefined;
};
const redirect = (res, to, cookies = []) => {
  res.writeHead(302, { Location: to, 'Set-Cookie': cookies });
  res.end();
};

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
  'GET /api/me': async (req, res) => {
    const u = currentUser(req);
    const active = u && db.prepare(`SELECT token FROM entries WHERE user_id=? AND status IN ${ACTIVE}`).get(u.id);
    json(res, 200, {
      user: u ? { name: u.name, provider: u.provider, phone: maskPhone(u.phone) } : null,
      activeToken: active?.token || null,
      intake: { open: intakeOpen(), allowed: hasIntakeToken(req), window: outsideWindow() },
      providers: oauth.enabled().map((k) => ({ id: k, label: oauth.providers[k].label })),
    });
  },
  'POST /api/logout': async (req, res) => {
    db.prepare('DELETE FROM user_sessions WHERE token=?').run(cookie(req, 'sid') || '');
    res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
    json(res, 200, { ok: true });
  },
  'POST /api/phone/send': async (req, res) => {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    if (intakeBlocked(req, res)) return;
    const phone = String((await readBody(req)).phone || '').replace(/\D/g, '');
    if (!/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' });
    const owner = db.prepare('SELECT id FROM users WHERE phone=? AND id<>?').get(phone, user.id);
    if (owner) return json(res, 409, { error: '이미 다른 계정에서 인증된 번호입니다.' });
    const now = Date.now();
    const last = db.prepare('SELECT created_at FROM sms_codes WHERE user_id=? ORDER BY id DESC LIMIT 1').get(user.id);
    if (last && now - last.created_at < RESEND_MS)
      return json(res, 429, { error: '잠시 후 다시 요청해 주세요.', retryAfter: Math.ceil((RESEND_MS - (now - last.created_at)) / 1000) });
    const sent = db.prepare('SELECT COUNT(*) n FROM sms_codes WHERE user_id=? AND created_at > ?').get(user.id, now - 24 * 3600 * 1000).n;
    if (sent >= MAX_SENDS_PER_DAY) return json(res, 429, { error: '오늘 인증 요청 횟수를 초과했습니다.' });
    const phoneSent = db.prepare('SELECT COUNT(*) n FROM sms_codes WHERE phone=? AND created_at > ?').get(phone, now - 24 * 3600 * 1000).n;
    if (phoneSent >= MAX_SENDS_PER_PHONE) return json(res, 429, { error: '오늘 인증 요청 횟수를 초과했습니다.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    // 발송 실패 시에도 기록을 남겨 비용이 드는 반복 요청을 막는다
    const row = db.prepare('INSERT INTO sms_codes (user_id,phone,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(user.id, phone, hashCode(code), now + CODE_TTL_MS, now);
    try { await sms.send(phone, `[오란다볼링] 인증번호 ${code} (5분 이내 입력)`); }
    catch (err) {
      console.error('sms send failed:', err.message);
      db.prepare('UPDATE sms_codes SET used=1 WHERE id=?').run(row.lastInsertRowid);
      return json(res, 502, { error: '문자 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
    json(res, 200, { ok: true, expiresIn: CODE_TTL_MS / 1000 });
  },
  'POST /api/phone/verify': async (req, res) => {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const code = String((await readBody(req)).code || '').trim();
    const row = db.prepare('SELECT * FROM sms_codes WHERE user_id=? AND used=0 ORDER BY id DESC LIMIT 1').get(user.id);
    if (!row || row.expires_at < Date.now()) return json(res, 400, { error: '인증번호가 만료되었습니다. 다시 요청해 주세요.' });
    if (row.attempts >= MAX_ATTEMPTS) return json(res, 429, { error: '입력 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요.' });
    db.prepare('UPDATE sms_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    const a = Buffer.from(hashCode(code)), b = Buffer.from(row.code_hash);
    if (!crypto.timingSafeEqual(a, b)) return json(res, 400, { error: '인증번호가 일치하지 않습니다.' });
    try {
      db.prepare("UPDATE users SET phone=?, phone_verified_at=datetime('now','localtime') WHERE id=?").run(row.phone, user.id);
    } catch { return json(res, 409, { error: '이미 다른 계정에서 인증된 번호입니다.' }); }
    db.prepare('UPDATE sms_codes SET used=1 WHERE user_id=?').run(user.id);
    json(res, 200, { ok: true, phone: maskPhone(row.phone) });
  },
  'POST /api/entries': async (req, res) => {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    if (intakeBlocked(req, res)) return;
    if (!user.phone) return json(res, 403, { error: '휴대전화 인증이 필요합니다.', code: 'PHONE_REQUIRED' });
    const b = await readBody(req);
    const name = String(b.name || user.name).trim().slice(0, 20);
    const phone = user.phone; // 인증된 번호만 사용
    const party = Number(b.partySize);
    if (!name) return json(res, 400, { error: '이름을 입력하세요.' });
    if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY)
      return json(res, 400, { error: `인원은 1~${MAX_PARTY}명입니다.` });
    const dup = db.prepare(`SELECT token FROM entries WHERE (user_id=? OR phone=?) AND status IN ${ACTIVE}`).get(user.id, phone);
    if (dup) return json(res, 409, { error: '이미 접수된 대기가 있습니다.', token: dup.token });
    const token = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO entries (token,name,phone,party_size,user_id) VALUES (?,?,?,?,?)').run(token, name, phone, party, user.id);
    notify();
    json(res, 201, { token });
  },
  'POST /api/admin/login': async (req, res) => {
    const b = await readBody(req);
    if (b.password !== ADMIN_PASSWORD) return json(res, 401, { error: '비밀번호가 틀렸습니다.' });
    const s = crypto.randomBytes(24).toString('hex');
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO admin_sessions (token,expires_at) VALUES (?,?)').run(s, Date.now() + ADMIN_SESSION_MS);
    res.setHeader('Set-Cookie', adminCookie(s));
    json(res, 200, { ok: true });
  },
  'GET /api/admin/intake': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { open: intakeSwitch(), openNow: intakeOpen(), schedule: schedule(), url: `${oauth.BASE_URL}/?t=${getSetting('intake_token')}` });
  },
  'POST /api/admin/intake/open': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    setSetting('intake_open', (await readBody(req)).open ? '1' : '0');
    json(res, 200, { open: intakeSwitch() });
  },
  'POST /api/admin/intake/schedule': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    if (b.enabled && (!HHMM.test(b.start) || !HHMM.test(b.end) || b.start === b.end))
      return json(res, 400, { error: '시작·종료 시각을 HH:MM 형식으로, 서로 다르게 입력하세요.' });
    setSetting('intake_schedule', b.enabled ? '1' : '0');
    if (b.enabled) { setSetting('intake_start', b.start); setSetting('intake_end', b.end); }
    json(res, 200, { schedule: schedule(), openNow: intakeOpen() });
  },
  'POST /api/admin/intake/rotate': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    setSetting('intake_token', newIntakeToken());
    json(res, 200, { url: `${oauth.BASE_URL}/?t=${getSetting('intake_token')}` });
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
  // ADMIN_HOST가 있으면 관리자 호스트는 관리자 화면·API만, 그 외 호스트는 관리자 경로를 막는다.
  if (ADMIN_HOST) {
    const isAdminPath = /^\/(admin(\.html)?|qrcode\.js|api\/admin\/.*)$/.test(url.pathname);
    const onAdminHost = (req.headers.host || '').split(':')[0] === ADMIN_HOST;
    if (onAdminHost) {
      if (url.pathname === '/') url.pathname = '/admin';
      else if (!isAdminPath && url.pathname !== '/api/events') return json(res, 404, { error: 'not found' });
    } else if (isAdminPath) return json(res, 404, { error: 'not found' });
  }
  const adminToken = cookie(req, 'admin');
  if (adminToken && isAdmin(req)) { // 롤링: 쓸 때마다 만료와 쿠키를 7일 뒤로 연장
    db.prepare('UPDATE admin_sessions SET expires_at=? WHERE token=?').run(Date.now() + ADMIN_SESSION_MS, adminToken);
    res.setHeader('Set-Cookie', adminCookie(adminToken));
  }
  const route = `${req.method} ${url.pathname}`;
  try {
    if (api[route]) return await api[route](req, res);

    // 매장 QR(/?t=토큰): 맞으면 접수 쿠키를 심고 주소에서 토큰을 지운다
    if (route === 'GET /' && url.searchParams.has('t')) {
      const ok = url.searchParams.get('t') === getSetting('intake_token');
      return redirect(res, ok ? '/' : '/?qr=invalid', ok
        ? [`intake=${getSetting('intake_token')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${INTAKE_COOKIE_AGE}${SECURE}`] : []);
    }

    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      listeners.add(res);
      return req.on('close', () => listeners.delete(res));
    }
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/auth\/(kakao|naver)(\/callback)?$/))) {
      const name = m[1];
      if (!oauth.enabled().includes(name)) return redirect(res, '/?login=disabled');
      if (!m[2]) {
        const state = crypto.randomBytes(16).toString('hex');
        return redirect(res, oauth.authorizeUrl(name, state),
          [`oauth_state=${name}.${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${SECURE}`]);
      }
      const state = url.searchParams.get('state');
      const clear = `oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`;
      if (!state || cookie(req, 'oauth_state') !== `${name}.${state}` || !url.searchParams.get('code'))
        return redirect(res, '/?login=failed', [clear]);
      let profile;
      try { profile = await oauth.fetchProfile(name, url.searchParams.get('code'), state); }
      catch (err) { console.error(name, 'login failed:', err.message); return redirect(res, '/?login=failed', [clear]); }
      db.prepare('INSERT INTO users (provider,provider_id,name) VALUES (?,?,?) ON CONFLICT(provider,provider_id) DO UPDATE SET name=excluded.name')
        .run(name, profile.id, profile.name || '손님');
      const u = db.prepare('SELECT id FROM users WHERE provider=? AND provider_id=?').get(name, profile.id);
      const sid = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO user_sessions (token,user_id) VALUES (?,?)').run(sid, u.id);
      return redirect(res, '/', [clear, `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7776000${SECURE}`]);
    }
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
server.oauth = oauth;
module.exports = server;
