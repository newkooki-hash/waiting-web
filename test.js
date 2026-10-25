// 흐름 검증: 소셜 로그인(모의 제공자) → 접수 → 호출 → 배정, 검증 규칙
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
const assert = require('node:assert/strict');
const http = require('node:http');
const server = require('./server');
const sms = require('./sms');
let lastCode;
sms.driver = async (to, text) => { lastCode = text.match(/\d{6}/)[0]; };

// 카카오를 흉내 내는 모의 OAuth 서버
const mock = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'tok' }));
  if (req.url === '/me') {
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
    return res.end(JSON.stringify({ id: 777, kakao_account: { profile: { nickname: '홍길동' } } }));
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
    assert.equal((await call('POST', '/api/admin/login', { password: 'x' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { password: 'pw' })).status, 200);
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
    console.log('모든 테스트 통과');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close(); mock.close();
    process.exit();
  }
}));
