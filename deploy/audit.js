#!/usr/bin/env node
// 개발자용 감사 기록 조회 (읽기 전용). 서버에서 실행한다:
//   sudo -u waiting node --env-file=/etc/waiting-web.env /opt/waiting-web/deploy/audit.js pii [--q 이름] [--limit 100]
//   sudo -u waiting node --env-file=/etc/waiting-web.env /opt/waiting-web/deploy/audit.js consents [--q 이름] [--limit 100]
// pii      원문 조회 기록: 누가(IP) 언제 어떤 대상의 원문을 어떤 사유로 봤는지
// consents 동의 기록: 약관·마케팅 동의와 철회 이력
// DB 경로는 DB_FILE 환경변수(기본 /var/lib/waiting-web/waiting.db). DB를 수정하지 않는다.
const { DatabaseSync } = require('node:sqlite');

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 && rest[i + 1] ? rest[i + 1] : def; };
const limit = Math.min(Math.max(Number(opt('limit', 100)) || 100, 1), 5000);
const q = opt('q', '').trim();

if (!['pii', 'consents'].includes(cmd)) {
  console.error('사용법: audit.js <pii|consents> [--q 이름] [--limit 100]');
  process.exit(1);
}
const db = new DatabaseSync(process.env.DB_FILE || '/var/lib/waiting-web/waiting.db', { readOnly: true });
const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

if (cmd === 'pii') {
  const tables = { member: ['members', '회원'], entry: ['entries', '대기·이력'], blacklist: ['blacklist', '블랙리스트'], tournament: ['tournament_entries', '대회 신청'] };
  const rows = db.prepare('SELECT member_id, target, reason, ip, viewed_at FROM pii_view_log ORDER BY id DESC').all()
    .map((l) => {
      const [table, label] = tables[l.target] || [];
      const name = table ? db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(l.member_id)?.name || '' : '';
      return { 시각: l.viewed_at.slice(0, 16), 대상: label || l.target, 이름: name, 사유: l.reason || '(사유 없음: 비밀번호 방식 때 기록)', IP: l.ip || '' };
    })
    .filter((r) => !q || r.이름.includes(q) || r.사유.includes(q))
    .slice(0, limit);
  console.table(rows);
  console.log(`${rows.length}건 (최신순)`);
} else {
  const label = { terms: '이용약관', privacy: '개인정보처리방침', marketing: '마케팅 수신' };
  const rows = db.prepare(`SELECT c.type, c.version, c.agreed, c.agreed_at, u.name, u.provider FROM consents c LEFT JOIN users u ON u.id=c.user_id
    ${q ? "WHERE u.name LIKE ? ESCAPE '\\'" : ''} ORDER BY c.id DESC LIMIT ?`).all(...(q ? [like] : []), limit)
    .map((c) => ({ 시각: c.agreed_at.slice(0, 16), 이름: c.name || '(탈퇴)', 로그인: c.provider || '', 항목: label[c.type] || c.type, 버전: c.type === 'marketing' ? '-' : `v${c.version}`, 결과: c.agreed ? '동의' : '철회' }));
  console.table(rows);
  console.log(`${rows.length}건 (최신순)`);
}
