// 오란다 볼링 대기 접수 MVP: 의존성 없음 (node:http + node:sqlite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const oauth = require('./oauth');
const sms = require('./sms');

const PORT = process.env.PORT || 3000;
// 관리자는 운영자 공용 계정 하나(아이디+비밀번호)를 함께 쓴다. 권한 구분 없음
const ADMIN_ID = process.env.ADMIN_ID || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const sameSecret = (a, b) => { // 길이와 상관없이 같은 시간에 비교한다
  const h = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};
const ADMIN_HOST = process.env.ADMIN_HOST; // 예: admin.orandabowling.co.kr. 비우면 호스트 구분 없음(개발용)
const LANES = 18;
const MAX_PARTY = 8;
const VISIT_MONTHS = 3; // 관리자 화면에 보여 주는 최근 방문 횟수의 기간
const PUBLIC = path.join(__dirname, 'dist'); // npm run build 결과물(web/ 소스)

// 전화번호 암호화 저장: 같은 번호는 항상 같은 암호문이 되는 결정적 암호화(AES-256-GCM, IV는 번호의 HMAC).
// 그래서 중복 확인·유니크 인덱스·`phone=?` 조회가 그대로 동작한다. 저장은 ep(), 읽기는 dp()를 쓴다.
// 키(PHONE_KEY)를 잃으면 번호를 복구할 수 없으므로 서버 환경변수와 별도로 안전하게 보관할 것.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'waiting.db');
if (!process.env.PHONE_KEY && DB_FILE !== ':memory:') throw new Error('PHONE_KEY 환경변수가 필요합니다. (전화번호 암호화 키, 임의의 긴 문자열)');
const PHONE_KEY = process.env.PHONE_KEY || crypto.randomBytes(32).toString('hex');
const subkey = (label) => crypto.createHash('sha256').update(`${label}:${PHONE_KEY}`).digest();
const ENC_KEY = subkey('phone-enc'), IV_KEY = subkey('phone-iv');
const ENC_PREFIX = 'e1:';
const ep = (plain) => {
  if (!plain || plain.startsWith(ENC_PREFIX)) return plain;
  const iv = crypto.createHmac('sha256', IV_KEY).update(plain).digest().subarray(0, 12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
};
const dp = (stored) => {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored; // 암호화 전 값은 그대로 돌려준다
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
};

const db = new DatabaseSync(DB_FILE);
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
try { db.exec('ALTER TABLE entries ADD COLUMN memo TEXT'); } catch {}
try { db.exec('ALTER TABLE entries ADD COLUMN cancel_reason TEXT'); } catch {}
// 호출 기능 삭제(2026-11-07, 카운터 직접 호출): 예전 호출 상태는 대기로 돌린다. called_at 열은 쓰지 않는다
db.exec("UPDATE entries SET status='WAITING', called_at=NULL WHERE status='CALLED'");
// (아래 도착 인증 백필보다 먼저 실행해야 호출 중이던 건도 도착 처리된다)
try { db.exec('ALTER TABLE entries ADD COLUMN arrival_method TEXT'); } catch {} // 도착 확인 방법: 모두 staff(직원 확인·수기 등록). 예전 qr 값은 쓰지 않는다
try {
  db.exec('ALTER TABLE entries ADD COLUMN arrived_at TEXT'); // 도착 인증 시각. 비어 있으면 미도착
  // 처음 적용할 때 이미 대기 중인 건은 도착한 것으로 보아 배포 직후 한꺼번에 자동 취소되지 않게 한다
  db.exec("UPDATE entries SET arrived_at=datetime('now','localtime'), arrival_method='staff' WHERE status='WAITING'");
} catch {}
try { db.exec('ALTER TABLE entries ADD COLUMN shoes INTEGER'); } catch {} // 신발 대여 인원(0~인원). 비어 있으면 입력되지 않은 건
// 신발 대여 인원 검사: 비어 있으면 null(미입력), 정수이고 0~인원이면 그 값, 아니면 NaN
const parseShoes = (v, party) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= party ? n : NaN;
};
const shoesError = (party) => ({ error: `신발 대여는 0~${party}명이며 인원을 넘을 수 없습니다.` });
// 블랙리스트: 전화번호 기준으로 접수를 막는다. 사유(메모)는 관리자만 본다
db.exec(`CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
const isBlacklisted = (phone) => !!phone && !!db.prepare('SELECT 1 FROM blacklist WHERE phone=?').get(ep(phone));
const BLACKLISTED = { error: '접수할 수 없습니다. 매장 직원에게 문의해 주세요.', code: 'BLACKLISTED' };
// 이미 등록된 번호면 사유를 갱신한다. 대기 중인 건은 함께 취소한다
const addBlacklist = (phone, name, reason) => {
  db.prepare(`INSERT INTO blacklist (phone,name,reason) VALUES (?,?,?)
    ON CONFLICT(phone) DO UPDATE SET reason=excluded.reason, name=COALESCE(excluded.name, name)`).run(ep(phone), name || null, reason);
  db.prepare(`UPDATE entries SET status='CANCELED', cancel_reason='블랙리스트', finished_at=datetime('now','localtime')
    WHERE phone=? AND status='WAITING'`).run(ep(phone));
  notify();
};
// 회원: 현행 시스템에서 가져온 회원(이관)과 신규 가입자(가입)를 한 목록으로 관리한다.
// 소셜 계정이 번호 인증을 마치면 같은 번호의 회원과 연결된다(없으면 새 회원으로 추가)
db.exec(`CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  gender TEXT,
  birth_year INTEGER,
  joined_at TEXT,
  source TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS pii_view_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  member_id INTEGER NOT NULL,
  ip TEXT,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
try { db.exec("ALTER TABLE pii_view_log ADD COLUMN target TEXT NOT NULL DEFAULT 'member'"); } catch {} // member_id는 target 종류별 대상 id
try { db.exec('ALTER TABLE pii_view_log ADD COLUMN reason TEXT'); } catch {}
try { db.exec("ALTER TABLE members ADD COLUMN tier TEXT NOT NULL DEFAULT '일반'"); } catch {}
try { db.exec('ALTER TABLE members ADD COLUMN verified_at TEXT'); } catch {}
try { db.exec('ALTER TABLE members ADD COLUMN birth_date TEXT'); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS member_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
// 정회원 정보(생년월일·성별·등급)를 바꿀 때마다 남기는 기록. 값이 같으면 남기지 않는다
const logChange = (memberId, field, oldV, newV, by) => {
  if (String(oldV ?? '') === String(newV ?? '')) return;
  db.prepare('INSERT INTO member_change_log (member_id,field,old_value,new_value,changed_by) VALUES (?,?,?,?,?)').run(memberId, field, oldV ?? null, newV ?? null, by);
};
const GENDER_LABEL = { m: '남', f: '여' };
const validDate = (v) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && v <= new Date().toLocaleDateString('sv');
};
try { db.exec('ALTER TABLE members ADD COLUMN last_used_at TEXT'); } catch {}
// 마지막 이용일: 로그인·접수·대회 신청·정회원 정보 저장 때 기록한다(자동 삭제에는 쓰지 않는다)
const touchUser = (userId) => db.prepare("UPDATE members SET last_used_at=datetime('now','localtime') WHERE user_id=?").run(userId);
const touchPhone = (phone) => phone && db.prepare("UPDATE members SET last_used_at=datetime('now','localtime') WHERE phone=?").run(ep(phone));
const FULL = '정회원';
const isFullMember = (userId, phone) => !!db.prepare('SELECT 1 FROM members WHERE tier=? AND (user_id=? OR phone=?)').get(FULL, userId ?? -1, ep(phone ?? ''));
const NOT_FULL = { error: '대회는 정회원만 신청할 수 있습니다. 생년월일과 성별을 입력해 정회원으로 가입해 주세요.', code: 'MEMBER_REQUIRED' };
const memberFor = (user) => {
  let m = db.prepare('SELECT * FROM members WHERE user_id=? OR phone=?').get(user.id, ep(user.phone));
  if (!m) {
    db.prepare("INSERT INTO members (name,phone,joined_at,source,user_id) VALUES (?,?,datetime('now','localtime'),'가입',?)").run(user.name, ep(user.phone), user.id);
    m = db.prepare('SELECT * FROM members WHERE phone=?').get(ep(user.phone));
  } else if (!m.user_id) db.prepare('UPDATE members SET user_id=? WHERE id=?').run(user.id, m.id);
  return m;
};
const linkMember = (user, phone) => {
  if (db.prepare('UPDATE members SET user_id=? WHERE phone=?').run(user.id, ep(phone)).changes) return;
  db.prepare("INSERT INTO members (name,phone,joined_at,source,user_id) VALUES (?,?,datetime('now','localtime'),'가입',?)").run(user.name, ep(phone), user.id);
};
// 대기 순서(seq): 접수 순으로 늘어나고, 양보·맨뒤로 보내기가 이 값을 바꾼다
try { db.exec('ALTER TABLE entries ADD COLUMN seq INTEGER'); } catch {}
db.exec(`UPDATE entries SET seq=id WHERE seq IS NULL;
CREATE TRIGGER IF NOT EXISTS entries_seq AFTER INSERT ON entries WHEN NEW.seq IS NULL BEGIN
  UPDATE entries SET seq=(SELECT COALESCE(MAX(seq),0)+1 FROM entries) WHERE id=NEW.id;
END;`);
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

// 통합회원: 한 회원이 카카오·네이버 소셜 계정을 둘 다 연결할 수 있다.
// 같은 번호를 SMS로 인증한 서로 다른 플랫폼 계정은 사용자가 동의하면 한 회원으로 합친다(번호 인증이 본인 확인 역할).
db.exec(`CREATE TABLE IF NOT EXISTS user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (provider, provider_id)
)`);
db.exec('INSERT OR IGNORE INTO user_identities (user_id,provider,provider_id,created_at) SELECT id,provider,provider_id,created_at FROM users');
try { db.exec('ALTER TABLE sms_codes ADD COLUMN verified_at INTEGER'); } catch {} // 번호 인증은 맞았지만 통합 확인을 기다리는 코드
const identityOwner = (provider, pid) => db.prepare('SELECT user_id FROM user_identities WHERE provider=? AND provider_id=?').get(provider, pid)?.user_id;
const providersOf = (userId) => db.prepare('SELECT provider FROM user_identities WHERE user_id=? ORDER BY id').all(userId).map((r) => r.provider);
// 같은 플랫폼 계정끼리는 합치지 않는다(같은 번호를 쓰는 다른 사람·중복 계정 방지)
const shareProvider = (a, b) => { const pa = providersOf(a); return providersOf(b).some((p) => pa.includes(p)); };
const MERGE_TABLES = ['entries', 'tournament_entries', 'consents', 'user_sessions']; // user_id를 가진 기록은 기존 회원으로 옮긴다
const mergeUsers = (ownerId, fromId) => {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE user_identities SET user_id=? WHERE user_id=?').run(ownerId, fromId);
    MERGE_TABLES.forEach((t) => db.prepare(`UPDATE ${t} SET user_id=? WHERE user_id=?`).run(ownerId, fromId));
    db.prepare('DELETE FROM sms_codes WHERE user_id=?').run(fromId);
    db.prepare('DELETE FROM users WHERE id=?').run(fromId);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
};

// 접수 설정: 접수 on/off, QR에 담기는 접수 토큰
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
if (getSetting('intake_open') === undefined) setSetting('intake_open', '1');
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
// 도착 확인(PRD 4.3): 접수 후 ARRIVAL_LIMIT_MIN분 안에 카운터에서 직원이 도착 확인을 하지 않으면 '도착 만료(EXPIRED)' 상태로 바뀐다.
// 취소(CANCELED)와 다른 상태이고, 타이머 없이 대기 목록·조회 요청 때마다 접수 시각과 비교해 바꾼다.
// 만료 시각(finished_at)은 처리한 시각이 아니라 접수+N분이다. 직원의 도착 확인과 겹쳐도 arrived_at 조건 덕분에 도착이 이긴다.
const ARRIVAL_LIMIT_MIN = Number(process.env.ARRIVAL_LIMIT_MIN) || 15;
const expireUnarrived = () => {
  const due = `status='WAITING' AND arrived_at IS NULL AND created_at <= datetime('now','localtime','-' || ? || ' minutes')`;
  const phones = db.prepare(`SELECT DISTINCT phone FROM entries WHERE ${due} AND phone IS NOT NULL`).all(ARRIVAL_LIMIT_MIN).map((r) => r.phone);
  const n = db.prepare(`UPDATE entries SET status='EXPIRED', finished_at=datetime(created_at, '+' || ? || ' minutes') WHERE ${due}`).run(ARRIVAL_LIMIT_MIN, ARRIVAL_LIMIT_MIN).changes;
  if (n) { phones.forEach(evaluateNoshow); notify(); }
  return n;
};

// 반복 미도착 접수 제한(PRD 4.4.1, 결정 25): 번호 기준으로 최근 NOSHOW_DAYS일 안 '도착 만료(EXPIRED)'가 NOSHOW_COUNT회가 되면
// NOSHOW_BAN_DAYS일간 접수를 제한한다. 본인·직원 취소는 세지 않고, 직원이 도착 확인으로 복구한 건은 EXPIRED가 아니므로 자동 제외된다.
// 제한이 끝나거나 직원이 해제·초기화하면 그 시각 이후의 만료만 센다. 모든 수치는 설정값이다.
// 베타 기간(NOSHOW_ENFORCE 가 1이 아닐 때)에는 집계·표시만 하고 접수를 막지 않는다.
const NOSHOW_COUNT = Number(process.env.NOSHOW_COUNT) || 3;
const NOSHOW_DAYS = Number(process.env.NOSHOW_DAYS) || 30;
const NOSHOW_BAN_DAYS = Number(process.env.NOSHOW_BAN_DAYS) || 7;
let NOSHOW_ENFORCE = process.env.NOSHOW_ENFORCE === '1';
try { db.exec('ALTER TABLE entries ADD COLUMN noshow_excluded INTEGER NOT NULL DEFAULT 0'); } catch {} // 오처리 제외(1이면 집계하지 않음)
db.exec(`CREATE TABLE IF NOT EXISTS intake_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS noshow_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  phone TEXT NOT NULL,
  action TEXT NOT NULL,
  entry_id INTEGER,
  limit_id INTEGER
)`);
const noshowLog = (phone, action, entryId = null, limitId = null) =>
  db.prepare('INSERT INTO noshow_log (phone,action,entry_id,limit_id) VALUES (?,?,?,?)').run(phone, action, entryId, limitId);
// 집계 시작 시각 이후의 만료만 센다: 최근 N일, 마지막 제한 종료·해제, 마지막 초기화 중 가장 늦은 시각
const NOSHOW_FROM = `MAX(datetime('now','localtime','-${NOSHOW_DAYS} days'),
  COALESCE((SELECT MAX(COALESCE(released_at, ends_at)) FROM intake_limits WHERE phone=@p AND COALESCE(released_at, ends_at) <= datetime('now','localtime')), ''),
  COALESCE((SELECT MAX(at) FROM noshow_log WHERE phone=@p AND action='reset'), ''))`;
const noshowEntries = (phone) => db.prepare(`SELECT id, finished_at FROM entries WHERE phone=@p AND status='EXPIRED' AND noshow_excluded=0
  AND finished_at > ${NOSHOW_FROM} ORDER BY finished_at`).all({ p: phone }); // phone은 저장된(암호화된) 값
const activeLimit = (phone) => db.prepare("SELECT * FROM intake_limits WHERE phone=? AND released_at IS NULL AND ends_at > datetime('now','localtime') ORDER BY id DESC").get(phone);
const evaluateNoshow = (phone) => { // 횟수에 도달했고 진행 중인 제한이 없으면 제한을 만든다
  if (!phone || activeLimit(phone)) return;
  const list = noshowEntries(phone);
  if (list.length < NOSHOW_COUNT) return;
  const r = db.prepare("INSERT INTO intake_limits (phone,starts_at,ends_at) VALUES (?,?,datetime(?, '+' || ? || ' days'))").run(phone, list.at(-1).finished_at, list.at(-1).finished_at, NOSHOW_BAN_DAYS);
  noshowLog(phone, 'limit', null, Number(r.lastInsertRowid));
};
// 손님에게 보여 줄 상태: 경고(마지막 한 번 남음)와 제한(시행 중일 때만 until)
const noshowStatus = (phoneStored) => {
  if (!phoneStored) return { count: 0, warn: false, until: null, left: NOSHOW_COUNT, banDays: NOSHOW_BAN_DAYS };
  evaluateNoshow(phoneStored);
  const count = noshowEntries(phoneStored).length;
  const lim = NOSHOW_ENFORCE ? activeLimit(phoneStored) : null;
  return { count, warn: !lim && count >= 1 && count < NOSHOW_COUNT, left: Math.max(0, NOSHOW_COUNT - count), until: lim ? lim.ends_at.slice(0, 10) : null, banDays: NOSHOW_BAN_DAYS };
};

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
const maskEmail = (e) => { // abc@x.com → a**@x.com
  if (!e) return '';
  const [id, host = ''] = e.split('@');
  return `${id.slice(0, 1)}${'*'.repeat(Math.max(2, id.length - 1))}@${host}`;
};
// 현행 회원의 출생연도는 직접 입력한 글이라 "2001.04.11", "2005년 8월 1일" 같은 값이 섞여 있다.
// 앞쪽의 4자리 연도만 쓰고, 읽을 수 없으면 비워 둔다(가져오기 오류로 보지 않음)
const birthYear = (text, thisYear) => {
  const y = Number(String(text).trim().match(/^(19|20)\d\d/)?.[0]);
  return y >= 1900 && y <= thisYear ? y : null;
};
const parseCsv = (text) => { // 따옴표·줄바꿈·BOM을 처리하는 최소 CSV 파서
  const rows = [[]];
  let cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { rows.at(-1).push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rows.at(-1).push(cell); cell = ''; rows.push([]);
    } else cell += c;
  }
  rows.at(-1).push(cell);
  return rows.filter((r) => r.length > 1 || r[0] !== '');
};

