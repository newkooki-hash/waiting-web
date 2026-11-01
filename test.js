// 흐름 검증: 소셜 로그인(모의 제공자) → 접수 → 호출 → 배정, 검증 규칙
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.SMS_MAX_PER_PHONE_DAY = '1'; // 번호당 발송 한도 검증용
const assert = require('node:assert/strict');
const http = require('node:http');
const server = require('./server');
const sms = require('./sms');
let lastCode;
sms.driver = async (to, text) => { lastCode = text.match(/\d{6}/)[0]; };

// 카카오를 흉내 내는 모의 OAuth 서버
let mockId = 777;
const mock = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'tok' }));
  if (req.url === '/me') {
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
    return res.end(JSON.stringify({ id: mockId, kakao_account: { profile: { nickname: '홍길동' } } }));
  }
  res.statusCode = 404; res.end('{}');
});

mock.listen(0, () => server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const k = server.oauth.providers.kakao;
  const mockBase = `http://localhost:${mock.address().port}`;
  Object.assign(k, { clientId: 'cid', tokenUrl: mockBase + '/token', profileUrl: mockBase + '/me' });

  const jar = {};
  const call = async (method, url, body, opts = {}) => {
    const r = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', cookie: Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ') },
      body: body && JSON.stringify(body),
    });
    for (const sc of r.headers.getSetCookie()) {
      const [n, v] = sc.split(';')[0].split('=');
      if (v) jar[n] = v; else delete jar[n];
    }
    return { status: r.status, location: r.headers.get('location'), body: opts.raw ? null : await r.json().catch(() => ({})) };
  };
  try {
    // --- 소셜 로그인 ---
    assert.equal((await call('POST', '/api/entries', { name: '가', phone: '01011112222', partySize: 2 })).status, 401);
    assert.deepEqual((await call('GET', '/api/me')).body.providers.map((p) => p.id), ['kakao']);
    const start = await call('GET', '/auth/kakao', null, { raw: true });
    assert.equal(start.status, 302);
    assert.match(start.location, /^https:\/\/kauth\.kakao\.com\/oauth\/authorize\?.*client_id=cid/);
    assert.equal((await call('GET', '/auth/kakao/callback?code=c&state=wrong', null, { raw: true })).location, '/?login=failed');
    // 실패한 시도는 state 쿠키를 지우므로 다시 시작
    const state2 = new URL((await call('GET', '/auth/kakao', null, { raw: true })).location).searchParams.get('state');
    const cb = await call('GET', `/auth/kakao/callback?code=c&state=${state2}`, null, { raw: true });
    assert.equal(cb.location, '/');
    assert.equal((await call('GET', '/api/me')).body.user.name, '홍길동');

    // --- 접수 QR 토큰·접수 on/off ---
    assert.equal((await call('GET', '/api/admin/intake')).status, 401);
    assert.equal((await call('POST', '/api/phone/send', { phone: '01011112222' })).body.code, 'QR_REQUIRED');
    assert.equal((await call('POST', '/api/entries', { partySize: 2 })).body.code, 'QR_REQUIRED');
    assert.equal((await call('GET', '/api/me')).body.intake.allowed, false);
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    const qrToken = () => call('GET', '/api/admin/intake').then((r) => new URL(r.body.url).searchParams.get('t'));
    const scan = (t) => call('GET', `/?t=${t}`, null, { raw: true });
    assert.equal((await scan('wrong')).location, '/?qr=invalid');
    assert.equal((await call('GET', '/api/me')).body.intake.allowed, false); // 틀린 토큰은 쿠키를 주지 않음
    const oldToken = await qrToken();
    assert.equal((await scan(oldToken)).location, '/');
    assert.equal((await call('GET', '/api/me')).body.intake.allowed, true);
    assert.equal((await call('POST', '/api/admin/intake/open', { open: false })).body.open, false);
    assert.equal((await call('POST', '/api/entries', { partySize: 2 })).body.code, 'INTAKE_CLOSED');
    assert.equal((await call('GET', '/api/me')).body.intake.open, false);
    assert.equal((await call('POST', '/api/admin/intake/open', { open: true })).body.open, true);
    await call('POST', '/api/admin/intake/rotate'); // 토큰 갱신: 이전 QR·쿠키는 무효
    assert.notEqual(await qrToken(), oldToken);
    assert.equal((await call('GET', '/api/me')).body.intake.allowed, false);
    assert.equal((await scan(await qrToken())).location, '/');
    assert.equal((await call('GET', '/api/me')).body.intake.allowed, true);
    delete jar.admin; // 아래 관리자 섹션에서 다시 로그인
    // 관리자 세션은 DB에 저장되고 쓸 때마다 쿠키 만료(7일)가 연장된다
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    const roll = await fetch(base + '/api/admin/intake', { headers: { cookie: `admin=${jar.admin}` } });
    assert.match(roll.headers.getSetCookie().join(';'), /admin=.*Max-Age=604800/);
    assert.equal((await fetch(base + '/api/admin/intake', { headers: { cookie: 'admin=bogus' } })).status, 401);
    delete jar.admin;

    // --- 접수 가능 시간 ---
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    const sched = (enabled, start, end) => call('POST', '/api/admin/intake/schedule', { enabled, start, end });
    const hm = (m) => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    assert.equal((await sched(true, '9:00', '18:00')).status, 400); // 형식 오류
    assert.equal((await sched(true, '10:00', '10:00')).status, 400);
    assert.equal((await sched(true, hm(nowMin + 60), hm(nowMin + 120))).body.openNow, false); // 시간대 밖
    assert.equal((await call('GET', '/api/me')).body.intake.open, false);
    assert.match((await call('GET', '/api/me')).body.intake.window, /^\d\d:\d\d~\d\d:\d\d$/);
    assert.equal((await call('POST', '/api/phone/send', { phone: '01011112222' })).body.code, 'INTAKE_CLOSED');
    assert.equal((await sched(true, hm(nowMin - 60), hm(nowMin + 60))).body.openNow, true); // 시간대 안
    // 시작 > 종료는 자정을 넘기는 시간대: 지금+1시간 시작 ~ 지금-1시간 종료이면 지금은 그 밖이다
    assert.equal((await sched(true, hm(nowMin + 60), hm(nowMin - 60))).body.openNow, false);
    assert.equal((await sched(true, hm(nowMin - 60), hm(nowMin - 120))).body.openNow, true); // 지금-1시간 시작 ~ 다음날 지금-2시간 종료
    assert.equal((await sched(false)).body.openNow, true);
    delete jar.admin;

    // --- 휴대전화 인증 ---
    assert.equal((await call('POST', '/api/entries', { partySize: 2 })).body.code, 'PHONE_REQUIRED');
    assert.equal((await call('POST', '/api/phone/send', { phone: '123' })).status, 400);
    assert.equal((await call('POST', '/api/phone/send', { phone: '010-1111-2222' })).status, 200);
    assert.equal((await call('POST', '/api/phone/send', { phone: '01011112222' })).status, 429); // 재발송 간격
    assert.equal((await call('POST', '/api/phone/verify', { code: lastCode === '000000' ? '111111' : '000000' })).status, 400);
    assert.equal((await call('POST', '/api/phone/verify', { code: lastCode })).status, 200);
    assert.equal((await call('GET', '/api/me')).body.user.phone, '010-****-2222');
    assert.equal((await call('POST', '/api/phone/verify', { code: lastCode })).status, 400); // 재사용 불가

    // --- 접수 ---
    assert.equal((await call('POST', '/api/entries', { partySize: 9 })).status, 400);
    const a = await call('POST', '/api/entries', { phone: '01000000000', partySize: 4 }); // 본문의 번호는 무시, 인증된 번호 사용
    assert.equal(a.status, 201);
    assert.equal((await call('GET', '/api/me')).body.activeToken, a.body.token);
    // 같은 계정의 중복 접수는 번호를 바꿔도 막는다
    assert.equal((await call('POST', '/api/entries', { partySize: 1 })).status, 409);

    // 두 번째 손님: 로그인 쿠키만 바꿔서 접수
    const userSid = jar.sid;
    await call('POST', '/api/logout');
    assert.equal((await call('GET', '/api/me')).body.user, null);
    const st2 = new URL((await call('GET', '/auth/kakao', null, { raw: true })).location).searchParams.get('state');
    await call('GET', `/auth/kakao/callback?code=c&state=${st2}`, null, { raw: true });
    assert.notEqual(jar.sid, userSid); // 재로그인은 새 세션
    assert.equal((await call('GET', '/api/me')).body.activeToken, a.body.token); // 같은 계정이므로 접수 유지

    // --- 관리자 ---
    assert.equal((await call('GET', '/api/admin/entries')).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'x' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'other', password: 'pw' })).status, 401); // 아이디도 맞아야 한다
    assert.equal((await call('POST', '/api/admin/login', { password: 'pw' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    const list = (await call('GET', '/api/admin/entries')).body.entries;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '홍길동');
    assert.equal(list[0].phone, '01011112222');
    const ida = list[0].id;

    assert.equal((await call('POST', `/api/admin/entries/${ida}/call`)).status, 200);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/call`)).status, 409);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/assign`, { lanes: '19' })).status, 400);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/assign`, { lanes: '6,5' })).status, 200);
    assert.equal((await call('GET', `/api/entries/${a.body.token}`)).body.lanes, '5,6');
    const after = (await call('GET', '/api/admin/entries')).body.entries;
    assert.ok(after.every((e) => e.status === 'ASSIGNED' && e.assignedAt)); // 배정 완료 목록으로 이동
    assert.equal((await call('POST', `/api/entries/${a.body.token}/cancel`)).status, 409); // 이미 배정됨
    // 배정이 끝나면 다시 접수 가능
    assert.equal((await call('POST', '/api/entries', { partySize: 1 })).status, 201);
    // --- 수기 등록·인원/메모 수정·취소 사유·이력 조회 ---
    const manual = (b) => call('POST', '/api/admin/entries', b);
    assert.equal((await manual({ name: '', partySize: 2 })).status, 400);
    assert.equal((await manual({ name: '김수기', phone: '123', partySize: 2 })).status, 400);
    assert.equal((await manual({ name: '김수기', partySize: 9 })).status, 400);
    assert.equal((await manual({ name: '김수기', phone: '01055556666', partySize: 3, memo: '신발 3' })).status, 201);
    assert.equal((await manual({ name: '김수기', phone: '010-5555-6666', partySize: 3 })).status, 409); // 대기 중 중복
    assert.equal((await manual({ name: '번호없음', partySize: 1 })).status, 201); // 전화는 선택
    const live = (await call('GET', '/api/admin/entries')).body.entries;
    const m = live.find((e) => e.name === '김수기');
    assert.ok(m.manual && m.memo === '신발 3');
    assert.equal((await call('POST', `/api/admin/entries/${m.id}/edit`, { partySize: 9 })).status, 400);
    assert.equal((await call('POST', `/api/admin/entries/${m.id}/edit`, { partySize: 4, memo: '' })).status, 200);
    const edited = (await call('GET', '/api/admin/entries')).body.entries.find((e) => e.id === m.id);
    assert.equal(edited.partySize, 4);
    assert.equal(edited.memo, '');
    assert.equal((await call('POST', `/api/admin/entries/${m.id}/cancel`, { reason: '연락 두절' })).status, 200);
    assert.equal((await call('POST', `/api/admin/entries/${m.id}/edit`, { partySize: 2 })).status, 409); // 취소 건은 수정 불가
    const hist = (await call('GET', '/api/admin/history')).body.entries;
    const hc = hist.find((e) => e.id === m.id);
    assert.ok(hc.manual && hc.status === 'CANCELED' && hc.cancelReason === '연락 두절');
    assert.equal(hist.find((e) => e.id === ida).waitMin, 0);
    assert.deepEqual((await call('GET', '/api/admin/history?lane=5')).body.entries.map((e) => e.id), [ida]);
    assert.deepEqual((await call('GET', '/api/admin/history?lane=1')).body.entries, []);
    assert.equal((await call('GET', '/api/admin/history?q=김수기')).body.entries.length, 1);
    assert.equal((await call('GET', '/api/admin/history?from=2000-01-01')).body.entries.length, 0);
    const csv = await fetch(base + '/api/admin/history?format=csv', { headers: { cookie: `admin=${jar.admin}` } });
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    assert.deepEqual([...new Uint8Array(await csv.arrayBuffer()).slice(0, 3)], [0xEF, 0xBB, 0xBF]); // 엑셀용 BOM
    assert.equal((await fetch(base + '/api/admin/history')).status, 401);
    assert.equal((await fetch(base + '/api/admin/entries', { method: 'POST' })).status, 401);
    // --- 순서 조정: 양보·맨뒤로 ---
    const order = async () => (await call('GET', '/api/admin/entries')).body.entries.filter((e) => e.status !== 'ASSIGNED');
    const [first, second] = await order();
    assert.equal((await call('POST', `/api/admin/entries/${second.id}/yield`)).status, 409); // 이미 맨 뒤
    assert.equal((await call('POST', `/api/admin/entries/${first.id}/call`)).status, 200);
    assert.equal((await call('POST', `/api/admin/entries/${first.id}/yield`)).status, 200);
    let now = await order();
    assert.deepEqual(now.map((e) => e.id), [second.id, first.id]);
    assert.equal(now[1].status, 'WAITING'); // 호출된 건이 양보하면 대기로 돌아간다
    assert.equal((await call('POST', `/api/admin/entries/${second.id}/tail`)).status, 200);
    assert.deepEqual((await order()).map((e) => e.id), [first.id, second.id]);
    assert.equal((await call('POST', `/api/admin/entries/${m.id}/yield`)).status, 409); // 취소 건은 불가
    const pos = (await call('GET', `/api/entries/${(await call('GET', '/api/me')).body.activeToken}`)).body;
    assert.ok(pos.position === 1 || pos.position === 2);
    // --- 블랙리스트 ---
    const qrEntry = (await order()).find((e) => e.phone === '01011112222');
    const noPhone = (await order()).find((e) => !e.phone);
    assert.equal((await call('POST', `/api/admin/entries/${noPhone.id}/blacklist`, { reason: '테스트' })).status, 400); // 번호 없음
    assert.equal((await call('POST', `/api/admin/entries/${qrEntry.id}/blacklist`, { reason: ' ' })).status, 400); // 사유 필수
    assert.equal((await call('POST', `/api/admin/entries/${qrEntry.id}/blacklist`, { reason: '반복 노쇼' })).status, 200);
    const bl = (await call('GET', '/api/admin/blacklist')).body.entries;
    assert.equal(bl.length, 1);
    assert.equal(bl[0].reason, '반복 노쇼');
    assert.ok(!(await order()).some((e) => e.id === qrEntry.id)); // 대기 중이던 건은 취소됨
    const blocked = await call('POST', '/api/entries', { partySize: 1 });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'BLACKLISTED');
    assert.ok(!JSON.stringify(blocked.body).includes('노쇼')); // 사유는 손님에게 보이지 않는다
    assert.equal((await manual({ name: '다른이름', phone: '010-1111-2222', partySize: 1 })).status, 403);
    assert.equal((await call('POST', '/api/admin/blacklist', { phone: '010-1111-2222', reason: '사유 갱신' })).status, 200); // 같은 번호는 갱신
    assert.equal((await call('GET', '/api/admin/blacklist')).body.entries.length, 1);
    assert.equal((await call('POST', '/api/admin/blacklist', { phone: '123', reason: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/admin/blacklist/remove', { id: bl[0].id })).status, 200);
    assert.equal((await manual({ name: '해제후', phone: '01011112222', partySize: 1 })).status, 201);
    assert.equal((await fetch(base + '/api/admin/blacklist')).status, 401);
    // --- 배정 후 레인 변경 ---
    const assigned = async () => (await call('GET', '/api/admin/entries')).body.entries.find((e) => e.id === ida);
    const at = (await assigned()).assignedAt;
    assert.equal((await call('POST', `/api/admin/entries/${ida}/relane`, { lanes: '19' })).status, 400);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/relane`, { lanes: '9, 3' })).status, 200);
    assert.equal((await assigned()).lanes, '3,9');
    assert.equal((await assigned()).assignedAt, at); // 배정 시각은 유지
    assert.equal((await call('POST', `/api/admin/entries/${first.id}/relane`, { lanes: '1' })).status, 409); // 대기 건은 불가
    // --- 회원: 번호 인증 시 연결, CSV 가져오기, 마스킹, 원문 조회 ---
    const members = async (q = '') => (await call('GET', `/api/admin/members${q}`)).body;
    assert.equal((await fetch(base + '/api/admin/members')).status, 401);
    const signup = (await members()).entries.find((m) => m.name === '홍길동'); // 번호 인증을 마친 가입자가 회원으로 추가됨
    assert.ok(signup.linked && signup.source === '가입');
    assert.equal(signup.phone, '010-****-2222');
    assert.equal((await call('POST', '/api/admin/members/import', { csv: 'a,b\n1,2' })).status, 400); // 필수 열 없음
    const memberCsv = [
      '﻿uidx,name,phone,email,gender,birth_year,joined_at,last_login',
      '1,김이관,010-2222-3333,kim@example.com,남,1980,2024-11-01 10:00:00,',
      '2,"이,쉼표",01044445555,,여,,2025-01-02,', // 출생연도·이메일 공란 허용, 따옴표 안 쉼표
      '3,중복파일,01022223333,,,,,', // 파일 안 중복
      '4,기존번호,01011112222,,,,,', // 이미 있는 번호(가입자)
      '5,번호오류,123,,,,,',
      '6,메일오류,01066667777,nomail,,,,',
      '7,글자연도,01088889999,,,2001.04.11,,',
      '8,,01012341234,,,,,', // 이름 없음
    ].join('\r\n');
    const rep = (await call('POST', '/api/admin/members/import', { csv: memberCsv })).body;
    assert.deepEqual([rep.total, rep.imported, rep.duplicate, rep.errors.length], [8, 3, 2, 3]);
    assert.deepEqual(rep.errors.map((e) => e.line), [6, 7, 9]);
    const again = (await call('POST', '/api/admin/members/import', { csv: memberCsv })).body; // 재업로드는 모두 건너뜀
    assert.deepEqual([again.imported, again.duplicate], [0, 5]);
    const found = (await members('?q=쉼표')).entries;
    assert.equal(found.length, 1);
    assert.equal(found[0].phone, '010-****-5555');
    assert.equal(found[0].email, '');
    assert.equal(found[0].age, null);
    const kim = (await members('?q=2222-3333')).entries; // 검색은 원문 번호로도 되지만 숫자만 입력한 것과는 다르다
    assert.equal(kim.length, 0);
    const kim2 = (await members('?q=01022223333')).entries[0];
    assert.equal(kim2.email, 'k**@example.com');
    assert.equal(kim2.age, new Date().getFullYear() - 1980);
    assert.equal((await members('?q=김이관')).total, 1);
    assert.equal((await call('POST', '/api/admin/members/reveal', { id: kim2.id, password: 'wrong' })).status, 401);
    const shown = await call('POST', '/api/admin/members/reveal', { id: kim2.id, password: 'pw' });
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body, { phone: '01022223333', email: 'kim@example.com' });
    assert.equal((await call('POST', '/api/admin/members/reveal', { id: 99999, password: 'pw' })).status, 404);
    assert.equal((await fetch(base + '/api/admin/members/reveal', { method: 'POST' })).status, 401);
    // --- 정기 대회 신청 ---
    const ts = (min) => new Date(Date.now() + min * 60000).toLocaleString('sv').slice(0, 16);
    const tour = (b) => call('POST', '/api/admin/tournaments', { name: '11월 챔프전', eventAt: ts(60 * 24 * 7), applyStart: ts(-60), applyEnd: ts(60), capacity: 2, fee: 30000, info: '국민 000', ...b });
    assert.equal((await fetch(base + '/api/admin/tournaments')).status, 401);
    assert.equal((await tour({ name: '' })).status, 400);
    assert.equal((await tour({ capacity: 0 })).status, 400);
    assert.equal((await tour({ applyStart: ts(60), applyEnd: ts(-60) })).status, 400); // 종료가 시작보다 빠름
    assert.equal((await tour({ eventAt: 'soon' })).status, 400);
    const tid = (await tour()).body.id;
    const future = (await tour({ name: '다음 대회', applyStart: ts(60), applyEnd: ts(120) })).body.id;
    const listed = (await call('GET', '/api/tournaments')).body.tournaments;
    assert.equal(listed.find((t) => t.id === tid).apply, 'open');
    assert.equal(listed.find((t) => t.id === future).apply, 'before');
    assert.equal(listed.find((t) => t.id === tid).mine, null);
    const entriesOf = async () => (await call('GET', `/api/admin/tournaments/${tid}/entries`)).body.entries;
    const statusOf = async (name) => (await entriesOf()).find((e) => e.name === name && e.status !== 'DELETED')?.status;
    // 대회는 정회원만 신청할 수 있다
    assert.equal((await call('GET', '/api/me')).body.user.fullMember, false);
    assert.equal((await call('POST', `/api/tournaments/${tid}/apply`)).body.code, 'MEMBER_REQUIRED');
    // 정회원 가입: 본인이 생년월일·성별을 입력하면 바로 정회원이 되고 변경 이력이 남는다
    assert.equal((await fetch(base + '/api/tournament-profile')).status, 401);
    const me0 = (await call('GET', '/api/tournament-profile')).body;
    assert.deepEqual([me0.fullMember, me0.birthDate, me0.gender], [false, '', '']);
    for (const bad of [{ birthDate: '1990-13-01', gender: 'm' }, { birthDate: '2999-01-01', gender: 'm' }, { birthDate: '1899-12-31', gender: 'm' }, { birthDate: '1990-02-30', gender: 'm' }, { birthDate: '', gender: 'm' }, { birthDate: '1990-05-17', gender: 'x' }]) {
      assert.equal((await call('POST', '/api/tournament-profile', bad)).status, 400);
    }
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1990-05-17', gender: 'm' })).status, 200);
    assert.equal((await call('GET', '/api/me')).body.user.fullMember, true);
    assert.deepEqual((({ fullMember, birthDate, gender }) => ({ fullMember, birthDate, gender }))((await call('GET', '/api/tournament-profile')).body), { fullMember: true, birthDate: '1990-05-17', gender: 'm' });
    const prof = (await members('?q=홍길동')).entries[0];
    assert.deepEqual([prof.tier, prof.gender, prof.birthDate, prof.age], ['정회원', '남', '1990-05-17', new Date().getFullYear() - 1990]);
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1990-05-17', gender: 'm' })).status, 200); // 같은 값 재저장은 이력을 늘리지 않는다
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1991-01-02', gender: 'm' })).status, 200); // 수정 가능, 이력 기록
    const hist2 = (await call('GET', `/api/admin/members/log?id=${prof.id}`)).body.entries;
    assert.deepEqual(hist2.map((e) => [e.field, e.oldValue, e.newValue, e.changedBy]), [
      ['생년월일', '1990-05-17', '1991-01-02', '본인'],
      ['등급', '일반', '정회원', '본인'], ['성별', null, 'm', '본인'], ['생년월일', null, '1990-05-17', '본인'],
    ]);
    assert.equal((await fetch(base + `/api/admin/members/log?id=${prof.id}`)).status, 401);
    assert.equal((await call('POST', '/api/admin/members/tier', { id: prof.id, tier: '일반' })).status, 200); // 관리자 해제도 이력
    const last = (await call('GET', `/api/admin/members/log?id=${prof.id}`)).body.entries[0];
    assert.deepEqual([last.field, last.oldValue, last.newValue, last.changedBy], ['등급', '정회원', '일반', '관리자']);
    assert.equal((await call('GET', '/api/me')).body.user.fullMember, false);
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1991-01-02', gender: 'm' })).status, 200); // 다시 가입
    assert.equal((await call('POST', `/api/tournaments/${tid}/entries`)).status, 404); // 없는 경로
    assert.equal((await call('POST', `/api/admin/tournaments/${tid}/entries`, { name: '김대리', phone: '01070001000' })).status, 403); // 회원 아님
    await call('POST', '/api/admin/members/import', { csv: ['name,phone', '김대리,01070001000', '박대기,01070002000', '최대기,01070003000'].join('\r\n') });
    const everyone = (await members()).entries;
    assert.equal((await call('POST', '/api/admin/members/tier', { id: everyone[0].id, tier: '평회원' })).status, 400);
    assert.equal((await call('POST', '/api/admin/members/tier', { id: 99999, tier: '정회원' })).status, 404);
    assert.equal((await call('POST', `/api/admin/tournaments/${tid}/entries`, { name: '김대리', phone: '01070001000' })).status, 403); // 일반회원
    for (const name of ['홍길동', '김대리', '박대기', '최대기']) {
      assert.equal((await call('POST', '/api/admin/members/tier', { id: everyone.find((m) => m.name === name).id, tier: '정회원' })).status, 200);
    }
    assert.equal((await call('GET', '/api/me')).body.user.fullMember, true);
    assert.equal((await members('?q=홍길동')).entries[0].tier, '정회원');
    assert.equal((await call('POST', `/api/tournaments/${future}/apply`)).body.code, 'NOT_OPEN');
    assert.equal((await call('POST', `/api/tournaments/${tid}/apply`)).status, 201); // 로그인한 홍길동, 정원 2 중 1
    assert.equal((await call('POST', `/api/tournaments/${tid}/apply`)).status, 409);
    assert.equal((await call('GET', '/api/tournaments')).body.tournaments.find((t) => t.id === tid).mine, 'PENDING');
    const addT = (name, phone) => call('POST', `/api/admin/tournaments/${tid}/entries`, { name, phone });
    assert.equal((await addT('김대리', '01070001000')).body.status, 'PENDING'); // 정원 2 가득
    assert.equal((await addT('박대기', '01070002000')).body.status, 'WAITLIST'); // 정원 초과는 대기
    assert.equal((await addT('김대리', '010-7000-1000')).status, 409);
    assert.equal((await addT('이름', '123')).status, 400);
    assert.equal((await call('GET', '/api/tournaments')).body.tournaments.find((t) => t.id === tid).taken, 2);
    let rows = await entriesOf();
    const mineId = rows.find((e) => e.name === '홍길동').id, proxyId = rows.find((e) => e.name === '김대리').id;
    const act = (id, a, b) => call('POST', `/api/admin/tournament-entries/${id}/${a}`, b);
    assert.equal((await act(mineId, 'confirm')).status, 200); // 입금 확인
    assert.equal((await act(mineId, 'confirm')).status, 409);
    assert.equal((await call('POST', `/api/tournaments/${tid}/cancel`)).status, 409); // 확정 건은 본인이 취소 불가
    assert.equal((await act(proxyId, 'delete', { reason: '불참', refundMemo: '환불 계좌 전달' })).status, 200);
    assert.equal(await statusOf('박대기'), 'PENDING'); // 자리가 나서 대기자가 올라감
    const del = (await entriesOf()).find((e) => e.id === proxyId);
    assert.deepEqual([del.status, del.deleteReason, del.refundMemo], ['DELETED', '불참', '환불 계좌 전달']);
    assert.equal((await act(proxyId, 'delete')).status, 409);
    assert.equal((await act(proxyId, 'memo', { memo: '환불 완료' })).status, 200);
    assert.equal((await entriesOf()).find((e) => e.id === proxyId).refundMemo, '환불 완료');
    assert.equal((await act(mineId, 'unconfirm')).status, 200);
    assert.equal(await statusOf('홍길동'), 'PENDING');
    assert.equal((await addT('최대기', '01070003000')).body.status, 'WAITLIST');
    assert.equal((await tour({ id: tid, capacity: 3 })).status, 200); // 정원을 늘리면 대기자가 올라간다
    assert.equal(await statusOf('최대기'), 'PENDING');
    assert.equal((await call('POST', `/api/tournaments/${tid}/cancel`)).status, 200); // 입금 전에는 본인 취소 가능
    assert.equal(await statusOf('홍길동'), undefined);
    assert.equal((await call('POST', `/api/tournaments/${tid}/cancel`)).status, 404);
    assert.equal((await call('POST', `/api/tournaments/${tid}/apply`)).status, 201); // 취소 후 다시 신청
    assert.equal((await call('POST', `/api/tournaments/99999/apply`)).status, 404);
    assert.equal((await act(99999, 'confirm')).status, 404);
    // 접수가 중지되어도 대회 신청 기간에는 QR 없이 번호 인증을 받을 수 있다
    await call('POST', '/api/admin/intake/open', { open: false });
    assert.equal((await call('POST', '/api/phone/send', { phone: '123' })).body.code, 'INTAKE_CLOSED');
    assert.equal((await call('POST', '/api/phone/send', { phone: '123', for: 'tournament' })).status, 400);
    assert.equal((await call('POST', '/api/phone/send', { phone: '123', for: 'tournament' })).body.code, undefined);
    await call('POST', '/api/admin/intake/open', { open: true });
    // 로그아웃하면 세션이 무효가 된다
    const sess = jar.admin;
    assert.equal((await call('POST', '/api/admin/logout')).status, 200);
    assert.equal((await fetch(base + '/api/admin/entries', { headers: { cookie: `admin=${sess}` } })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    // --- 인증번호 발송 한도: 한 번호로 다른 계정이 연달아 요청하면 막는다 ---
    const login = async (id) => {
      mockId = id;
      await call('POST', '/api/logout');
      const st = new URL((await call('GET', '/auth/kakao', null, { raw: true })).location).searchParams.get('state');
      await call('GET', `/auth/kakao/callback?code=c&state=${st}`, null, { raw: true });
    };
    await login(888);
    assert.equal((await call('POST', '/api/phone/send', { phone: '01099998888' })).status, 200);
    await login(999);
    const limited = await call('POST', '/api/phone/send', { phone: '01099998888' });
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /횟수/);
    // --- 관리자 로그인 시도 제한: 5회 실패하면 올바른 비밀번호도 막는다 ---
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'bad' })).status, 401);
    const locked = await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /분 뒤/);
    console.log('모든 테스트 통과');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close(); mock.close();
    process.exit();
  }
}));
