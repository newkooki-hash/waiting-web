// 흐름 검증: 소셜 로그인(모의 제공자) → 접수 → 배정, 검증 규칙
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
let naverId = 'nv888';
const mock = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'tok' }));
  if (req.url === '/nme') return res.end(JSON.stringify({ response: { id: naverId, name: '네이버손님' } })); // 네이버 프로필 모양
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
    assert.equal((await call('GET', '/auth/kakao/callback?code=c&state=wrong', null, { raw: true })).location, '/waiting?login=failed');
    // 실패한 시도는 state 쿠키를 지우므로 다시 시작
    const state2 = new URL((await call('GET', '/auth/kakao', null, { raw: true })).location).searchParams.get('state');
    const cb = await call('GET', `/auth/kakao/callback?code=c&state=${state2}`, null, { raw: true });
    assert.equal(cb.location, '/waiting');
    assert.equal((await call('GET', '/api/me')).body.user.name, '홍길동');

    // --- 접수는 공개(QR 불필요). QR은 공개 접수 주소만 담고, 도착 확인은 카운터에서 직원이 한다 ---
    assert.equal((await call('GET', '/api/admin/intake')).status, 401);
    assert.equal((await call('GET', '/api/me')).body.intake.open, true);
    assert.equal((await call('GET', '/api/me')).body.arrivalLimitMin, 15); // 도착 확인 제한 15분
    assert.equal((await call('POST', '/api/phone/send', { phone: '123' })).status, 400); // QR 없이도 검증 단계까지 도달
    assert.equal((await call('POST', '/api/entries', { partySize: 2 })).body.code, 'PHONE_REQUIRED');
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    assert.equal((await call('GET', '/api/admin/intake')).body.url, server.oauth.BASE_URL); // QR은 토큰 없는 공개 주소
    assert.equal((await call('GET', '/arrive?t=x', null, { raw: true })).location, '/'); // 예전 도착 인증 QR 주소는 접수 화면으로
    assert.equal((await call('POST', '/api/admin/intake/rotate')).status, 404);
    assert.equal((await call('POST', '/api/admin/intake/open', { open: false })).body.open, false);
    assert.equal((await call('POST', '/api/entries', { partySize: 2 })).body.code, 'INTAKE_CLOSED');
    assert.equal((await call('GET', '/api/me')).body.intake.open, false);
    assert.equal((await call('POST', '/api/admin/intake/open', { open: true })).body.open, true);
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
    assert.equal((await call('POST', '/api/entries', { partySize: 4, shoes: 5 })).status, 400); // 신발은 인원을 넘을 수 없다
    const a = await call('POST', '/api/entries', { phone: '01000000000', partySize: 4, shoes: 3 }); // 본문의 번호는 무시, 인증된 번호 사용
    assert.equal(a.status, 201);
    assert.equal((await call('GET', '/api/me')).body.activeToken, a.body.token);
    const view = async (t) => (await call('GET', `/api/entries/${t}`)).body;
    assert.equal((await view(a.body.token)).arrived, false); // 접수만 하면 미도착
    assert.ok((await view(a.body.token)).arrivalLeft > 880); // 도착 확인 제한 15분(900초)
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
    // --- 통합회원: 같은 번호를 인증한 다른 플랫폼 계정은 동의하면 한 회원이 된다 ---
    Object.assign(server.oauth.providers.naver, { clientId: 'nid', tokenUrl: mockBase + '/token', profileUrl: mockBase + '/nme' });
    const kakaoSid = jar.sid; delete jar.sid;
    const socialLogin = async (p) => {
      const st = new URL((await call('GET', `/auth/${p}`, null, { raw: true })).location).searchParams.get('state');
      return call('GET', `/auth/${p}/callback?code=c&state=${st}`, null, { raw: true });
    };
    assert.equal((await socialLogin('naver')).location, '/waiting');
    const nm = (await call('GET', '/api/me')).body;
    assert.deepEqual([nm.user.provider, nm.user.phone], ['naver', null]); // 새 네이버 계정, 번호는 아직 없음
    const resetSms = () => server.db.prepare('DELETE FROM sms_codes WHERE phone=?').run(server.ep('01011112222')); // 번호당 하루 한도 초기화
    resetSms();
    assert.equal((await call('POST', '/api/phone/send', { phone: '01011112222' })).status, 200); // 카카오 회원이 쓰는 번호여도 다른 플랫폼이면 인증 진행
    const vm = await call('POST', '/api/phone/verify', { code: lastCode });
    assert.deepEqual(vm.body.merge.providers, ['카카오']); // 통합 확인을 요청
    assert.equal((await call('GET', '/api/me')).body.user.phone, null); // 동의 전에는 번호가 붙지 않는다
    assert.equal((await call('POST', '/api/entries', { partySize: 1 })).body.code, 'PHONE_REQUIRED');
    assert.equal((await call('POST', '/api/phone/merge')).status, 200);
    const merged = (await call('GET', '/api/me')).body;
    assert.deepEqual(merged.user.providers, ['kakao', 'naver']);
    assert.equal(merged.user.phone, '010-****-2222');
    assert.equal(merged.activeToken, a.body.token); // 카카오로 접수한 대기를 네이버 로그인에서도 본다
    assert.equal(server.db.prepare("SELECT COUNT(*) n FROM users WHERE phone=?").get(server.ep('01011112222')).n, 1);
    delete jar.sid;
    assert.equal((await socialLogin('kakao')).location, '/waiting'); // 카카오로 다시 로그인해도 같은 회원
    assert.equal((await call('GET', '/api/me')).body.activeToken, a.body.token);
    assert.equal((await call('GET', '/api/me')).body.user.name, '홍길동');
    // 같은 플랫폼의 다른 계정은 같은 번호를 쓸 수 없다(합치지 않는다)
    mockId = 779; delete jar.sid;
    await socialLogin('kakao');
    resetSms();
    assert.equal((await call('POST', '/api/phone/send', { phone: '01011112222' })).status, 409);
    mockId = 777; delete jar.sid; jar.sid = kakaoSid;
    assert.deepEqual((await call('GET', '/api/me')).body.user.providers, ['kakao', 'naver']); // 원래 카카오 세션 복원 확인
    // --- 관리자 ---
    assert.equal((await call('GET', '/api/admin/entries')).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'x' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'other', password: 'pw' })).status, 401); // 아이디도 맞아야 한다
    assert.equal((await call('POST', '/api/admin/login', { password: 'pw' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { id: 'admin', password: 'pw' })).status, 200);
    const list = (await call('GET', '/api/admin/entries')).body.entries;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '홍길동');
    assert.equal(list[0].phone, '010-****-2222'); // 대기 현황은 마스킹
    assert.equal(list[0].shoes, 3);
    assert.equal((await call('GET', '/api/me')).body.last.party, list[0].partySize); // 지난 접수 인원
    const rawPhone = (t, id) => server.db.prepare(`SELECT phone FROM ${t} WHERE id=?`).get(id).phone;
    assert.ok(rawPhone('entries', list[0].id).startsWith('e1:') && !rawPhone('entries', list[0].id).includes('2222')); // 저장은 암호문
    const ida = list[0].id;
    // --- 카운터 도착 확인 ---
    assert.equal((await call('POST', `/api/admin/entries/${ida}/arrive`)).status, 200);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/arrive`)).status, 409); // 이미 확인됨
    const va = await view(a.body.token);
    assert.ok(va.arrived && va.arrivalLeft === null);
    assert.equal(server.db.prepare('SELECT arrival_method m FROM entries WHERE token=?').get(a.body.token).m, 'staff');
    server.db.prepare("UPDATE entries SET created_at=datetime('now','localtime','-30 minutes') WHERE token=?").run(a.body.token);
    assert.equal(server.expireUnarrived(), 0); // 도착 확인한 건은 오래돼도 만료되지 않는다
    server.db.prepare("UPDATE entries SET created_at=datetime('now','localtime') WHERE token=?").run(a.body.token); // 시각 복원

    assert.equal((await call('POST', `/api/admin/entries/${ida}/call`)).status, 404); // 호출 기능은 없다(카운터에서 직접 호출)
    assert.equal((await call('POST', `/api/admin/entries/${ida}/assign`, { lanes: '19' })).status, 400);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/assign`, { lanes: '6,5' })).status, 200);
    assert.equal((await call('GET', `/api/entries/${a.body.token}`)).body.lanes, '5,6');
    const after = (await call('GET', '/api/admin/entries')).body.entries;
    assert.ok(after.every((e) => e.status === 'ASSIGNED' && e.assignedAt)); // 배정 완료 목록으로 이동
    assert.equal((await call('POST', `/api/entries/${a.body.token}/cancel`)).status, 409); // 이미 배정됨
    // 배정이 끝나면 다시 접수 가능
    const e2 = await call('POST', '/api/entries', { partySize: 1 });
    assert.equal(e2.status, 201);
    // --- 미도착 15분 초과: 도착 만료(EXPIRED) 상태 ---
    assert.equal(server.expireUnarrived(), 0); // 아직 15분 전
    server.db.prepare("UPDATE entries SET created_at=datetime('now','localtime','-16 minutes') WHERE token=?").run(e2.body.token);
    assert.equal((await view(e2.body.token)).status, 'EXPIRED'); // 조회만 해도 만료 상태로 바뀜(취소와 다른 상태)
    assert.equal((await view(e2.body.token)).position, null);
    assert.ok((await call('GET', '/api/admin/entries')).body.entries.some((e) => e.status === 'EXPIRED')); // 최근 12시간 만료 건은 관리자에게 보임(자정 넘어도 보임)
    // 직원이 도착 확인을 하면 만료 건이 대기로 복구된다(접수 순서 유지)
    const e2id = (await call('GET', '/api/admin/entries')).body.entries.find((e) => e.status === 'EXPIRED').id;
    assert.equal((await call('POST', `/api/admin/entries/${e2id}/arrive`)).status, 200);
    assert.equal((await view(e2.body.token)).status, 'WAITING');
    assert.equal((await view(e2.body.token)).arrived, true);
    assert.equal((await call('POST', `/api/entries/${e2.body.token}/cancel`)).status, 200); // 이후 흐름을 위해 정리
    assert.equal((await call('GET', '/api/me')).body.activeToken, null);
    const e3 = await call('POST', '/api/entries', { partySize: 1 }); // 만료 뒤 재접수 가능
    assert.equal(e3.status, 201);
    const e3id = (await call('GET', '/api/admin/entries')).body.entries.find((e) => e.status === 'WAITING').id;
    const w3 = (await call('GET', '/api/admin/entries')).body.entries.find((e) => e.id === e3id);
    assert.equal(w3.arrivedAt, null);
    assert.equal((await call('POST', `/api/admin/entries/${e3id}/arrive`)).status, 200); // 직원 수동 도착
    assert.equal((await call('POST', `/api/admin/entries/${e3id}/arrive`)).status, 409);
    assert.equal((await call('GET', '/api/admin/entries')).body.entries.find((e) => e.id === e3id).arrivalMethod, 'staff');
    server.db.prepare("UPDATE entries SET created_at=datetime('now','localtime','-30 minutes') WHERE id=?").run(e3id);
    assert.equal(server.expireUnarrived(), 0);
    server.db.prepare("UPDATE entries SET created_at=datetime('now','localtime') WHERE id=?").run(e3id);
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
    assert.ok(m.arrivedAt && m.arrivalMethod === 'staff'); // 수기 등록은 현장 접수라 바로 도착
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
    assert.equal(hc.waitMin, 0); // 배정 없이 취소: 접수~취소 시간(분)
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
    const order = async () => (await call('GET', '/api/admin/entries')).body.entries.filter((e) => e.status === 'WAITING');
    const [first, second] = await order();
    assert.equal((await call('POST', `/api/admin/entries/${second.id}/yield`)).status, 409); // 이미 맨 뒤
    assert.equal((await call('POST', `/api/admin/entries/${first.id}/yield`)).status, 200);
    let now = await order();
    assert.deepEqual(now.map((e) => e.id), [second.id, first.id]);
    assert.equal(now[1].status, 'WAITING');
    assert.equal((await call('POST', `/api/admin/entries/${second.id}/tail`)).status, 200);
    assert.deepEqual((await order()).map((e) => e.id), [first.id, second.id]);
    assert.equal((await call('POST', `/api/admin/entries/${m.id}/yield`)).status, 409); // 취소 건은 불가
    const pos = (await call('GET', `/api/entries/${(await call('GET', '/api/me')).body.activeToken}`)).body;
    assert.ok(pos.position === 1 || pos.position === 2);
    // --- 블랙리스트 ---
    const qrEntry = (await order()).find((e) => e.phone === '010-****-2222');
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
    // 원문 조회: 사유 필수, 사유와 함께 기록
    assert.equal((await call('POST', '/api/admin/reveal', { type: 'member', id: kim2.id })).status, 400);
    assert.equal((await call('POST', '/api/admin/reveal', { type: 'member', id: kim2.id, reason: ' ' })).status, 400);
    assert.equal((await call('POST', '/api/admin/reveal', { type: 'nope', id: 1, reason: '확인' })).status, 400);
    const shown = await call('POST', '/api/admin/reveal', { type: 'member', id: kim2.id, reason: '분실물 연락' });
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body, { phone: '01022223333', email: 'kim@example.com' });
    assert.equal((await call('POST', '/api/admin/reveal', { type: 'member', id: 99999, reason: '확인' })).status, 404);
    assert.equal((await fetch(base + '/api/admin/reveal', { method: 'POST' })).status, 401);
    const logged = server.db.prepare("SELECT target, member_id, reason FROM pii_view_log WHERE reason='분실물 연락'").all();
    assert.deepEqual(logged.map((l) => ({ ...l })), [{ target: 'member', member_id: kim2.id, reason: '분실물 연락' }]);
    assert.ok(server.db.prepare('SELECT phone FROM members WHERE id=?').get(kim2.id).phone.startsWith('e1:'));
    const histRow = (await call('GET', '/api/admin/history?from=2000-01-01&to=2999-12-31')).body.entries[0];
    assert.match(histRow.phone, /^010-\*{4}-\d{4}$/); // 이력도 마스킹
    const shownEntry = await call('POST', '/api/admin/reveal', { type: 'entry', id: histRow.id, reason: '미결제 확인' });
    assert.match(shownEntry.body.phone, /^01\d{8,9}$/);
    // --- 최근 3개월 방문 횟수: 같은 번호로 배정받은 날 수 ---
    const visitOf = async (name) => (await order()).find((e) => e.name === name).visits;
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at,assigned_at) VALUES ('v1','방문손님',?,1,'ASSIGNED',datetime('now','localtime','-10 days','start of day','+9 hours'),datetime('now','localtime','-10 days','start of day','+9 hours'))").run(server.ep('01088880000'));
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at,assigned_at) VALUES ('v2','방문손님',?,1,'ASSIGNED',datetime('now','localtime','-10 days','start of day','+10 hours'),datetime('now','localtime','-10 days','start of day','+10 hours'))").run(server.ep('01088880000')); // 같은 날 두 번 = 1회
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at,assigned_at) VALUES ('v3','방문손님',?,1,'ASSIGNED',datetime('now','localtime','-30 days'),datetime('now','localtime','-30 days'))").run(server.ep('01088880000'));
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at,assigned_at) VALUES ('v4','방문손님',?,1,'ASSIGNED',datetime('now','localtime','-120 days'),datetime('now','localtime','-120 days'))").run(server.ep('01088880000')); // 3개월 밖
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at) VALUES ('v5','방문손님',?,1,'WAITING',datetime('now','localtime'))").run(server.ep('01088880000'));
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at) VALUES ('v6','첫방문손님',?,1,'WAITING',datetime('now','localtime'))").run(server.ep('01088881111'));
    assert.equal(await visitOf('방문손님'), 2);
    assert.equal(await visitOf('첫방문손님'), 0);
    assert.equal((await order()).find((e) => !e.phone).visits, null); // 번호 없는 수기 건
    // --- 신발 대여 인원: 0~인원, 인원을 넘을 수 없음 ---
    assert.equal((await call('POST', '/api/admin/entries', { name: '신발손님', partySize: 4, shoes: 5 })).status, 400);
    assert.equal((await call('POST', '/api/admin/entries', { name: '신발손님', partySize: 4, shoes: -1 })).status, 400);
    assert.equal((await call('POST', '/api/admin/entries', { name: '신발손님', partySize: 4, shoes: 3 })).status, 201);
    const sh = () => order().then((l) => l.find((e) => e.name === '신발손님'));
    assert.equal((await sh()).shoes, 3);
    const shId = (await sh()).id;
    assert.equal((await call('POST', `/api/admin/entries/${shId}/edit`, { partySize: 2 })).status, 200); // 인원을 줄이면 신발도 인원 이하로
    assert.equal((await sh()).shoes, 2);
    assert.equal((await call('POST', `/api/admin/entries/${shId}/edit`, { partySize: 2, shoes: 3 })).status, 400);
    assert.equal((await call('POST', `/api/admin/entries/${shId}/edit`, { partySize: 2, shoes: 0 })).status, 200); // 전체 대여 안함
    assert.equal((await sh()).shoes, 0);
    assert.equal((await call('POST', `/api/admin/entries/${shId}/edit`, { partySize: 3, shoes: '' })).status, 200); // 비우면 미확인
    assert.equal((await sh()).shoes, null);
    assert.equal((await call('POST', '/api/admin/entries', { name: '신발미확인', partySize: 2 })).status, 201);
    assert.equal((await order()).find((e) => e.name === '신발미확인').shoes, null);
    const shHist = (await call('GET', '/api/admin/history?from=2000-01-01&to=2999-12-31&q=신발손님')).body.entries[0];
    assert.equal(shHist.shoes, '');
    // 정기 파기와 암호화 이전
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status,created_at,memo) VALUES ('old1','옛손님','01077778888',2,'ASSIGNED',datetime('now','localtime','-400 days'),'메모')").run();
    server.db.prepare("INSERT INTO entries (token,name,phone,party_size,status) VALUES ('legacy1','평문손님','01099991111',1,'CANCELED')").run(); // 암호화 이전 평문 행
    server.encryptExistingPhones();
    assert.ok(server.db.prepare("SELECT phone FROM entries WHERE token='legacy1'").get().phone.startsWith('e1:'));
    assert.equal((await call('GET', '/api/admin/history?from=2000-01-01&to=2999-12-31&q=01099991111')).body.entries.length, 1); // 전체 번호로 찾기
    assert.equal(server.purgeExpired().entries, 1);
    assert.deepEqual({ ...server.db.prepare("SELECT name, phone, memo FROM entries WHERE token='old1'").get() }, { name: '삭제됨', phone: '', memo: null });
    assert.equal(server.purgeExpired().entries, 0); // 다시 실행해도 변화 없음
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
    // 대회일 다음 날부터는 손님 목록에서 빠지고 관리자 목록에는 남는다
    const today = new Date().toLocaleDateString('sv');
    const pastId = (await tour({ name: '지난 대회', eventAt: ts(-60 * 24 * 2), applyStart: ts(-60 * 24 * 9), applyEnd: ts(-60 * 24 * 3) })).body.id;
    const todayId = (await tour({ name: '오늘 대회', eventAt: today + ' 23:59' })).body.id;
    const visible = (await call('GET', '/api/tournaments')).body.tournaments.map((t) => t.id);
    assert.ok(!visible.includes(pastId) && visible.includes(todayId) && visible.includes(tid));
    const adminList = (await call('GET', '/api/admin/tournaments')).body.tournaments;
    assert.deepEqual([adminList.find((t) => t.id === pastId).ended, adminList.find((t) => t.id === todayId).ended], [true, false]);
    assert.equal((await call('GET', `/api/admin/tournaments/${pastId}/entries`)).status, 200); // 지난 대회 내역은 관리자가 볼 수 있다
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
    // --- 행사 일정 캘린더 ---
    const cal = (b) => call('POST', '/api/admin/calendar', b);
    assert.equal((await fetch(base + '/api/admin/calendar', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/api/admin/calendar')).status, 401);
    assert.equal((await cal({ date: '2026-02-30', title: '없는 날' })).status, 400);
    assert.equal((await cal({ date: '2026-13-01', title: '없는 달' })).status, 400);
    assert.equal((await cal({ date: '2026-12-25', title: ' ' })).status, 400);
    const ev1 = (await cal({ date: '2026-12-25', title: '성탄 이벤트', memo: '전 레인 할인' })).body.id;
    await cal({ date: '2026-12-25', title: '챔프전 신청 마감' });
    await cal({ date: '2027-01-02', title: '다음 달 행사' });
    const dec = await (await fetch(base + '/api/calendar?month=2026-12')).json(); // 손님은 로그인 없이 조회
    assert.deepEqual(dec.events.map((e) => [e.date, e.title, e.memo]), [['2026-12-25', '성탄 이벤트', '전 레인 할인'], ['2026-12-25', '챔프전 신청 마감', '']]);
    assert.equal((await (await fetch(base + '/api/calendar?month=2027-01')).json()).events.length, 1);
    assert.equal((await call('GET', '/api/admin/calendar?month=2026-12')).body.events.length, 2);
    assert.equal((await cal({ id: ev1, date: '2026-12-26', title: '성탄 이벤트(수정)' })).status, 200);
    assert.deepEqual((await call('GET', '/api/admin/calendar?month=2026-12')).body.events.map((e) => e.date), ['2026-12-25', '2026-12-26']);
    assert.equal((await cal({ id: 99999, date: '2026-12-26', title: 'x' })).status, 404);
    assert.equal((await call('POST', '/api/admin/calendar/remove', { id: ev1 })).status, 200);
    assert.equal((await call('POST', '/api/admin/calendar/remove', { id: ev1 })).status, 404);
    assert.equal((await (await fetch(base + '/api/calendar?month=bad')).json()).month, new Date().toLocaleDateString('sv').slice(0, 7)); // 잘못된 월은 이번 달
    // --- 공지사항·이벤트 이미지 ---
    const notice = (b) => call('POST', '/api/admin/notices', b);
    assert.equal((await fetch(base + '/api/admin/notices', { method: 'POST' })).status, 401);
    assert.equal((await notice({ title: ' ' })).status, 400);
    assert.equal((await notice({ title: '제목', date: '2026-13-01' })).status, 400);
    const n1 = (await notice({ title: '휴무 안내', body: '12/25 정상 영업', date: '2026-12-01' })).body.id;
    await notice({ title: '신규 이벤트', date: '2026-12-10' });
    const pub = (await (await fetch(base + '/api/notices')).json()).notices; // 손님은 로그인 없이 조회, 최신 날짜가 위
    assert.deepEqual(pub.map((n) => n.title), ['신규 이벤트', '휴무 안내']);
    assert.equal(pub[1].body, '12/25 정상 영업');
    assert.equal((await notice({ id: n1, title: '휴무 안내(수정)', date: '2026-12-01' })).status, 200);
    assert.equal((await call('GET', '/api/admin/notices')).body.notices.find((n) => n.id === n1).title, '휴무 안내(수정)');
    assert.equal((await notice({ id: 99999, title: 'x' })).status, 404);
    assert.equal((await call('POST', '/api/admin/notices/remove', { id: n1 })).status, 200);
    assert.equal((await call('POST', '/api/admin/notices/remove', { id: n1 })).status, 404);
    assert.equal((await notice({ title: 'x'.repeat(20), body: 'y'.repeat(1100000) })).status, 400); // 1MB 넘는 요청은 받지 않는다
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
    const up = (buf) => call('POST', '/api/admin/banners', { data: 'data:image/png;base64,' + buf.toString('base64') });
    assert.equal((await fetch(base + '/api/admin/banners', { method: 'POST' })).status, 401);
    assert.equal((await call('POST', '/api/admin/banners', {})).status, 400);
    assert.equal((await up(Buffer.from('<script>alert(1)</script>'))).status, 400); // 이미지가 아니면 거절
    assert.equal((await up(Buffer.alloc(3 * 1024 * 1024 + 1, 0xff))).status, 413);
    const b1 = (await up(png)).body.id, b2 = (await up(jpg)).body.id;
    const ids = async () => (await (await fetch(base + '/api/banners')).json()).banners.map((b) => b.id);
    assert.deepEqual(await ids(), [b1, b2]);
    const img = await fetch(`${base}/banner/${b2}`);
    assert.deepEqual([img.status, img.headers.get('content-type'), img.headers.get('x-content-type-options')], [200, 'image/jpeg', 'nosniff']);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpg);
    assert.equal((await fetch(`${base}/banner/99999`)).status, 404);
    assert.equal((await fetch(`${base}/api/admin/banner-image?id=${b1}`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/banner-image?id=${b1}`, { headers: { cookie: `admin=${jar.admin}` } })).headers.get('content-type'), 'image/png');
    assert.equal((await call('POST', '/api/admin/banners/move', { id: b2, dir: 'up' })).status, 200);
    assert.deepEqual(await ids(), [b2, b1]);
    await call('POST', '/api/admin/banners/move', { id: b2, dir: 'up' }); // 맨 위에서는 변화 없음
    assert.deepEqual(await ids(), [b2, b1]);
    await call('POST', '/api/admin/banners/move', { id: b2, dir: 'down' });
    assert.deepEqual(await ids(), [b1, b2]);
    assert.equal((await call('POST', '/api/admin/banners/move', { id: 99999, dir: 'up' })).status, 404);
    assert.equal((await call('POST', '/api/admin/banners/remove', { id: b1 })).status, 200);
    assert.deepEqual(await ids(), [b2]);
    assert.equal((await call('POST', '/api/admin/banners/remove', { id: b1 })).status, 404);
    // --- 공개 메인 화면(/): 접수 상태·대기 팀 수·대회신청 버튼 상태 ---
    assert.equal((await tour({ eventAt: ts(60 * 24), applyStart: ts(60 * 12), applyEnd: ts(60 * 25) })).status, 400); // 신청 종료가 대회 일시보다 늦으면 저장 불가
    const homeNow = (await call('GET', '/api/home')).body;
    assert.match(homeNow.now, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.deepEqual([homeNow.intake.open, typeof homeNow.waitingTeams], [true, 'number']);
    assert.equal(homeNow.waitingTeams, (await call('GET', '/api/admin/entries')).body.entries.filter((e) => e.status === 'WAITING').length);
    // 접수중 > 접수 마감(대회일 전) > 접수 예정 > 일정 없음. 목록과 시각을 직접 넣어 계산만 확인한다
    const T = (id, start, end, event = '2999-12-30 10:00') => ({ id, name: '대회' + id, event_at: event, apply_start: start, apply_end: end, capacity: 10 });
    const NOW = '2026-11-08 12:00';
    const ht = (list) => server.homeTournament(list, NOW);
    assert.equal(ht([]).state, 'none');
    assert.deepEqual([ht([T(1, '2026-11-20 10:00', '2026-11-25 10:00')]).state, ht([T(1, '2026-11-20 10:00', '2026-11-25 10:00')]).applyStart], ['upcoming', '2026-11-20 10:00']); // 비활성이어도 오픈 시각을 준다
    assert.equal(ht([T(1, '2026-11-01 10:00', '2026-11-30 10:00')]).state, 'open');
    assert.equal(ht([T(1, '2026-11-01 10:00', '2026-11-05 10:00')]).state, 'closed');
    const both = ht([T(1, '2026-11-01 10:00', '2026-11-05 10:00'), T(2, '2026-12-01 10:00', '2026-12-05 10:00')]);
    assert.deepEqual([both.state, both.next.applyStart], ['closed', '2026-12-01 10:00']); // 마감 상태에는 다음 오픈 시각
    assert.equal(ht([T(1, '2026-11-01 10:00', '2026-11-05 10:00'), T(2, '2026-11-07 10:00', '2026-11-30 10:00')]).state, 'open'); // 접수중이 우선
    assert.equal(ht([T(1, '2026-11-01 10:00', '2026-11-05 10:00', '2026-11-06 10:00')]).state, 'none'); // 대회일이 지나면 숨김
    assert.equal(ht([T(1, '2026-11-01 10:00', '2026-11-30 10:00'), T(2, '2026-11-02 10:00', '2026-11-20 10:00')]).name, '대회2'); // 먼저 마감되는 접수중 대회
    // 서버가 실제로 쓰는 대회 목록으로도 한 번 확인(앞에서 만든 대회가 접수중)
    assert.equal((await call('GET', '/api/home')).body.tournament.state, 'open');
    // 접수 시간 밖에는 직접 주소로도 신청할 수 없다
    const closedT = (await tour({ name: '마감 시험', eventAt: ts(60 * 24 * 9), applyStart: ts(-120), applyEnd: ts(-60) })).body.id;
    assert.equal((await call('POST', `/api/tournaments/${closedT}/apply`)).status === 201, false);
    // 페이지: /는 메인, /waiting은 접수 화면(빌드 결과가 있을 때만 확인)
    if (require('node:fs').existsSync(require('node:path').join(__dirname, 'dist', 'home.html'))) {
      assert.ok((await (await fetch(base + '/')).text()).includes('<title>오란다 볼링파크</title>'));
      assert.ok((await (await fetch(base + '/waiting')).text()).includes('<title>오란다 볼링 대기 접수</title>'));
    }
    // --- 통계 ---
    assert.equal((await fetch(base + '/api/admin/stats')).status, 401);
    assert.equal((await call('GET', '/api/admin/stats?from=2026-12-31&to=2026-01-01')).status, 400);
    assert.equal((await call('GET', '/api/admin/stats?from=2020-01-01&to=2026-01-01')).status, 400); // 1년 초과
    const st = (await call('GET', '/api/admin/stats')).body; // 기본: 오늘까지 30일
    const sum = (list, k) => list.reduce((a, r) => a + r[k], 0);
    assert.ok(st.total.teams > 0 && st.total.people >= st.total.teams);
    assert.equal(st.total.assigned + st.total.canceled + st.total.expired + st.total.waiting, st.total.teams); // 상태 합계가 접수 팀과 같다
    assert.equal(sum(st.days, 'teams'), st.total.teams);
    assert.equal(sum(st.hours, 'teams'), st.total.teams);
    assert.equal(sum(st.weekdays, 'teams'), st.total.teams);
    assert.equal(sum(st.days, 'canceled'), st.total.canceled);
    assert.ok(st.manual > 0 && st.manual <= st.total.teams);
    assert.ok(st.total.avgWait >= 0 && st.total.maxWait >= st.total.medianWait);
    assert.ok(st.total.avgAssignedWait !== null && st.total.avgCanceledWait !== null); // 취소된 건도 대기 시간을 계산한다
    assert.ok(st.hours.every((h) => h.hour >= 0 && h.hour <= 23) && st.weekdays.every((w) => w.dow >= 0 && w.dow <= 6));
    const none = (await call('GET', '/api/admin/stats?from=2000-01-01&to=2000-01-31')).body;
    assert.deepEqual([none.total.teams, none.total.avgWait, none.days.length], [0, null, 0]);
    // --- 이용약관·개인정보처리방침 동의 ---
    const policy = (type, body) => call('POST', '/api/admin/policies', { type, body });
    assert.equal((await fetch(base + '/api/admin/policies')).status, 401);
    assert.equal((await fetch(base + '/api/admin/policies', { method: 'POST' })).status, 401);
    assert.equal((await policy('etc', 'x')).status, 400);
    assert.deepEqual((await call('GET', '/api/me')).body.consent.missing, []); // 약관이 비어 있으면 동의를 요구하지 않는다
    assert.equal((await policy('terms', '제1조 목적')).body.version, 1);
    assert.equal((await policy('terms', '제1조 목적')).body.changed, false); // 같은 내용은 버전이 오르지 않는다
    assert.equal((await policy('privacy', '수집 항목: 이름, 휴대전화번호')).body.version, 1);
    const pub1 = (await (await fetch(base + '/api/policy?type=terms')).json());
    assert.deepEqual([pub1.title, pub1.body, pub1.version], ['이용약관', '제1조 목적', 1]);
    assert.equal((await fetch(base + '/api/policy?type=etc')).status, 404);
    assert.deepEqual((await call('GET', '/api/me')).body.consent.missing, ['terms', 'privacy']);
    for (const [method, url, body] of [['POST', '/api/phone/send', { phone: '01012340000' }], ['POST', '/api/entries', { partySize: 1 }], ['POST', `/api/tournaments/${tid}/apply`], ['POST', '/api/tournament-profile', { birthDate: '1991-01-02', gender: 'm' }]]) {
      assert.equal((await call(method, url, body)).body.code, 'CONSENT_REQUIRED', url);
    }
    assert.equal((await call('POST', '/api/consent', { terms: true, marketing: true })).status, 400); // 필수 약관 하나라도 빠지면 거절
    assert.equal((await call('POST', '/api/consent', { terms: true, privacy: false })).status, 400);
    assert.equal((await fetch(base + '/api/consent', { method: 'POST' })).status, 401);
    assert.equal((await call('POST', '/api/consent', { terms: true, privacy: true, marketing: true })).status, 200);
    const consented = (await call('GET', '/api/me')).body.consent;
    assert.deepEqual([consented.missing, consented.marketing], [[], true]);
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1991-01-02', gender: 'm' })).status, 200); // 동의 후에는 통과
    // 일반 개정은 공지로 알리고 다시 동의를 요구하지 않는다
    const noticesBefore = (await call('GET', '/api/admin/notices')).body.notices.length;
    const rev = (await call('POST', '/api/admin/policies', { type: 'terms', body: '제1조 목적 (개정)', summary: '제1조 문구를 정리했습니다.' })).body;
    assert.deepEqual([rev.version, rev.reconsent], [2, false]);
    assert.deepEqual((await call('GET', '/api/me')).body.consent.missing, []);
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1991-01-02', gender: 'm' })).status, 200);
    const notices2 = (await call('GET', '/api/admin/notices')).body.notices;
    assert.equal(notices2.length, noticesBefore + 1); // 개정 안내 공지가 자동 등록된다
    const guide = notices2.find((n) => n.title === '[이용약관 개정 안내]');
    assert.ok(guide.body.includes('제1조 문구를 정리했습니다.') && guide.body.includes('시행일') && !guide.body.includes('다시 필요'));
    assert.equal((await call('POST', '/api/admin/policies', { type: 'terms', body: '제1조 목적 (개정2)', notify: false })).body.version, 3);
    assert.equal((await call('GET', '/api/admin/notices')).body.notices.length, noticesBefore + 1); // notify:false면 공지 없음
    // 신규 가입자도 현재 버전에 동의하면 이후 일반 개정에는 막히지 않는다(기준 버전 비교)
    assert.equal((await call('GET', '/api/admin/policies')).body.policies.find((p) => p.type === 'terms').consentVersion, 1);
    // 수집 항목 변경처럼 중요한 개정은 재동의를 받는다
    const rev2 = (await call('POST', '/api/admin/policies', { type: 'terms', body: '제1조 목적 (중요 개정)', reconsent: true })).body;
    assert.deepEqual([rev2.version, rev2.reconsent], [4, true]);
    assert.deepEqual((await call('GET', '/api/me')).body.consent.missing, ['terms']);
    assert.ok((await call('GET', '/api/admin/notices')).body.notices.some((n) => n.body.includes('다시 필요')));
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1991-01-02', gender: 'm' })).body.code, 'CONSENT_REQUIRED');
    assert.equal((await call('POST', '/api/consent', { terms: true, marketing: false })).status, 200); // 개인정보는 이미 동의한 버전이라 생략
    const afterRevise = (await call('GET', '/api/me')).body.consent;
    assert.deepEqual([afterRevise.missing, afterRevise.marketing], [[], false]); // 마케팅 수신 철회가 반영된다
    assert.equal((await policy('terms', '')).status, 200); // 다른 시험에 영향이 없도록 비운다
    assert.equal((await policy('privacy', '')).status, 200);
    assert.deepEqual((await call('GET', '/api/me')).body.consent.missing, []);
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
    // --- 회원 탈퇴·삭제, 재가입 제한, 마지막 이용일 ---
    const verifyPhone = async (phone) => {
      assert.equal((await call('POST', '/api/phone/send', { phone })).status, 200);
      assert.equal((await call('POST', '/api/phone/verify', { code: lastCode })).status, 200);
    };
    const findMember = async (q) => (await call('GET', `/api/admin/members?q=${q}`)).body;
    await login(5001);
    await verifyPhone('01055550001');
    const wEntry = (await call('POST', '/api/entries', { partySize: 2 })).body.token;
    assert.ok(wEntry);
    const wm = (await findMember('01055550001')).entries[0];
    assert.equal(wm.lastUsedAt, new Date().toLocaleDateString('sv')); // 접수하면 마지막 이용일이 기록된다
    // 통합회원: 이 회원에 네이버 계정도 연결해 둔다(탈퇴하면 두 계정 모두 재가입이 제한되어야 한다)
    const kSid = jar.sid; delete jar.sid;
    naverId = 'nv901';
    await socialLogin('naver');
    server.db.prepare('DELETE FROM sms_codes WHERE phone=?').run(server.ep('01055550001'));
    assert.equal((await call('POST', '/api/phone/send', { phone: '01055550001' })).status, 200);
    assert.deepEqual((await call('POST', '/api/phone/verify', { code: lastCode })).body.merge.providers, ['카카오']);
    assert.equal((await call('POST', '/api/phone/merge')).status, 200);
    jar.sid = kSid;
    assert.deepEqual((await call('GET', '/api/me')).body.user.providers, ['kakao', 'naver']);
    const platRow = (await findMember('01055550001')).entries[0];
    assert.deepEqual(platRow.platforms, ['kakao', 'naver']); // 회원관리에 가입 플랫폼 표시
    await call('POST', '/api/admin/blacklist', { phone: '01066660000', name: '차단대상', reason: '반복 노쇼' });
    // 대회에 입금이 확인된 신청이 있으면 탈퇴할 수 없다
    const wt = (await tour({ name: '탈퇴 시험 대회', capacity: 50 })).body.id;
    assert.equal((await call('POST', '/api/tournament-profile', { birthDate: '1985-03-04', gender: 'f' })).status, 200);
    assert.equal((await call('POST', `/api/tournaments/${wt}/apply`)).status, 201);
    const wte = (await call('GET', `/api/admin/tournaments/${wt}/entries`)).body.entries[0];
    assert.equal((await call('POST', `/api/admin/tournament-entries/${wte.id}/confirm`)).status, 200);
    assert.equal((await call('POST', '/api/me/withdraw', {})).status, 400); // 확인 없이는 안 됨
    const blockedW = await call('POST', '/api/me/withdraw', { confirm: true });
    assert.deepEqual([blockedW.status, blockedW.body.code], [409, 'HAS_PAID_ENTRY']);
    assert.equal((await call('GET', '/api/me')).body.user.name, '홍길동'); // 막히면 아무것도 바뀌지 않는다
    await call('POST', `/api/admin/tournament-entries/${wte.id}/delete`, { reason: '환불 완료', refundMemo: '계좌 환불' });
    assert.equal((await fetch(base + '/api/me/withdraw', { method: 'POST' })).status, 401);
    const done = await call('POST', '/api/me/withdraw', { confirm: true });
    assert.deepEqual([done.status, done.body.blockedDays], [200, 30]);
    assert.equal((await call('GET', '/api/me')).body.user, null); // 로그아웃됨
    assert.equal((await findMember('01055550001')).total, 0); // 회원 삭제
    assert.equal((await call('GET', `/api/admin/members/log?id=${wm.id}`)).body.entries.length, 0); // 변경 이력도 삭제
    const gone = (await call('GET', '/api/admin/history?from=2000-01-01&to=2999-12-31')).body.entries;
    assert.equal(gone.filter((e) => e.phone === '010-****-0001').length, 0);
    const anon = gone.find((e) => e.name === '삭제됨' && e.cancelReason === '탈퇴'); // 대기 중이던 접수는 취소되고 익명화
    assert.ok(anon && anon.status === 'CANCELED' && anon.phone === '');
    assert.equal((await call('GET', `/api/admin/tournaments/${wt}/entries`)).body.entries[0].name, '삭제됨');
    assert.equal((await call('GET', `/api/entries/${wEntry}`)).body.name, '삭제됨');
    assert.equal((await call('GET', '/api/admin/blacklist')).body.entries.some((b) => b.phone === '010-****-0000'), true); // 블랙리스트는 유지
    // 재가입 제한: 같은 소셜 계정, 같은 번호
    assert.equal((await call('GET', '/auth/kakao', null, { raw: true })).status, 302);
    mockId = 5001; await call('POST', '/api/logout');
    const stW = new URL((await call('GET', '/auth/kakao', null, { raw: true })).location).searchParams.get('state');
    assert.equal((await call('GET', `/auth/kakao/callback?code=c&state=${stW}`, null, { raw: true })).location, '/waiting?login=withdrawn');
    assert.equal((await call('GET', '/api/me')).body.user, null);
    naverId = 'nv901'; delete jar.sid; // 통합회원이었으므로 연결된 네이버 계정으로도 재가입이 막힌다
    assert.equal((await socialLogin('naver')).location, '/waiting?login=withdrawn');
    assert.equal((await call('GET', '/api/me')).body.user, null);
    await login(5002); // 다른 소셜 계정이어도 번호가 같으면 막는다
    const rejoin = await call('POST', '/api/phone/send', { phone: '01055550001' });
    assert.deepEqual([rejoin.status, rejoin.body.code], [403, 'REJOIN_BLOCKED']);
    assert.match(rejoin.body.error, /\d{4}-\d\d-\d\d까지/);
    assert.equal((await call('POST', '/api/admin/withdrawals/lift', { phone: '123' })).status, 400);
    assert.equal((await call('POST', '/api/admin/withdrawals/lift', { phone: '01099990000' })).status, 404); // 제한 중이 아닌 번호
    assert.equal((await call('POST', '/api/admin/withdrawals/lift', { phone: '01055550001' })).status, 200);
    assert.equal((await call('POST', '/api/phone/send', { phone: '01055550001' })).status, 200); // 해제 후에는 가입 가능
    // 관리자가 이관 회원을 삭제하는 경우(소셜 계정이 없는 회원)
    await call('POST', '/api/admin/members/import', { csv: 'name,phone,email\r\n삭제대상,01066660000,gone@example.com' });
    const im = (await findMember('01066660000')).entries[0];
    assert.equal((await call('POST', '/api/admin/members/delete', { id: 99999 })).status, 404);
    assert.equal((await fetch(base + '/api/admin/members/delete', { method: 'POST' })).status, 401);
    assert.equal((await call('POST', '/api/admin/members/delete', { id: im.id })).status, 200);
    assert.equal((await findMember('01066660000')).total, 0);
    assert.equal((await call('GET', '/api/admin/blacklist')).body.entries.some((b) => b.phone === '010-****-0000'), true); // 블랙리스트는 그대로
    assert.equal((await call('POST', '/api/admin/withdrawals/lift', { phone: '01066660000' })).status, 200); // 관리자 삭제도 제한이 걸려 있었다
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