const ACTIVE = "('WAITING')"; // 중복 접수 판단: 배정 완료되면 다시 접수 가능
// 관리자 세션: DB에 저장하고 쿠키로 유지한다. 사용할 때마다 만료가 7일 뒤로 밀린다(롤링)
db.exec('CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
const ADMIN_SESSION_MS = 7 * 24 * 3600 * 1000;
// 관리자 로그인 시도 제한: 15분 안에 IP당 5회, 전체 30회 실패하면 15분간 로그인을 막는다(메모리, 재시작 시 초기화)
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_MAX_FAILS_ALL = 30;
const loginFails = new Map(); // IP → 실패 시각 목록
let loginFailsAll = [];
const recentFails = (list, now) => list.filter((t) => now - t < LOGIN_WINDOW_MS);
// 잠겨 있으면 안내 문구를, 아니면 null을 돌려준다. 관리자 로그인에 쓴다
const passwordLocked = (ip, now = Date.now()) => {
  const mine = recentFails(loginFails.get(ip) || [], now);
  loginFailsAll = recentFails(loginFailsAll, now);
  if (mine.length < LOGIN_MAX_FAILS && loginFailsAll.length < LOGIN_MAX_FAILS_ALL) return null;
  const oldest = (mine.length >= LOGIN_MAX_FAILS ? mine : loginFailsAll)[0];
  return `로그인 시도가 너무 많습니다. ${Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 60000))}분 뒤에 다시 시도하세요.`;
};
const recordPasswordFail = (ip, now = Date.now()) => {
  loginFails.set(ip, [...recentFails(loginFails.get(ip) || [], now), now]);
  loginFailsAll.push(now);
};
const listeners = new Set();
const notify = (kind = 'changed') => listeners.forEach((res) => res.write(`data: ${kind}\n\n`));

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = (req, max = 1024 * 1024) =>
  new Promise((resolve) => {
    let data = '', big = false;
    req.on('data', (c) => { if (!big && (data += c).length > max) { big = true; data = ''; } });
    req.on('end', () => {
      if (big) return resolve({ _tooLarge: true });
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
const cookie = (req, name) =>
  (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const clientIp = (req) => { // Caddy 뒤에서는 X-Forwarded-For의 클라이언트 IP를 쓴다
  const remote = req.socket.remoteAddress || '';
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(remote) && fwd ? fwd : remote;
};
// 접수(SMS 발송·대기 등록) 가능 여부. 접수는 공개이며 QR은 공개 접수 주소를 여는 용도다. 불가하면 응답을 보내고 true를 돌려준다.
const intakeBlocked = (req, res) => {
  if (!intakeOpen()) {
    const w = outsideWindow();
    return json(res, 403, { error: w ? `접수 가능 시간은 ${w}입니다.` : '지금은 접수 중이 아닙니다.', code: 'INTAKE_CLOSED' }), true;
  }
  return false;
};
const SECURE = oauth.BASE_URL.startsWith('https') ? '; Secure' : '';
const adminCookie = (token) => `admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}${SECURE}`;
const DEV_NO_LOGIN = process.env.DEV_NO_LOGIN === '1' && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(oauth.BASE_URL); // 로컬 전용 관리자 로그인 생략
const isAdmin = (req) => {
  if (DEV_NO_LOGIN) return true;
  const t = cookie(req, 'admin');
  return !!t && !!db.prepare('SELECT 1 FROM admin_sessions WHERE token=? AND expires_at > ?').get(t, Date.now());
};
const currentUser = (req) => {
  const sid = cookie(req, 'sid');
  const u = sid ? db.prepare('SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(sid) : undefined;
  return u && { ...u, phone: dp(u.phone) }; // 번호는 복호화해서 쓴다(저장은 암호문)
};
const redirect = (res, to, cookies = []) => {
  res.writeHead(302, { Location: to, 'Set-Cookie': cookies });
  res.end();
};

// 도착 인증까지 남은 초(대기 중이고 아직 도착 전일 때만)
const arrivalLeft = (e) => e.status === 'WAITING' && !e.arrived_at
  ? Math.max(0, ARRIVAL_LIMIT_MIN * 60 - db.prepare("SELECT strftime('%s','now','localtime') - strftime('%s',?) AS s").get(e.created_at).s)
  : null;
const publicView = (e) => ({
  token: e.token,
  arrived: !!e.arrived_at,
  arrivalLeft: arrivalLeft(e),
  name: e.name,
  partySize: e.party_size,
  shoes: e.shoes,
  status: e.status,
  lanes: e.lanes,
  position: e.status === 'WAITING'
    ? db.prepare("SELECT COUNT(*) n FROM entries WHERE status='WAITING' AND seq < ?").get(e.seq).n + 1
    : null,
});

// 상태 전이: 허용되는 이전 상태
const TRANSITIONS = {
  assign: { from: ['WAITING'], to: 'ASSIGNED' },
  finish: { from: ['ASSIGNED'], to: 'FINISHED' },
  cancel: { from: ['WAITING', 'ASSIGNED'], to: 'CANCELED' },
};

const api = {
  'GET /api/me': async (req, res) => {
    expireUnarrived();
    const u = currentUser(req);
    const active = u && db.prepare(`SELECT token FROM entries WHERE user_id=? AND status IN ${ACTIVE}`).get(u.id);
    json(res, 200, {
      user: u ? { name: u.name, provider: u.provider, providers: providersOf(u.id), phone: maskPhone(u.phone), fullMember: isFullMember(u.id, u.phone) } : null,
      activeToken: active?.token || null,
      last: (u && db.prepare('SELECT party_size AS party, shoes FROM entries WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id)) || null, // 지난 접수 인원·신발(다음 접수 기본값)
      intake: { open: intakeOpen(), window: outsideWindow() },
      arrivalLimitMin: ARRIVAL_LIMIT_MIN,
      noshow: u ? noshowStatus(ep(u.phone)) : null, // 반복 미도착: 경고(warn)·제한 해제일(until)
      consent: u ? { missing: missingConsents(u.id), marketing: !!db.prepare('SELECT agreed FROM consents WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 1').get(u.id, 'marketing')?.agreed } : null,
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
    if (consentBlocked(res, user.id)) return;
    const b = await readBody(req);
    // 대회 신청 기간에는 QR 없이도 번호 인증을 받을 수 있다(소셜 로그인은 필요, 발송 한도는 동일)
    if (!(b.for === 'tournament' && tournamentApplying()) && intakeBlocked(req, res)) return;
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' });
    const until = rejoinBlockedUntil({ phone });
    if (until) return json(res, 403, { error: `탈퇴한 번호는 ${until.slice(0, 10)}까지 다시 가입할 수 없습니다. 문의는 매장으로 해 주세요.`, code: 'REJOIN_BLOCKED' });
    const owner = db.prepare('SELECT id FROM users WHERE phone=? AND id<>?').get(ep(phone), user.id);
    if (owner && shareProvider(owner.id, user.id)) return json(res, 409, { error: '이미 다른 계정에서 인증된 번호입니다.' }); // 다른 플랫폼이면 통합 대상이라 인증을 진행한다
    const now = Date.now();
    const last = db.prepare('SELECT created_at FROM sms_codes WHERE user_id=? ORDER BY id DESC LIMIT 1').get(user.id);
    if (last && now - last.created_at < RESEND_MS)
      return json(res, 429, { error: '잠시 후 다시 요청해 주세요.', retryAfter: Math.ceil((RESEND_MS - (now - last.created_at)) / 1000) });
    const sent = db.prepare('SELECT COUNT(*) n FROM sms_codes WHERE user_id=? AND created_at > ?').get(user.id, now - 24 * 3600 * 1000).n;
    if (sent >= MAX_SENDS_PER_DAY) return json(res, 429, { error: '오늘 인증 요청 횟수를 초과했습니다.' });
    const phoneSent = db.prepare('SELECT COUNT(*) n FROM sms_codes WHERE phone=? AND created_at > ?').get(ep(phone), now - 24 * 3600 * 1000).n;
    if (phoneSent >= MAX_SENDS_PER_PHONE) return json(res, 429, { error: '오늘 인증 요청 횟수를 초과했습니다.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    // 발송 실패 시에도 기록을 남겨 비용이 드는 반복 요청을 막는다
    const row = db.prepare('INSERT INTO sms_codes (user_id,phone,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(user.id, ep(phone), hashCode(code), now + CODE_TTL_MS, now);
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
    const owner = db.prepare('SELECT id FROM users WHERE phone=? AND id<>?').get(row.phone, user.id);
    if (owner) {
      if (shareProvider(owner.id, user.id)) return json(res, 409, { error: '이미 다른 계정에서 인증된 번호입니다.' });
      // 같은 번호로 다른 플랫폼에 가입한 회원이 있다. 사용자가 통합에 동의하면 /api/phone/merge에서 합친다
      db.prepare('UPDATE sms_codes SET verified_at=? WHERE id=?').run(Date.now(), row.id);
      return json(res, 200, { ok: true, merge: { providers: providersOf(owner.id).map((p) => oauth.providers[p]?.label || p), phone: maskPhone(dp(row.phone)) } });
    }
    try {
      db.prepare("UPDATE users SET phone=?, phone_verified_at=datetime('now','localtime') WHERE id=?").run(row.phone, user.id);
    } catch { return json(res, 409, { error: '이미 다른 계정에서 인증된 번호입니다.' }); }
    db.prepare('UPDATE sms_codes SET used=1 WHERE user_id=?').run(user.id);
    linkMember(user, dp(row.phone));
    touchUser(user.id);
    json(res, 200, { ok: true, phone: maskPhone(dp(row.phone)) });
  },
  // 통합회원 확정: 번호 인증을 마친 뒤 사용자가 동의하면 이 소셜 계정을 같은 번호의 기존 회원에 연결한다
  'POST /api/phone/merge': async (req, res) => {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const row = db.prepare('SELECT * FROM sms_codes WHERE user_id=? AND used=0 AND verified_at > ? ORDER BY id DESC LIMIT 1').get(user.id, Date.now() - 10 * 60 * 1000);
    if (!row) return json(res, 400, { error: '번호 인증이 필요합니다. 다시 인증해 주세요.' });
    const owner = db.prepare('SELECT id FROM users WHERE phone=? AND id<>?').get(row.phone, user.id);
    if (!owner) return json(res, 409, { error: '통합할 회원을 찾을 수 없습니다. 다시 인증해 주세요.' });
    if (shareProvider(owner.id, user.id)) return json(res, 409, { error: '이미 다른 계정에서 인증된 번호입니다.' });
    mergeUsers(owner.id, user.id); // 지금 로그인 세션도 기존 회원으로 옮겨진다
    touchUser(owner.id);
    json(res, 200, { ok: true, phone: maskPhone(dp(row.phone)) });
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
    const shoes = parseShoes(b.shoes, party);
    if (Number.isNaN(shoes)) return json(res, 400, shoesError(party));
    if (consentBlocked(res, user.id)) return;
    if (isBlacklisted(phone)) return json(res, 403, BLACKLISTED);
    const ns = noshowStatus(ep(phone));
    if (ns.until) { // 반복 미도착 임시 제한(시행 중일 때만)
      const [, m, d] = ns.until.split('-').map(Number);
      return json(res, 403, { error: `미도착 취소가 반복되어 ${m}월 ${d}일까지 접수할 수 없습니다. 매장에 문의해 주세요.`, code: 'NOSHOW_LIMITED', until: ns.until });
    }
    const dup = db.prepare(`SELECT token FROM entries WHERE (user_id=? OR phone=?) AND status IN ${ACTIVE}`).get(user.id, ep(phone));
    if (dup) return json(res, 409, { error: '이미 접수된 대기가 있습니다.', token: dup.token });
    const token = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO entries (token,name,phone,party_size,shoes,user_id) VALUES (?,?,?,?,?,?)').run(token, name, ep(phone), party, shoes, user.id);
    touchUser(user.id);
    notify('new'); // 관리자 화면이 알림음을 낸다
    json(res, 201, { token });
  },
  'POST /api/admin/login': async (req, res) => {
    const b = await readBody(req);
    const ip = clientIp(req);
    const locked = passwordLocked(ip);
    if (locked) return json(res, 429, { error: locked });
    if (!sameSecret(b.id, ADMIN_ID) || !sameSecret(b.password, ADMIN_PASSWORD)) {
      recordPasswordFail(ip);
      return json(res, 401, { error: '아이디 또는 비밀번호가 틀렸습니다.' });
    }
    loginFails.delete(ip);
    const s = crypto.randomBytes(24).toString('hex');
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO admin_sessions (token,expires_at) VALUES (?,?)').run(s, Date.now() + ADMIN_SESSION_MS);
    res.setHeader('Set-Cookie', adminCookie(s));
    json(res, 200, { ok: true });
  },
  'GET /api/admin/intake': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { open: intakeSwitch(), openNow: intakeOpen(), schedule: schedule(), url: oauth.BASE_URL });
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
  'GET /api/admin/entries': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    expireUnarrived();
    const rows = db.prepare(`SELECT * FROM entries WHERE status IN ${ACTIVE}
      OR (status='ASSIGNED' AND date(assigned_at)=date('now','localtime'))
      OR (status='EXPIRED' AND created_at >= datetime('now','localtime','-12 hours')) ORDER BY seq`).all();
    // 최근 3개월 방문 횟수: 같은 번호로 레인 배정을 받은 날 수(하루에 여러 번 배정돼도 1회). 번호가 없는 수기 건은 null.
    // 대기 중인 건은 아직 배정 전이라 자기 자신이 포함되지 않는다(화면도 대기 건에만 표시)
    const phones = [...new Set(rows.map((e) => e.phone).filter(Boolean))];
    const visits = new Map(phones.length ? db.prepare(`SELECT phone, COUNT(DISTINCT date(assigned_at)) n FROM entries
      WHERE assigned_at >= datetime('now','localtime','-${VISIT_MONTHS} months') AND phone IN (${phones.map(() => '?').join(',')}) GROUP BY phone`).all(...phones).map((r) => [r.phone, r.n]) : []);
    json(res, 200, {
      lanes: LANES,
      visitMonths: VISIT_MONTHS,
      entries: rows.map((e) => ({
        visits: e.phone ? visits.get(e.phone) || 0 : null,
        id: e.id, name: e.name, phone: maskPhone(dp(e.phone)), partySize: e.party_size, shoes: e.shoes,
        status: e.status, lanes: e.lanes, createdAt: e.created_at, assignedAt: e.assigned_at,
        manual: e.user_id === null, memo: e.memo || '',
        arrivedAt: e.arrived_at, arrivalMethod: e.arrival_method, arrivalLeft: arrivalLeft(e),
      })),
    });
  },
  'POST /api/admin/logout': async (req, res) => {
    db.prepare('DELETE FROM admin_sessions WHERE token=?').run(cookie(req, 'admin') || '');
    res.setHeader('Set-Cookie', `admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE}`);
    json(res, 200, { ok: true });
  },
  // 수기 등록(M-7): 스마트폰을 쓰기 어려운 손님. 계정 없이 등록하므로 user_id가 비어 있다
  'POST /api/admin/entries': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 20);
    const phone = String(b.phone || '').replace(/\D/g, '');
    const party = Number(b.partySize);
    if (!name) return json(res, 400, { error: '이름을 입력하세요.' });
    if (phone && !/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' });
    if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY)
      return json(res, 400, { error: `인원은 1~${MAX_PARTY}명입니다.` });
    const shoes = parseShoes(b.shoes, party);
    if (Number.isNaN(shoes)) return json(res, 400, shoesError(party));
    if (isBlacklisted(phone)) return json(res, 403, { error: '블랙리스트에 등록된 번호입니다.' });
    if (phone && db.prepare(`SELECT 1 FROM entries WHERE phone=? AND status IN ${ACTIVE}`).get(ep(phone)))
      return json(res, 409, { error: '이미 접수된 대기가 있습니다.' });
    db.prepare("INSERT INTO entries (token,name,phone,party_size,shoes,memo,arrived_at,arrival_method) VALUES (?,?,?,?,?,?,datetime('now','localtime'),'staff')")
      .run(crypto.randomBytes(12).toString('hex'), name, ep(phone), party, shoes, String(b.memo || '').trim().slice(0, 200) || null);
    touchPhone(phone);
    notify();
    json(res, 201, { ok: true });
  },
  'GET /api/admin/blacklist': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { entries: db.prepare('SELECT id, phone, name, reason, created_at AS createdAt FROM blacklist ORDER BY id DESC').all().map((b) => ({ ...b, phone: maskPhone(dp(b.phone)) })) });
  },
  'POST /api/admin/blacklist': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const phone = String(b.phone || '').replace(/\D/g, '');
    const reason = String(b.reason || '').trim().slice(0, 200);
    if (!/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' });
    if (!reason) return json(res, 400, { error: '등록 사유를 입력하세요.' });
    addBlacklist(phone, String(b.name || '').trim().slice(0, 20), reason);
    json(res, 200, { ok: true });
  },
  'POST /api/admin/blacklist/remove': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    db.prepare('DELETE FROM blacklist WHERE id=?').run(Number((await readBody(req)).id));
    json(res, 200, { ok: true });
  },
  // 반복 미도착 접수 제한(M-30): 제한 대상, 최근 도착 만료 건(오처리 제외 표시), 이력
  'GET /api/admin/limits': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    expireUnarrived();
    const mask = (p) => maskPhone(dp(p));
    const limits = db.prepare(`SELECT l.id, l.phone, l.starts_at AS startsAt, l.ends_at AS endsAt, l.released_at AS releasedAt,
      (l.released_at IS NULL AND l.ends_at > datetime('now','localtime')) AS active FROM intake_limits l ORDER BY l.id DESC LIMIT 100`).all()
      .map((l) => ({ ...l, active: !!l.active, phone: mask(l.phone) }));
    const expired = db.prepare(`SELECT id, name, phone, finished_at AS expiredAt, noshow_excluded AS excluded FROM entries
      WHERE status='EXPIRED' AND phone IS NOT NULL AND finished_at >= datetime('now','localtime','-${NOSHOW_DAYS} days') ORDER BY finished_at DESC LIMIT 200`).all()
      .map((e) => ({ ...e, excluded: !!e.excluded, count: noshowEntries(e.phone).length, phone: mask(e.phone) }));
    const log = db.prepare('SELECT at, phone, action, entry_id AS entryId FROM noshow_log ORDER BY id DESC LIMIT 50').all().map((l) => ({ ...l, phone: mask(l.phone) }));
    json(res, 200, { enforce: NOSHOW_ENFORCE, rule: { count: NOSHOW_COUNT, days: NOSHOW_DAYS, banDays: NOSHOW_BAN_DAYS }, limits, expired, log });
  },
  'POST /api/admin/limits/release': async (req, res) => { // 제한 즉시 해제(해제하면 그 시각부터 다시 센다)
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const l = db.prepare('SELECT * FROM intake_limits WHERE id=?').get(Number((await readBody(req)).id));
    if (!l) return json(res, 404, { error: 'not found' });
    if (l.released_at) return json(res, 409, { error: '이미 해제된 제한입니다.' });
    db.prepare("UPDATE intake_limits SET released_at=datetime('now','localtime') WHERE id=?").run(l.id);
    noshowLog(l.phone, 'release', null, l.id);
    json(res, 200, { ok: true });
  },
  'POST /api/admin/limits/reset': async (req, res) => { // 횟수 초기화(진행 중인 제한도 함께 해제)
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const e = db.prepare('SELECT phone FROM entries WHERE id=?').get(Number((await readBody(req)).entryId));
    if (!e?.phone) return json(res, 404, { error: 'not found' });
    db.prepare("UPDATE intake_limits SET released_at=datetime('now','localtime') WHERE phone=? AND released_at IS NULL AND ends_at > datetime('now','localtime')").run(e.phone);
    noshowLog(e.phone, 'reset');
    json(res, 200, { ok: true });
  },
  'POST /api/admin/limits/exclude': async (req, res) => { // 오처리 제외: 도착 만료 건을 집계에서 빼거나 되돌린다
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const e = db.prepare("SELECT id, phone FROM entries WHERE id=? AND status='EXPIRED'").get(Number(b.entryId));
    if (!e?.phone) return json(res, 404, { error: 'not found' });
    db.prepare('UPDATE entries SET noshow_excluded=? WHERE id=?').run(b.excluded ? 1 : 0, e.id);
    noshowLog(e.phone, b.excluded ? 'exclude' : 'include', e.id);
    evaluateNoshow(e.phone); // 되돌려서 횟수에 다시 도달하면 제한이 생긴다
    json(res, 200, { ok: true });
  },
  'GET /api/policy': async (req, res) => {
    const type = new URL(req.url, 'http://x').searchParams.get('type');
    if (!POLICY_TYPES[type]) return json(res, 404, { error: 'not found' });
    const p = policyOf(type);
    json(res, 200, { type, title: POLICY_TYPES[type], body: p.body, version: p.version, updatedAt: p.updated_at });
  },
  'POST /api/consent': async (req, res) => { // 필수 약관 동의(현재 버전)와 마케팅 수신 선택
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const b = await readBody(req);
    const need = missingConsents(user.id);
    if (need.some((t) => b[t] !== true)) return json(res, 400, { error: '필수 약관에 모두 동의해 주세요.' });
    const ins = db.prepare('INSERT INTO consents (user_id,type,version,agreed) VALUES (?,?,?,?)');
    need.forEach((t) => ins.run(user.id, t, policyOf(t).version, 1));
    if (typeof b.marketing === 'boolean') {
      const last = db.prepare('SELECT agreed FROM consents WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 1').get(user.id, 'marketing');
      if (!last || !!last.agreed !== b.marketing) ins.run(user.id, 'marketing', 0, b.marketing ? 1 : 0); // 바뀐 때만 기록
    }
    json(res, 200, { ok: true });
  },
  'GET /api/admin/policies': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { policies: Object.keys(POLICY_TYPES).map((type) => ({ type, title: POLICY_TYPES[type], ...policyOf(type), consentVersion: policyOf(type).consent_version, updatedAt: policyOf(type).updated_at })) });
  },
  'POST /api/admin/policies': async (req, res) => { // 본문이 바뀌면 버전이 오른다. reconsent가 true일 때만 모든 회원이 다시 동의한다
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req, 2 * 1024 * 1024);
    if (!POLICY_TYPES[b.type]) return json(res, 400, { error: '약관 종류를 확인하세요.' });
    const body = String(b.body || '').trim().slice(0, 100000), cur = policyOf(b.type);
    if (body === cur.body) return json(res, 200, { version: cur.version, changed: false });
    const version = cur.version + 1;
    const reconsent = !cur.version || b.reconsent === true; // 처음 등록하는 약관은 모두 동의해야 한다
    const consentVersion = reconsent ? version : cur.consent_version;
    db.prepare("INSERT INTO policies (type,body,version,consent_version,updated_at) VALUES (?,?,?,?,datetime('now','localtime')) ON CONFLICT(type) DO UPDATE SET body=excluded.body, version=excluded.version, consent_version=excluded.consent_version, updated_at=excluded.updated_at").run(b.type, body, version, consentVersion);
    if (cur.version && b.notify !== false) { // 개정 안내 공지
      const summary = String(b.summary || '').trim().slice(0, 1000) || '내용이 개정되었습니다. 자세한 내용은 아래 화면에서 확인해 주세요.';
      const today = new Date().toLocaleDateString('sv');
      db.prepare('INSERT INTO notices (date,title,body) VALUES (?,?,?)').run(today, `[${POLICY_TYPES[b.type]} 개정 안내]`,
        `${summary}\n\n시행일: ${today}\n${reconsent ? '개정 내용에 대한 동의가 다시 필요합니다.\n' : ''}전문 보기: /${b.type}`);
    }
    json(res, 200, { version, changed: true, reconsent });
  },
  'POST /api/me/withdraw': async (req, res) => { // 로그인한 본인의 탈퇴
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    if ((await readBody(req)).confirm !== true) return json(res, 400, { error: '탈퇴를 확인해 주세요.' });
    const r = withdrawAccount({ userId: user.id }, '본인');
    if (r.error) return json(res, 409, r);
    res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
    json(res, 200, { ok: true, blockedDays: REJOIN_DAYS });
  },
  'POST /api/admin/members/delete': async (req, res) => { // 전화·매장으로 들어온 삭제 요청
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const id = Number((await readBody(req)).id);
    if (!db.prepare('SELECT 1 FROM members WHERE id=?').get(id)) return json(res, 404, { error: 'not found' });
    const r = withdrawAccount({ memberId: id }, '관리자');
    json(res, r.error ? 409 : 200, r);
  },
  'POST /api/admin/withdrawals/lift': async (req, res) => { // 재가입 제한 해제(번호 기준)
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const phone = String((await readBody(req)).phone || '').replace(/\D/g, '');
    if (!/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' });
    const r = db.prepare("DELETE FROM withdrawals WHERE phone_hash=? AND blocked_until > datetime('now','localtime')").run(idHash('phone', phone));
    json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: '제한 중인 번호가 아닙니다.' });
  },
  // 공개 메인 화면용 상태: 접수 상태, 대기 팀 수, 대회신청 버튼 상태. 개인정보는 없다
  'GET /api/home': async (req, res) => {
    expireUnarrived();
    json(res, 200, {
      now: new Date().toLocaleString('sv'), // 화면이 시작·마감 시각까지 남은 시간을 서버 시각으로 계산한다
      intake: { open: intakeOpen(), window: outsideWindow() },
      waitingTeams: db.prepare("SELECT COUNT(*) n FROM entries WHERE status='WAITING'").get().n,
      tournament: homeTournament(),
    });
  },
  'GET /api/notices': async (req, res) => json(res, 200, { notices: noticeRows() }),
  'GET /api/banners': async (req, res) => json(res, 200, { banners: bannerIds() }),
  'GET /api/admin/notices': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { notices: noticeRows() });
  },
  'POST /api/admin/notices': async (req, res) => { // 등록·수정(id가 있으면 수정)
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const date = String(b.date || new Date().toLocaleDateString('sv')), title = String(b.title || '').trim().slice(0, 100), body = String(b.body || '').trim().slice(0, 5000);
    if (!dateOk(date)) return json(res, 400, { error: '날짜를 확인하세요.' });
    if (!title) return json(res, 400, { error: '제목을 입력하세요.' });
    const id = Number(b.id);
    if (id) {
      if (!db.prepare('UPDATE notices SET date=?, title=?, body=? WHERE id=?').run(date, title, body || null, id).changes) return json(res, 404, { error: 'not found' });
      return json(res, 200, { id });
    }
    json(res, 201, { id: Number(db.prepare('INSERT INTO notices (date,title,body) VALUES (?,?,?)').run(date, title, body || null).lastInsertRowid) });
  },
  'POST /api/admin/notices/remove': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const r = db.prepare('DELETE FROM notices WHERE id=?').run(Number((await readBody(req)).id));
    json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'not found' });
  },
  'GET /api/admin/banners': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { banners: bannerIds() });
  },
  'GET /api/admin/banner-image': async (req, res) => { // 관리자 호스트는 /banner/를 쓸 수 없어 미리보기를 따로 둔다
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = db.prepare('SELECT mime, data FROM banners WHERE id=?').get(Number(new URL(req.url, 'http://x').searchParams.get('id')));
    if (!b) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': b.mime, 'X-Content-Type-Options': 'nosniff' });
    res.end(b.data);
  },
  'POST /api/admin/banners': async (req, res) => { // 이미지 업로드: { data: base64 또는 data URL }
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req, 8 * 1024 * 1024);
    if (body._tooLarge) return json(res, 413, { error: '이미지가 너무 큽니다. 3MB 이하로 올려 주세요.' });
    const img = Buffer.from(String(body.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!img.length) return json(res, 400, { error: '이미지를 선택하세요.' });
    if (img.length > MAX_IMAGE) return json(res, 413, { error: '이미지가 너무 큽니다. 3MB 이하로 올려 주세요.' });
    const mime = imageMime(img);
    if (!mime) return json(res, 400, { error: 'PNG, JPG, GIF, WEBP 이미지만 올릴 수 있습니다.' });
    if (db.prepare('SELECT COUNT(*) n FROM banners').get().n >= MAX_BANNERS) return json(res, 409, { error: `이미지는 최대 ${MAX_BANNERS}개까지 등록할 수 있습니다.` });
    const id = Number(db.prepare('INSERT INTO banners (mime,data,sort) VALUES (?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM banners))').run(mime, img).lastInsertRowid);
    json(res, 201, { id });
  },
  'POST /api/admin/banners/move': async (req, res) => { // 위로/아래로: 이웃과 순서를 바꾼다
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const me = db.prepare('SELECT id, sort FROM banners WHERE id=?').get(Number(b.id));
    if (!me) return json(res, 404, { error: 'not found' });
    const other = b.dir === 'up'
      ? db.prepare('SELECT id, sort FROM banners WHERE (sort < ? OR (sort = ? AND id < ?)) ORDER BY sort DESC, id DESC LIMIT 1').get(me.sort, me.sort, me.id)
      : db.prepare('SELECT id, sort FROM banners WHERE (sort > ? OR (sort = ? AND id > ?)) ORDER BY sort, id LIMIT 1').get(me.sort, me.sort, me.id);
    if (other) {
      // 같은 sort 값이 겹쳐도 바뀌도록 id 순서를 기준으로 번호를 다시 매긴다
      const all = db.prepare('SELECT id FROM banners ORDER BY sort, id').all().map((r) => r.id);
      const i = all.indexOf(me.id), j = all.indexOf(other.id);
      [all[i], all[j]] = [all[j], all[i]];
      all.forEach((id, k) => db.prepare('UPDATE banners SET sort=? WHERE id=?').run(k + 1, id));
    }
    json(res, 200, { ok: true });
  },
  'POST /api/admin/banners/remove': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const r = db.prepare('DELETE FROM banners WHERE id=?').run(Number((await readBody(req)).id));
    json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'not found' });
  },
  'GET /api/calendar': async (req, res) => {
    const month = monthOf(new URL(req.url, 'http://x').searchParams.get('month'));
    json(res, 200, { month, events: calendarRows(month) });
  },
  'GET /api/admin/calendar': async (req, res) => { // 관리자 호스트는 /api/calendar를 쓸 수 없어 같은 내용을 따로 둔다
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const month = monthOf(new URL(req.url, 'http://x').searchParams.get('month'));
    json(res, 200, { month, events: calendarRows(month) });
  },
  'POST /api/admin/calendar': async (req, res) => { // 등록·수정(id가 있으면 수정)
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const date = String(b.date || ''), title = String(b.title || '').trim().slice(0, 50), memo = String(b.memo || '').trim().slice(0, 500);
    if (!dateOk(date)) return json(res, 400, { error: '날짜를 확인하세요.' });
    if (!title) return json(res, 400, { error: '제목을 입력하세요.' });
    const id = Number(b.id);
    if (id) {
      if (!db.prepare('UPDATE calendar_events SET date=?, title=?, memo=? WHERE id=?').run(date, title, memo || null, id).changes)
        return json(res, 404, { error: 'not found' });
      return json(res, 200, { id });
    }
    json(res, 201, { id: Number(db.prepare('INSERT INTO calendar_events (date,title,memo) VALUES (?,?,?)').run(date, title, memo || null).lastInsertRowid) });
  },
  'POST /api/admin/calendar/remove': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const r = db.prepare('DELETE FROM calendar_events WHERE id=?').run(Number((await readBody(req)).id));
    json(res, r.changes ? 200 : 404, r.changes ? { ok: true } : { error: 'not found' });
  },
  // 회원 목록(M-14): 연락처·이메일은 마스킹해서 내려보낸다(M-15)
  'GET /api/admin/members': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const kw = (q.get('q') || '').trim();
    const page = Math.max(1, Number(q.get('page')) || 1), size = 50;
    const where = [], args = [];
    if (kw) {
      const like = `%${kw.replace(/[\\%_]/g, '\\$&')}%`;
      // 번호는 암호화되어 있어 부분 검색이 안 된다. 번호 전체(숫자 10~11자리)를 입력하면 정확히 일치하는 회원을 찾는다
      where.push("(name LIKE ? ESCAPE '\\' OR phone = ? OR email LIKE ? ESCAPE '\\')");
      args.push(like, ep(kw.replace(/\D/g, '')) || null, like); // 숫자가 없으면 번호 조건은 항상 거짓(빈 번호와 맞지 않게)
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM members ${w}`).get(...args).n;
    const year = new Date().getFullYear();
    const rows = db.prepare(`SELECT * FROM members ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    const linkedIds = rows.map((m) => m.user_id).filter(Boolean);
    const platformOf = new Map();
    if (linkedIds.length) db.prepare(`SELECT user_id, provider FROM user_identities WHERE user_id IN (${linkedIds.map(() => '?').join(',')}) ORDER BY id`).all(...linkedIds)
      .forEach((r) => platformOf.set(r.user_id, [...(platformOf.get(r.user_id) || []), r.provider]));
    json(res, 200, {
      total, page, size,
      entries: rows.map((m) => ({
        platforms: platformOf.get(m.user_id) || [], // 가입한 소셜 플랫폼(이관만 되고 로그인 전이면 비어 있음)
        id: m.id, name: m.name, age: m.birth_year ? year - m.birth_year : null, gender: GENDER_LABEL[m.gender] || m.gender || '', birthDate: m.birth_date || '', lastUsedAt: (m.last_used_at || '').slice(0, 10),
        phone: maskPhone(dp(m.phone)), email: maskEmail(m.email), source: m.source, tier: m.tier, linked: !!m.user_id, joinedAt: (m.joined_at || '').slice(0, 10),
      })),
    });
  },
  // 정회원 가입·정보 수정: 본인이 생년월일·성별을 직접 입력한다(본인인증 없음). 입력하면 바로 정회원이 되고, 바뀐 내용은 이력으로 남는다
  'GET /api/tournament-profile': async (req, res) => {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    if (!user.phone) return json(res, 403, { error: '휴대전화 인증이 필요합니다.', code: 'PHONE_REQUIRED' });
    const m = memberFor(user);
    json(res, 200, { fullMember: m.tier === FULL, birthDate: m.birth_date || '', birthYear: m.birth_year || null, gender: GENDER_LABEL[m.gender] ? m.gender : '' });
  },
  'POST /api/tournament-profile': async (req, res) => {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
    if (!user.phone) return json(res, 403, { error: '휴대전화 인증이 필요합니다.', code: 'PHONE_REQUIRED' });
    const b = await readBody(req);
    if (consentBlocked(res, user.id)) return;
    const birthDate = String(b.birthDate || '').trim(), gender = String(b.gender || '');
    if (!validDate(birthDate)) return json(res, 400, { error: '생년월일을 확인하세요.' });
    if (!GENDER_LABEL[gender]) return json(res, 400, { error: '성별을 선택하세요.' });
    const m = memberFor(user);
    const year = Number(birthDate.slice(0, 4));
    db.prepare("UPDATE members SET birth_date=?, birth_year=?, gender=?, tier=?, verified_at=COALESCE(verified_at, datetime('now','localtime')) WHERE id=?").run(birthDate, year, gender, FULL, m.id);
    logChange(m.id, '생년월일', m.birth_date || m.birth_year, birthDate, '본인');
    logChange(m.id, '성별', m.gender, gender, '본인');
    logChange(m.id, '등급', m.tier, FULL, '본인');
    touchUser(user.id);
    json(res, 200, { ok: true });
  },
  // 정회원 지정·해제: 본인인증(현재는 매장에서 신분 확인)을 거친 회원만 정회원으로 올린다
  'POST /api/admin/members/tier': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    if (![FULL, '일반'].includes(b.tier)) return json(res, 400, { error: '등급을 확인하세요.' });
    const m = db.prepare('SELECT id, tier FROM members WHERE id=?').get(Number(b.id));
    if (!m) return json(res, 404, { error: 'not found' });
    db.prepare("UPDATE members SET tier=?, verified_at=CASE WHEN ?=? THEN datetime('now','localtime') END WHERE id=?").run(b.tier, b.tier, FULL, m.id);
    logChange(m.id, '등급', m.tier, b.tier, '관리자');
    json(res, 200, { ok: true });
  },
  'GET /api/admin/members/log': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
    json(res, 200, { entries: db.prepare('SELECT field, old_value AS oldValue, new_value AS newValue, changed_by AS changedBy, changed_at AS changedAt FROM member_change_log WHERE member_id=? ORDER BY id DESC').all(id) });
  },
  // 개인정보 원문 조회(결정 11 변경, 2026-11-04): 비밀번호 대신 조회 사유를 입력하고, 사유와 함께 기록을 남긴다
  // type: member(전화·이메일) / entry(대기·이력) / blacklist / tournament(대회 신청자)
  'POST /api/admin/reveal': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const b = await readBody(req);
    const reason = String(b.reason || '').trim().slice(0, 100);
    if (reason.length < 2) return json(res, 400, { error: '조회 사유를 입력하세요.' });
    const table = { member: 'members', entry: 'entries', blacklist: 'blacklist', limit: 'intake_limits', tournament: 'tournament_entries' }[b.type];
    if (!table) return json(res, 400, { error: '조회 대상을 확인하세요.' });
    const id = Number(b.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row || !row.phone) return json(res, 404, { error: 'not found' });
    db.prepare('INSERT INTO pii_view_log (admin_id,member_id,ip,target,reason) VALUES (?,?,?,?,?)').run(ADMIN_ID, id, clientIp(req), b.type, reason);
    json(res, 200, { phone: dp(row.phone), email: row.email || '' });
  },
  // 회원 가져오기(M-16): 현행 관리자에서 추출한 CSV. 이미 있는 번호·파일 안 중복은 건너뛴다
  'POST /api/admin/members/import': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req, 10 * 1024 * 1024); // 회원 CSV는 1MB를 넘을 수 있다
    if (body._tooLarge) return json(res, 413, { error: '파일이 너무 큽니다. 10MB 이하로 나누어 올려 주세요.' });
    const rows = parseCsv(String(body.csv || ''));
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    if (col('name') < 0 || col('phone') < 0) return json(res, 400, { error: '첫 줄에 name, phone 열이 필요합니다.' });
    const year = new Date().getFullYear();
    const ins = db.prepare('INSERT INTO members (name,phone,email,gender,birth_year,joined_at,source) VALUES (?,?,?,?,?,?,?)');
    const exists = db.prepare('SELECT 1 FROM members WHERE phone=?');
    const report = { total: 0, imported: 0, duplicate: 0, errors: [] };
    db.exec('BEGIN');
    try {
      rows.forEach((r, i) => {
        if (r.every((c) => !c.trim())) return;
        report.total++;
        const get = (n) => (col(n) < 0 ? '' : (r[col(n)] || '').trim());
        const name = get('name').slice(0, 20), phone = get('phone').replace(/\D/g, ''), email = get('email').slice(0, 100);
        const by = birthYear(get('birth_year'), year);
        const fail = (reason) => report.errors.push({ line: i + 2, reason, row: r });
        if (!name) return fail('이름이 없습니다.');
        if (!/^01\d{8,9}$/.test(phone)) return fail('연락처 형식이 올바르지 않습니다.');
        if (email && !email.includes('@')) return fail('이메일 형식이 올바르지 않습니다.');
        if (exists.get(ep(phone))) return void report.duplicate++;
        ins.run(name, ep(phone), email || null, get('gender').slice(0, 10) || null, by, get('joined_at').slice(0, 19) || null, '이관');
        report.imported++;
      });
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    json(res, 200, report);
  },
  // 통계(M-13): 접수일 기준. 대기시간은 접수~레인 배정까지(분)
  'GET /api/admin/stats': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const today = new Date().toLocaleDateString('sv');
    const to = dateOk(q.get('to')) ? q.get('to') : today;
    const from = dateOk(q.get('from')) ? q.get('from') : new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
    if (from > to) return json(res, 400, { error: '시작일이 종료일보다 늦습니다.' });
    if (Date.parse(to) - Date.parse(from) > 366 * 86400000) return json(res, 400, { error: '조회 기간은 최대 1년입니다.' });
    const rows = db.prepare(`SELECT date(created_at) AS day, CAST(strftime('%H', created_at) AS INTEGER) AS hour, CAST(strftime('%w', created_at) AS INTEGER) AS dow,
      party_size AS party, status, user_id IS NULL AS manual,
      CASE WHEN assigned_at IS NOT NULL THEN (julianday(assigned_at) - julianday(created_at)) * 1440
           WHEN status = 'CANCELED' AND finished_at IS NOT NULL THEN (julianday(finished_at) - julianday(created_at)) * 1440 END AS wait,
      assigned_at IS NOT NULL AS was_assigned
      FROM entries WHERE date(created_at) BETWEEN ? AND ?`).all(from, to);
    const isAssigned = (r) => r.status === 'ASSIGNED' || r.status === 'FINISHED';
    const avg = (list) => (list.length ? Math.round(list.reduce((a, r) => a + r.wait, 0) / list.length * 10) / 10 : null);
    const summarize = (list) => {
      const waits = list.filter((r) => r.wait !== null).map((r) => r.wait).sort((a, b) => a - b);
      const sum = waits.reduce((a, b) => a + b, 0);
      return {
        teams: list.length, people: list.reduce((a, r) => a + r.party, 0),
        assigned: list.filter(isAssigned).length, canceled: list.filter((r) => r.status === 'CANCELED').length, expired: list.filter((r) => r.status === 'EXPIRED').length,
        waiting: list.filter((r) => r.status === 'WAITING').length,
        avgWait: waits.length ? Math.round(sum / waits.length * 10) / 10 : null,
        avgAssignedWait: avg(list.filter((r) => r.wait !== null && r.was_assigned)),
        avgCanceledWait: avg(list.filter((r) => r.wait !== null && !r.was_assigned)),
        medianWait: waits.length ? Math.round(waits[Math.floor((waits.length - 1) / 2)] * 10) / 10 : null,
        maxWait: waits.length ? Math.round(waits[waits.length - 1] * 10) / 10 : null,
      };
    };
    const group = (key) => {
      const m = new Map();
      rows.forEach((r) => m.set(r[key], [...(m.get(r[key]) || []), r]));
      return m;
    };
    const days = [...group('day')].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, ...summarize(list) }));
    const hours = [...group('hour')].sort(([a], [b]) => a - b).map(([hour, list]) => ({ hour, ...summarize(list) }));
    const weekdays = [...group('dow')].sort(([a], [b]) => a - b).map(([dow, list]) => ({ dow, ...summarize(list) }));
    json(res, 200, { from, to, total: summarize(rows), manual: rows.filter((r) => r.manual).length, days, hours, weekdays });
  },
  // 이력 조회(M-11): 날짜·이름/연락처·레인 검색. format=csv이면 엑셀용 CSV로 내려준다
  'GET /api/admin/history': async (req, res) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const day = /^\d{4}-\d\d-\d\d$/;
    const from = day.test(q.get('from')) ? q.get('from') : new Date().toLocaleDateString('sv');
    const to = day.test(q.get('to')) ? q.get('to') : from;
    const where = ['date(created_at) BETWEEN ? AND ?'], args = [from, to];
    const kw = (q.get('q') || '').trim();
    if (kw) {
      where.push("(name LIKE ? ESCAPE '\\' OR phone = ?)"); // 번호는 암호화되어 있어 전체 번호로만 찾는다
      args.push(`%${kw.replace(/[\\%_]/g, '\\$&')}%`, ep(kw.replace(/\D/g, '')) || null);
    }
    const lane = Number(q.get('lane'));
    if (lane) { where.push("(',' || lanes || ',') LIKE ?"); args.push(`%,${lane},%`); }
    const rows = db.prepare(`SELECT *, CASE WHEN assigned_at IS NOT NULL
      THEN CAST(ROUND((julianday(assigned_at) - julianday(created_at)) * 1440) AS INTEGER)
      WHEN status = 'CANCELED' AND finished_at IS NOT NULL
      THEN CAST(ROUND((julianday(finished_at) - julianday(created_at)) * 1440) AS INTEGER) END AS wait_min
      FROM entries WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 2000`).all(...args);
    const view = rows.map((e) => ({
      id: e.id, createdAt: e.created_at, name: e.name, phone: maskPhone(dp(e.phone)), partySize: e.party_size, shoes: e.shoes ?? '', status: e.status,
      lanes: e.lanes || '', assignedAt: e.assigned_at || '', waitMin: e.wait_min ?? '', manual: e.user_id === null,
      memo: e.memo || '', cancelReason: e.cancel_reason || '',
    }));
    if (q.get('format') !== 'csv') return json(res, 200, { from, to, entries: view });
    const head = ['접수 시각', '이름', '전화', '인원', '신발', '상태', '레인', '배정 시각', '대기(분)', '경로', '메모', '취소 사유'];
    // 엑셀이 수식으로 해석하지 않도록 =,+,-,@로 시작하는 값 앞에 '를 붙인다
    const cell = (v) => { v = String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
    const csv = [head, ...view.map((e) => [e.createdAt, e.name, e.phone, e.partySize, e.shoes, e.status, e.lanes, e.assignedAt, e.waitMin, e.manual ? '수기' : 'QR', e.memo, e.cancelReason])]
      .map((r) => r.map(cell).join(',')).join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="history_${from}_${to}.csv"` });
    res.end('﻿' + csv);
  },
};

// ---- 회원 탈퇴·삭제 ----
// 회원 정보·소셜 계정·세션을 지우고, 접수·대회 기록은 이름·연락처를 지워 통계용으로만 남긴다.
// 블랙리스트와 동의 기록은 남긴다. 재가입 방지를 위해 번호·소셜 계정의 해시만 기간 동안 보관한다.
db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hash TEXT,
  provider_hash TEXT,
  done_by TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  blocked_until TEXT NOT NULL
)`);
const REJOIN_DAYS = Number(process.env.REJOIN_BLOCK_DAYS) || 30;
const idHash = (kind, value) => crypto.createHmac('sha256', CODE_SECRET).update(`${kind}:${value}`).digest('hex');
const rejoinBlockedUntil = ({ phone, providerKey }) => {
  const conds = [], args = [];
  if (phone) { conds.push('phone_hash=?'); args.push(idHash('phone', phone)); }
  if (providerKey) { conds.push('provider_hash=?'); args.push(idHash('provider', providerKey)); }
  if (!conds.length) return null;
  return db.prepare(`SELECT MAX(blocked_until) AS u FROM withdrawals WHERE blocked_until > datetime('now','localtime') AND (${conds.join(' OR ')})`).get(...args).u || null;
};
const withdrawAccount = ({ userId = null, memberId = null }, doneBy) => {
  let member = memberId ? db.prepare('SELECT * FROM members WHERE id=?').get(memberId) : null;
  let user = userId ? db.prepare('SELECT * FROM users WHERE id=?').get(userId) : member?.user_id ? db.prepare('SELECT * FROM users WHERE id=?').get(member.user_id) : null;
  if (!member) member = db.prepare('SELECT * FROM members WHERE user_id=? OR (? IS NOT NULL AND phone=?)').get(user?.id ?? -1, user?.phone ?? null, user?.phone ?? null);
  const phoneStored = member?.phone || user?.phone || ''; // 암호문(조회·갱신에 쓴다)
  const phone = dp(phoneStored); // 재가입 제한 해시용 원문
  const uid = user?.id ?? -1;
  const today = new Date().toLocaleDateString('sv');
  // 입금이 확인된 대회가 남아 있으면 환불을 먼저 처리해야 한다
  if (db.prepare("SELECT 1 FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament_id WHERE e.status='CONFIRMED' AND (e.user_id=? OR (? <> '' AND e.phone=?)) AND substr(t.event_at,1,10) >= ?").get(uid, phoneStored, phoneStored, today))
    return { error: '입금이 확인된 대회 신청이 있어 탈퇴할 수 없습니다. 매장에 문의해 주세요.', code: 'HAS_PAID_ENTRY' };
  const mine = '(user_id=? OR (? <> \'\' AND phone=?))';
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE entries SET status='CANCELED', cancel_reason='탈퇴', finished_at=datetime('now','localtime') WHERE status IN ${ACTIVE} AND ${mine}`).run(uid, phoneStored, phoneStored);
    db.prepare(`UPDATE entries SET name='삭제됨', phone='', memo=NULL WHERE ${mine}`).run(uid, phoneStored, phoneStored);
    const tids = db.prepare(`SELECT DISTINCT tournament_id t FROM tournament_entries WHERE status IN ('PENDING','CONFIRMED') AND ${mine}`).all(uid, phoneStored, phoneStored).map((r) => r.t);
    db.prepare(`UPDATE tournament_entries SET status='DELETED', deleted_at=datetime('now','localtime'), delete_reason='탈퇴' WHERE status IN ('PENDING','WAITLIST') AND ${mine}`).run(uid, phoneStored, phoneStored);
    db.prepare(`UPDATE tournament_entries SET name='삭제됨', phone='' WHERE ${mine}`).run(uid, phoneStored, phoneStored);
    tids.forEach(promoteWaitlist); // 입금 대기가 빠지면 대기자가 올라간다
    if (member) { db.prepare('DELETE FROM member_change_log WHERE member_id=?').run(member.id); db.prepare('DELETE FROM members WHERE id=?').run(member.id); }
    if (user) {
      db.prepare('DELETE FROM sms_codes WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM users WHERE id=?').run(user.id);
    }
    // 연결된 소셜 계정(통합회원이면 둘 다)마다 재가입 제한을 남긴다
    const keys = user ? db.prepare('SELECT provider, provider_id FROM user_identities WHERE user_id=?').all(user.id).map((i) => `${i.provider}:${i.provider_id}`) : [];
    if (user && !keys.length) keys.push(`${user.provider}:${user.provider_id}`);
    if (user) db.prepare('DELETE FROM user_identities WHERE user_id=?').run(user.id);
    const insW = db.prepare(`INSERT INTO withdrawals (phone_hash,provider_hash,done_by,blocked_until) VALUES (?,?,?,datetime('now','localtime',?))`);
    insW.run(phone ? idHash('phone', phone) : null, keys[0] ? idHash('provider', keys[0]) : null, doneBy, `+${REJOIN_DAYS} days`);
    keys.slice(1).forEach((k) => insW.run(null, idHash('provider', k), doneBy, `+${REJOIN_DAYS} days`));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  notify();
  return { ok: true };
};

const LANES_ERROR = { error: `레인은 1~${LANES} 번호로 입력하세요. 예: 5,6` };
const parseLanes = (text) => { // "6, 5" → "5,6". 잘못된 입력이면 null
  const picked = [...new Set(String(text || '').split(',').map((s) => Number(s.trim())))];
  if (!picked.length || picked.some((n) => !Number.isInteger(n) || n < 1 || n > LANES)) return null;
  return picked.sort((a, c) => a - c).join(',');
};

async function handleAction(req, res, id, action) {
  if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
  const b = await readBody(req);
  if (action === 'edit' && e) { // 인원 수정·메모
    if (!['WAITING', 'ASSIGNED'].includes(e.status)) return json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` });
    const party = b.partySize === undefined ? e.party_size : Number(b.partySize);
    if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY) return json(res, 400, { error: `인원은 1~${MAX_PARTY}명입니다.` });
    const memo = b.memo === undefined ? e.memo : String(b.memo).trim().slice(0, 200) || null;
    // 신발을 보내지 않았으면 기존 값을 두되 새 인원을 넘지 않게 줄인다
    const shoes = b.shoes === undefined ? (e.shoes === null ? null : Math.min(e.shoes, party)) : parseShoes(b.shoes, party);
    if (Number.isNaN(shoes)) return json(res, 400, shoesError(party));
    db.prepare('UPDATE entries SET party_size=?, shoes=?, memo=? WHERE id=?').run(party, shoes, memo, id);
    notify();
    return json(res, 200, { ok: true });
  }
  if (action === 'arrive' && e) { // 카운터 도착 확인. 도착 만료된 건이면 대기로 복구한다(순서는 접수 순 그대로)
    if (e.status !== 'WAITING' && e.status !== 'EXPIRED') return json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` });
    if (e.arrived_at) return json(res, 409, { error: '이미 도착 처리된 건입니다.' });
    if (e.status === 'EXPIRED' && db.prepare(`SELECT 1 FROM entries WHERE status IN ${ACTIVE} AND id<>? AND ((user_id IS NOT NULL AND user_id=?) OR (phone IS NOT NULL AND phone=?))`).get(id, e.user_id ?? -1, e.phone ?? ''))
      return json(res, 409, { error: '같은 손님의 다른 대기가 이미 있어 복구할 수 없습니다.' });
    db.prepare("UPDATE entries SET status='WAITING', finished_at=NULL, arrived_at=datetime('now','localtime'), arrival_method='staff' WHERE id=?").run(id);
    notify();
    return json(res, 200, { ok: true });
  }
  if (action === 'relane' && e) { // 배정 후 레인 변경: 배정 시각은 그대로 둔다
    if (e.status !== 'ASSIGNED') return json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` });
    const lanes = parseLanes(b.lanes);
    if (!lanes) return json(res, 400, LANES_ERROR);
    db.prepare('UPDATE entries SET lanes=? WHERE id=?').run(lanes, id);
    notify();
    return json(res, 200, { ok: true });
  }
  if (action === 'blacklist' && e) { // 대기 건의 번호를 블랙리스트에 올린다 (그 번호의 대기 건은 취소됨)
    const reason = String(b.reason || '').trim().slice(0, 200);
    if (!e.phone) return json(res, 400, { error: '전화번호가 없는 건은 블랙리스트에 올릴 수 없습니다.' });
    if (!reason) return json(res, 400, { error: '등록 사유를 입력하세요.' });
    addBlacklist(dp(e.phone), e.name, reason);
    return json(res, 200, { ok: true });
  }
  if ((action === 'yield' || action === 'tail') && e) { // 순서 조정: 양보(한 칸 뒤로), 맨뒤로
    if (e.status !== 'WAITING') return json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` });
    const next = db.prepare(`SELECT id, seq FROM entries WHERE status IN ${ACTIVE} AND seq > ? ORDER BY seq LIMIT 1`).get(e.seq);
    if (!next) return json(res, 409, { error: '이미 맨 뒤입니다.' });
    if (action === 'yield') {
      db.prepare('UPDATE entries SET seq=? WHERE id=?').run(next.seq, id);
      db.prepare('UPDATE entries SET seq=? WHERE id=?').run(e.seq, next.id);
    } else db.prepare('UPDATE entries SET seq=(SELECT MAX(seq)+1 FROM entries) WHERE id=?').run(id);
    notify();
    return json(res, 200, { ok: true });
  }
  const t = TRANSITIONS[action];
  if (!t || !e) return json(res, 404, { error: 'not found' });
  if (!t.from.includes(e.status)) return json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` });
  let lanes = e.lanes;
  if (action === 'assign') {
    lanes = parseLanes(b.lanes);
    if (!lanes) return json(res, 400, LANES_ERROR);
  }
  const now = "datetime('now','localtime')";
  db.prepare(`UPDATE entries SET status=?, lanes=?,
    assigned_at = CASE WHEN ?='assign' THEN ${now} ELSE assigned_at END,
    finished_at = CASE WHEN ? IN ('finish','cancel') THEN ${now} ELSE finished_at END,
    cancel_reason = CASE WHEN ?='cancel' THEN ? ELSE cancel_reason END
    WHERE id=?`).run(t.to, lanes, action, action, action, String(b.reason || '').trim().slice(0, 100) || null, id);
  notify();
  json(res, 200, { ok: true });
}

