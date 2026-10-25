// 흐름 검증: 접수 → 호출 → 배정 → 종료, 검증 규칙
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.PORT = '0';
const assert = require('node:assert/strict');
const server = require('./server');

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call('GET', '/api/admin/entries')).status, 401);
    assert.equal((await call('POST', '/api/entries', { name: '가', phone: '123', partySize: 2 })).status, 400);
    assert.equal((await call('POST', '/api/entries', { name: '가', phone: '01011112222', partySize: 9 })).status, 400);

    const a = await call('POST', '/api/entries', { name: '가', phone: '010-1111-2222', partySize: 4 });
    assert.equal(a.status, 201);
    assert.equal((await call('POST', '/api/entries', { name: '가', phone: '01011112222', partySize: 4 })).status, 409);
    const b = await call('POST', '/api/entries', { name: '나', phone: '01033334444', partySize: 2 });
    assert.equal((await call('GET', `/api/entries/${b.body.token}`)).body.position, 2);

    assert.equal((await call('POST', '/api/admin/login', { password: 'x' })).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { password: 'pw' })).status, 200);
    const list = (await call('GET', '/api/admin/entries')).body.entries;
    assert.equal(list.length, 2);
    assert.equal(list[0].assignedAt, null);
    const [ida, idb] = list.map((e) => e.id);

    assert.equal((await call('POST', `/api/admin/entries/${ida}/call`)).status, 200);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/call`)).status, 409);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/assign`, { lanes: '19' })).status, 400);
    assert.equal((await call('POST', `/api/admin/entries/${ida}/assign`, { lanes: '6,5' })).status, 200);
    assert.equal((await call('GET', `/api/entries/${a.body.token}`)).body.lanes, '5,6');
    assert.equal((await call('POST', `/api/admin/entries/${idb}/assign`, { lanes: '6' })).status, 200); // 레인 중복 허용

    const after = (await call('GET', '/api/admin/entries')).body.entries;
    assert.ok(after.every((e) => e.status === 'ASSIGNED' && e.assignedAt)); // 배정 완료 목록으로 이동
    assert.equal((await call('POST', `/api/entries/${b.body.token}/cancel`)).status, 409); // 이미 배정됨
    // 종료된 손님은 다시 접수 가능
    assert.equal((await call('POST', '/api/entries', { name: '가', phone: '01011112222', partySize: 1 })).status, 201);
    console.log('모든 테스트 통과');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit();
  }
});