// ---- 이용약관·개인정보처리방침과 동의 이력 (C-11) ----
// 약관 본문은 관리자가 쓰고, 내용이 바뀌면 버전이 올라간다. 본문이 비어 있는 약관은 동의를 요구하지 않는다.
// 다시 동의를 받아야 하는 변경(수집 항목·이용 목적 변경 등)만 관리자가 '재동의 필요'로 저장한다.
// 그 밖의 개정은 공지로 알리고 손님을 막지 않는다(consent_version이 그대로라 기존 동의가 유효).
// 동의 기록은 지우지 않고 쌓는다(마지막 기록이 현재 상태).
db.exec(`CREATE TABLE IF NOT EXISTS policies (
  type TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  agreed INTEGER NOT NULL,
  agreed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
try { db.exec('ALTER TABLE policies ADD COLUMN consent_version INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE policies SET consent_version=version'); } catch {}
const POLICY_TYPES = { terms: '이용약관', privacy: '개인정보처리방침' };
const policyOf = (type) => db.prepare('SELECT body, version, consent_version, updated_at FROM policies WHERE type=?').get(type) || { body: '', version: 0, consent_version: 0, updated_at: null };
// 아직 현재 버전에 동의하지 않은 필수 약관 목록
const missingConsents = (userId) => Object.keys(POLICY_TYPES).filter((type) => {
  const p = policyOf(type);
  if (!p.body) return false;
  const last = db.prepare('SELECT version, agreed FROM consents WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 1').get(userId, type);
  return !(last && last.agreed && last.version >= p.consent_version); // 재동의가 필요한 버전 이후에 동의했으면 유효
});
const consentBlocked = (res, userId) => {
  if (!missingConsents(userId).length) return false;
  json(res, 403, { error: '이용약관과 개인정보 처리 동의가 필요합니다.', code: 'CONSENT_REQUIRED' });
  return true;
};

// ---- 공지사항·이벤트 이미지 (M-25). 전체 푸시는 알림톡 보류로 제외 ----
db.exec(`CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  sort INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
const MAX_BANNERS = 30, MAX_IMAGE = 3 * 1024 * 1024;
const imageMime = (b) => { // 파일 앞부분으로 형식 판별(올린 파일 이름·형식 표시는 믿지 않는다)
  if (b.length > 12 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};
const noticeRows = () => db.prepare('SELECT id, date, title, body FROM notices ORDER BY date DESC, id DESC LIMIT 200').all().map((n) => ({ id: n.id, date: n.date, title: n.title, body: n.body || '' }));
const bannerIds = () => db.prepare('SELECT id FROM banners ORDER BY sort, id').all().map((b) => ({ id: b.id }));

// ---- 행사·일정 캘린더 (M-17): 관리자가 등록하고 손님은 조회만 한다 ----
db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
const dateOk = (v) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; // 2026-13-01·2026-02-30 같은 값 거절
};
const monthOf = (q) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : new Date().toLocaleDateString('sv').slice(0, 7));
const calendarRows = (month) => db.prepare('SELECT id, date, title, memo FROM calendar_events WHERE substr(date,1,7)=? ORDER BY date, id').all(month)
  .map((e) => ({ id: e.id, date: e.date, title: e.title, memo: e.memo || '' }));

// ---- 정기 대회 참가신청 (M-18) ----
// 신청 상태: PENDING 입금 대기, CONFIRMED 확정(입금 확인), WAITLIST 대기(정원 초과), DELETED 삭제(취소·환불 메모)
// 정원은 PENDING+CONFIRMED로 센다. 자리가 나면 대기 순서대로 입금 대기로 올라간다.
db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  event_at TEXT NOT NULL,
  apply_start TEXT NOT NULL,
  apply_end TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  info TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS tournament_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT,
  deleted_at TEXT,
  delete_reason TEXT,
  refund_memo TEXT
)`);
const TS = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d$/;
const nowTs = () => new Date().toLocaleString('sv').slice(0, 16); // 2026-11-02 14:05 (서버 시간대)
const normTs = (v) => String(v || '').trim().replace('T', ' ');
const seatsTaken = (tid) => db.prepare("SELECT COUNT(*) n FROM tournament_entries WHERE tournament_id=? AND status IN ('PENDING','CONFIRMED')").get(tid).n;
const promoteWaitlist = (tid) => {
  const t = db.prepare('SELECT capacity FROM tournaments WHERE id=?').get(tid);
  const free = t ? t.capacity - seatsTaken(tid) : 0;
  if (free > 0) db.prepare("UPDATE tournament_entries SET status='PENDING' WHERE id IN (SELECT id FROM tournament_entries WHERE tournament_id=? AND status='WAITLIST' ORDER BY id LIMIT ?)").run(tid, free);
};
const applyWindow = (t, now = nowTs()) => (now < t.apply_start ? 'before' : now > t.apply_end ? 'closed' : 'open');
// 대회일 다음 날부터는 손님 목록에서 숨기고, 관리자 목록에는 지난 대회로 남긴다
const eventEnded = (t) => t.event_at.slice(0, 10) < new Date().toLocaleDateString('sv');
const tournamentApplying = () => db.prepare('SELECT * FROM tournaments').all().some((t) => applyWindow(t) === 'open');
const tournamentView = (t, userId) => {
  const mine = userId && db.prepare("SELECT status FROM tournament_entries WHERE tournament_id=? AND user_id=? AND status<>'DELETED'").get(t.id, userId);
  return {
    id: t.id, name: t.name, ended: eventEnded(t), eventAt: t.event_at, applyStart: t.apply_start, applyEnd: t.apply_end, capacity: t.capacity,
    fee: t.fee, info: t.info || '', apply: applyWindow(t), taken: seatsTaken(t.id), mine: mine?.status || null,
    waitlist: db.prepare("SELECT COUNT(*) n FROM tournament_entries WHERE tournament_id=? AND status='WAITLIST'").get(t.id).n,
  };
};
// 메인 화면 `대회신청` 버튼의 상태(PRD 5.1.1). 우선순위: 접수중 > 접수 마감(대회일 전) > 접수 예정 > 일정 없음.
// 마감 상태에는 다음에 열리는 대회가 있으면 같이 알려 준다. 목록과 시각을 받아 순수하게 계산한다(시험하기 쉽게).
const homeTournament = (list = db.prepare('SELECT * FROM tournaments').all(), now = nowTs()) => {
  const alive = list.filter((t) => !eventEnded(t));
  const view = (t, state, extra = {}) => ({ state, name: t.name, applyStart: t.apply_start, applyEnd: t.apply_end, eventAt: t.event_at, full: seatsTaken(t.id) >= t.capacity, ...extra });
  const by = (key, dir = 1) => (a, b) => dir * a[key].localeCompare(b[key]);
  const win = (w) => alive.filter((t) => applyWindow(t, now) === w);
  const open = win('open').sort(by('apply_end'))[0];
  if (open) return view(open, 'open');
  const upcoming = win('before').sort(by('apply_start'));
  const closed = win('closed').sort(by('apply_end', -1))[0];
  if (closed) return view(closed, 'closed', { next: upcoming[0] ? { name: upcoming[0].name, applyStart: upcoming[0].apply_start } : null });
  if (upcoming[0]) return view(upcoming[0], 'upcoming');
  return { state: 'none' };
};
const tournamentEntryView = (e) => ({
  id: e.id, name: e.name, phone: maskPhone(dp(e.phone)), status: e.status, appliedAt: e.applied_at, paidAt: e.paid_at || '',
  deletedAt: e.deleted_at || '', deleteReason: e.delete_reason || '', refundMemo: e.refund_memo || '', manual: e.user_id === null,
});
// 신청 접수: 정원이 남아 있으면 입금 대기, 아니면 대기. 같은 번호의 중복 신청은 막는다
const addTournamentEntry = (tid, userId, name, phone) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tid);
  const dup = db.prepare("SELECT 1 FROM tournament_entries WHERE tournament_id=? AND (phone=? OR (? IS NOT NULL AND user_id=?)) AND status<>'DELETED'").get(tid, ep(phone), userId, userId);
  if (dup) return { code: 409, error: '이미 신청한 대회입니다.' };
  const status = seatsTaken(tid) < t.capacity ? 'PENDING' : 'WAITLIST';
  db.prepare('INSERT INTO tournament_entries (tournament_id,user_id,name,phone,status) VALUES (?,?,?,?,?)').run(tid, userId, name, ep(phone), status);
  return { status };
};

async function handleTournaments(req, res, url) {
  const path = url.pathname;
  let m;
  const admin = path.startsWith('/api/admin/');
  if (admin && !isAdmin(req)) return json(res, 401, { error: 'unauthorized' }), true;

  // --- 손님 ---
  if (req.method === 'GET' && path === '/api/tournaments') {
    const user = currentUser(req);
    const rows = db.prepare('SELECT * FROM tournaments ORDER BY event_at').all().filter((t) => !eventEnded(t));
    json(res, 200, { tournaments: rows.map((t) => tournamentView(t, user?.id)) });
    return true;
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/tournaments\/(\d+)\/(apply|cancel)$/))) {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' }), true;
    const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(Number(m[1]));
    if (!t) return json(res, 404, { error: 'not found' }), true;
    if (m[2] === 'apply') {
      if (!user.phone) return json(res, 403, { error: '휴대전화 인증이 필요합니다.', code: 'PHONE_REQUIRED' }), true;
      if (consentBlocked(res, user.id)) return true;
      if (isBlacklisted(user.phone)) return json(res, 403, BLACKLISTED), true;
      if (!isFullMember(user.id, user.phone)) return json(res, 403, NOT_FULL), true;
      if (applyWindow(t) !== 'open') return json(res, 403, { error: '신청 기간이 아닙니다.', code: 'NOT_OPEN' }), true;
      const r = addTournamentEntry(t.id, user.id, user.name, user.phone);
      if (r.error) return json(res, r.code, { error: r.error }), true;
      touchUser(user.id);
      return json(res, 201, { status: r.status }), true;
    }
    // 취소: 입금 전(입금 대기·대기)만 본인이 할 수 있다. 확정 건은 매장에 문의
    const e = db.prepare("SELECT * FROM tournament_entries WHERE tournament_id=? AND user_id=? AND status<>'DELETED'").get(t.id, user.id);
    if (!e) return json(res, 404, { error: '신청 내역이 없습니다.' }), true;
    if (e.status === 'CONFIRMED') return json(res, 409, { error: '입금이 확인된 신청은 매장에 문의해 주세요.' }), true;
    db.prepare("UPDATE tournament_entries SET status='DELETED', deleted_at=datetime('now','localtime'), delete_reason='본인 취소' WHERE id=?").run(e.id);
    promoteWaitlist(t.id);
    return json(res, 200, { ok: true }), true;
  }

  // --- 관리자 ---
  if (req.method === 'GET' && path === '/api/admin/tournaments') {
    json(res, 200, { tournaments: db.prepare('SELECT * FROM tournaments ORDER BY event_at DESC').all().map((t) => ({
      ...tournamentView(t),
    })) });
    return true;
  }
  if (req.method === 'POST' && path === '/api/admin/tournaments') { // 등록·수정(id가 있으면 수정)
    const b = await readBody(req);
    const f = {
      name: String(b.name || '').trim().slice(0, 50), eventAt: normTs(b.eventAt), applyStart: normTs(b.applyStart), applyEnd: normTs(b.applyEnd),
      capacity: Number(b.capacity), fee: Number(b.fee || 0), info: String(b.info || '').trim().slice(0, 2000),
    };
    if (!f.name) return json(res, 400, { error: '대회명을 입력하세요.' }), true;
    if (![f.eventAt, f.applyStart, f.applyEnd].every((v) => TS.test(v))) return json(res, 400, { error: '일시를 확인하세요.' }), true;
    if (f.applyStart >= f.applyEnd) return json(res, 400, { error: '신청 종료는 시작보다 늦어야 합니다.' }), true;
    if (f.applyEnd > f.eventAt) return json(res, 400, { error: '신청 종료는 대회 일시보다 늦을 수 없습니다.' }), true;
    if (!Number.isInteger(f.capacity) || f.capacity < 1 || f.capacity > 500) return json(res, 400, { error: '정원은 1~500명입니다.' }), true;
    if (!Number.isInteger(f.fee) || f.fee < 0) return json(res, 400, { error: '참가비를 확인하세요.' }), true;
    let id = Number(b.id);
    if (id) {
      if (!db.prepare('SELECT 1 FROM tournaments WHERE id=?').get(id)) return json(res, 404, { error: 'not found' }), true;
      db.prepare('UPDATE tournaments SET name=?, event_at=?, apply_start=?, apply_end=?, capacity=?, fee=?, info=? WHERE id=?')
        .run(f.name, f.eventAt, f.applyStart, f.applyEnd, f.capacity, f.fee, f.info || null, id);
      promoteWaitlist(id); // 정원을 늘렸으면 대기자가 올라간다
    } else {
      id = Number(db.prepare('INSERT INTO tournaments (name,event_at,apply_start,apply_end,capacity,fee,info) VALUES (?,?,?,?,?,?,?)')
        .run(f.name, f.eventAt, f.applyStart, f.applyEnd, f.capacity, f.fee, f.info || null).lastInsertRowid);
    }
    return json(res, 200, { id }), true;
  }
  if (req.method === 'GET' && (m = path.match(/^\/api\/admin\/tournaments\/(\d+)\/entries$/))) {
    const rows = db.prepare('SELECT * FROM tournament_entries WHERE tournament_id=? ORDER BY id').all(Number(m[1]));
    json(res, 200, { entries: rows.map(tournamentEntryView) });
    return true;
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/admin\/tournaments\/(\d+)\/entries$/))) { // 현장·전화 신청 대리 등록
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 20), phone = String(b.phone || '').replace(/\D/g, '');
    if (!db.prepare('SELECT 1 FROM tournaments WHERE id=?').get(Number(m[1]))) return json(res, 404, { error: 'not found' }), true;
    if (!name) return json(res, 400, { error: '이름을 입력하세요.' }), true;
    if (!/^01\d{8,9}$/.test(phone)) return json(res, 400, { error: '휴대전화번호를 확인하세요.' }), true;
    if (isBlacklisted(phone)) return json(res, 403, { error: '블랙리스트에 등록된 번호입니다.' }), true;
    if (!isFullMember(null, phone)) return json(res, 403, { error: '정회원이 아닙니다. 회원관리에서 정회원으로 지정한 뒤 신청하세요.' }), true;
    const r = addTournamentEntry(Number(m[1]), null, name, phone);
    if (!r.error) touchPhone(phone);
    return json(res, r.error ? r.code : 201, r.error ? { error: r.error } : { status: r.status }), true;
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/admin\/tournament-entries\/(\d+)\/(confirm|unconfirm|delete|memo)$/))) {
    const b = await readBody(req);
    const e = db.prepare('SELECT * FROM tournament_entries WHERE id=?').get(Number(m[1]));
    if (!e) return json(res, 404, { error: 'not found' }), true;
    const bad = (from) => !from.includes(e.status) && (json(res, 409, { error: `${e.status} 상태에서는 불가합니다.` }), true);
    if (m[2] === 'confirm') { // 입금 확인
      if (bad(['PENDING'])) return true;
      db.prepare("UPDATE tournament_entries SET status='CONFIRMED', paid_at=datetime('now','localtime') WHERE id=?").run(e.id);
    } else if (m[2] === 'unconfirm') { // 입금 확인 취소
      if (bad(['CONFIRMED'])) return true;
      db.prepare("UPDATE tournament_entries SET status='PENDING', paid_at=NULL WHERE id=?").run(e.id);
    } else if (m[2] === 'delete') {
      if (bad(['PENDING', 'CONFIRMED', 'WAITLIST'])) return true;
      db.prepare("UPDATE tournament_entries SET status='DELETED', deleted_at=datetime('now','localtime'), delete_reason=?, refund_memo=? WHERE id=?")
        .run(String(b.reason || '').trim().slice(0, 100) || null, String(b.refundMemo || '').trim().slice(0, 200) || null, e.id);
      promoteWaitlist(e.tournament_id);
    } else { // 환불 메모만 수정
      db.prepare('UPDATE tournament_entries SET refund_memo=? WHERE id=?').run(String(b.memo || '').trim().slice(0, 200) || null, e.id);
    }
    return json(res, 200, { ok: true }), true;
  }
  return false;
}

// ---- 전화번호 암호화 이전: 아직 평문인 번호를 한 번에 암호화한다(다시 실행해도 안전) ----
const encryptExistingPhones = () => {
  db.exec('BEGIN');
  try {
    for (const t of ['entries', 'members', 'users', 'blacklist', 'tournament_entries', 'sms_codes']) {
      const rows = db.prepare(`SELECT id, phone FROM ${t} WHERE phone IS NOT NULL AND phone <> '' AND phone NOT LIKE '${ENC_PREFIX}%'`).all();
      const upd = db.prepare(`UPDATE ${t} SET phone=? WHERE id=?`);
      rows.forEach((r) => upd.run(ep(r.phone), r.id));
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
};
encryptExistingPhones();

// ---- 정기 파기 (docs/privacy-retention-policy.md): 서버 시작 때와 하루에 한 번 실행한다 ----
// 1년 지난 접수 기록의 이름·연락처·메모 익명화, 30일 지난 인증 코드·90일 지난 로그인 세션·기간 끝난 재가입 제한 삭제
const purgeExpired = () => {
  const day = 24 * 3600 * 1000;
  const r = {
    entries: db.prepare(`UPDATE entries SET name='삭제됨', phone='', memo=NULL WHERE status NOT IN ${ACTIVE}
      AND date(created_at) < date('now','localtime','-1 year') AND (name <> '삭제됨' OR phone <> '' OR memo IS NOT NULL)`).run().changes,
    smsCodes: db.prepare('DELETE FROM sms_codes WHERE created_at < ?').run(Date.now() - 30 * day).changes,
    sessions: db.prepare("DELETE FROM user_sessions WHERE created_at < datetime('now','localtime','-90 days')").run().changes,
    withdrawals: db.prepare("DELETE FROM withdrawals WHERE blocked_until <= datetime('now','localtime')").run().changes,
  };
  if (Object.values(r).some(Boolean)) console.log('정기 파기:', JSON.stringify(r));
  return r;
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // ADMIN_HOST가 있으면 관리자 호스트는 관리자 화면·API만, 그 외 호스트는 관리자 경로를 막는다.
  if (ADMIN_HOST) {
    const isAdminPath = /^\/(admin(\.html)?|qrcode\.js|api\/admin\/.*)$/.test(url.pathname);
    const onAdminHost = (req.headers.host || '').split(':')[0] === ADMIN_HOST;
    if (onAdminHost) {
      if (url.pathname === '/') url.pathname = '/admin';
      else if (!isAdminPath && url.pathname !== '/api/events' && !url.pathname.startsWith('/assets/')) return json(res, 404, { error: 'not found' });
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

    // 8ceb4af에서 잠깐 쓰던 도착 인증 QR 주소(/arrive?t=…)로 출력한 QR이 있어도 접수 화면이 열리게 한다
    if (route === 'GET /arrive') return redirect(res, '/');
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      listeners.add(res);
      return req.on('close', () => listeners.delete(res));
    }
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/auth\/(kakao|naver)(\/callback)?$/))) {
      const name = m[1];
      if (!oauth.enabled().includes(name)) return redirect(res, '/waiting?login=disabled');
      if (!m[2]) {
        const state = crypto.randomBytes(16).toString('hex');
        const next = url.searchParams.get('next') === 'tournament' ? [`login_next=tournament; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${SECURE}`] : [];
        return redirect(res, oauth.authorizeUrl(name, state),
          [`oauth_state=${name}.${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${SECURE}`, ...next]);
      }
      const state = url.searchParams.get('state');
      const clear = `oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`;
      if (!state || cookie(req, 'oauth_state') !== `${name}.${state}` || !url.searchParams.get('code'))
        return redirect(res, '/waiting?login=failed', [clear]);
      let profile;
      try { profile = await oauth.fetchProfile(name, url.searchParams.get('code'), state); }
      catch (err) { console.error(name, 'login failed:', err.message); return redirect(res, '/waiting?login=failed', [clear]); }
      let uid = identityOwner(name, profile.id);
      if (!uid && rejoinBlockedUntil({ providerKey: `${name}:${profile.id}` })) return redirect(res, '/waiting?login=withdrawn', [clear]);
      if (uid) db.prepare('UPDATE users SET name=? WHERE id=? AND provider=?').run(profile.name || '손님', uid, name); // 이름은 처음 가입한 플랫폼의 값만 갱신
      else {
        uid = Number(db.prepare('INSERT INTO users (provider,provider_id,name) VALUES (?,?,?)').run(name, profile.id, profile.name || '손님').lastInsertRowid);
        db.prepare('INSERT INTO user_identities (user_id,provider,provider_id) VALUES (?,?,?)').run(uid, name, profile.id);
      }
      const u = { id: uid };
      touchUser(u.id);
      const sid = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO user_sessions (token,user_id) VALUES (?,?)').run(sid, u.id);
      const back = cookie(req, 'login_next') === 'tournament' ? '/tournament' : '/waiting';
      return redirect(res, back, [clear, `login_next=; Path=/; Max-Age=0${SECURE}`, `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7776000${SECURE}`]);
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/banner\/(\d+)$/))) {
      const b = db.prepare('SELECT mime, data FROM banners WHERE id=?').get(Number(m[1]));
      if (!b) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': b.mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(b.data);
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/entries\/([0-9a-f]+)$/))) {
      expireUnarrived();
      const e = db.prepare('SELECT * FROM entries WHERE token=?').get(m[1]);
      return e ? json(res, 200, publicView(e)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/entries\/([0-9a-f]+)\/cancel$/))) {
      const e = db.prepare('SELECT * FROM entries WHERE token=?').get(m[1]);
      if (!e) return json(res, 404, { error: 'not found' });
      if (e.status !== 'WAITING')
        return json(res, 409, { error: '취소할 수 없는 상태입니다.' });
      db.prepare("UPDATE entries SET status='CANCELED', finished_at=datetime('now','localtime') WHERE id=?").run(e.id);
      notify();
      return json(res, 200, { ok: true });
    }
    if (/^\/api\/(admin\/)?tournament/.test(url.pathname) && await handleTournaments(req, res, url)) return;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/admin\/entries\/(\d+)\/(\w+)$/)))
      return await handleAction(req, res, Number(m[1]), m[2]);

    if (req.method === 'GET') {
      const page = { '/': 'home.html', '/waiting': 'index.html', '/admin': 'admin.html', '/tournament': 'tournament.html', '/calendar': 'calendar.html', '/notice': 'notice.html', '/terms': 'policy.html', '/privacy': 'policy.html' }[url.pathname];
      const file = page || url.pathname.slice(1);
      const full = path.join(PUBLIC, file);
      if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        // /assets/ 파일 이름에는 내용 해시가 붙어 있어 오래 캐시해도 된다
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
          ...(file.startsWith('assets/') ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}),
        });
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
  purgeExpired();
  setInterval(purgeExpired, 24 * 3600 * 1000).unref();
  server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}  (관리자: /admin)`);
    if (!process.env.ADMIN_PASSWORD) console.log('주의: 기본 관리자 비밀번호 사용 중. ADMIN_PASSWORD 환경변수를 설정하세요.');
  });
}
server.oauth = oauth;
server.purgeExpired = purgeExpired;
server.expireUnarrived = expireUnarrived;
server.setNoshowEnforce = (on) => { const old = NOSHOW_ENFORCE; NOSHOW_ENFORCE = on; return old; }; // 테스트용
server.homeTournament = homeTournament;
server.encryptExistingPhones = encryptExistingPhones;
server.ep = ep;
server.db = db;
module.exports = server;
