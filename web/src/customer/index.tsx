import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Anchor, Button, Image, NativeSelect, Text, TextInput, Title } from '@mantine/core';
import { Card, Consent, Page, PhoneVerify, Providers, UserBar, mount, useMe } from './common';
import { post } from '../lib/api';
import { useEvents } from '../lib/useEvents';
import type { PublicEntry } from '../lib/types';
import { confirmDialog } from '../lib/dialogs';
import { mmss, useCountdown } from '../lib/countdown';
import { ALLOWED_RADIUS_M, formatDistance, useStoreDistance } from '../lib/geo';

const KEY = 'waitingToken';
const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v: string) { try { localStorage.setItem(KEY, v); } catch { /* 저장소를 못 쓰는 브라우저 */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* 저장소를 못 쓰는 브라우저 */ } },
};

function App() {
  const { me, reload } = useMe();
  const [token, setToken] = useState<string | null>(store.get);
  const [entry, setEntry] = useState<PublicEntry | null>(null);
  const [banners, setBanners] = useState<{ id: number }[]>([]);
  const [name, setName] = useState('');
  const [party, setParty] = useState(1);
  const [shoes, setShoes] = useState(1);
  // 손님이 직접 고른 뒤에는 기본값으로 덮어쓰지 않는다
  const [partyTouched, setPartyTouched] = useState(false);
  const [shoesTouched, setShoesTouched] = useState(false);
  const [err, setErr] = useState('');

  const params = new URLSearchParams(location.search);

  const clearToken = () => { store.clear(); setToken(null); };

  // 서버가 알고 있는 진행 중 접수가 있으면 이 기기에도 기억시킨다
  useEffect(() => {
    if (me?.user && !token && me.activeToken) { store.set(me.activeToken); setToken(me.activeToken); }
  }, [me, token]);

  const refresh = useCallback(async () => {
    if (!token) return setEntry(null);
    const r = await fetch('/api/entries/' + token);
    if (!r.ok) { store.clear(); setToken(null); return setEntry(null); }
    const e: PublicEntry = await r.json();
    setEntry(e);
    if (e.status === 'FINISHED' || e.status === 'CANCELED' || e.status === 'EXPIRED') { store.clear(); setToken(null); }
  }, [token]);

  useEffect(() => { if (me) refresh(); }, [me, refresh]);
  useEvents(() => refresh());
  useEffect(() => { fetch('/api/banners').then((r) => r.json()).then((b) => setBanners(b.banners)); }, []);

  // 로그인 정보가 들어오면 이름과 지난 접수 값을 기본으로 채운다
  useEffect(() => {
    if (!me?.user) return;
    setName((n) => n || me.user!.name);
    if (me.last && !partyTouched) {
      setParty(me.last.party);
      setShoes(Math.min(me.last.shoes ?? (shoesTouched ? shoes : me.last.party), me.last.party));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const changeParty = (p: number) => {
    setPartyTouched(true); setParty(p);
    setShoes(shoesTouched ? Math.min(shoes, p) : p); // 직접 고르기 전에는 인원과 함께 늘고, 고른 뒤에는 인원을 넘지 않게만 줄인다
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setErr('');
    const r = await post('/api/entries', { name, partySize: party, shoes });
    const b = r.body;
    if ((r.status === 403 && b.code === 'PHONE_REQUIRED') || r.status === 401 || ['INTAKE_CLOSED', 'CONSENT_REQUIRED'].includes(b.code)) return void reload();
    if (r.ok || (r.status === 409 && b.token)) { store.set(b.token); setToken(b.token); return; }
    setErr(b.error || '접수에 실패했습니다.');
  };

  const cancel = async () => {
    if (!await confirmDialog('대기를 취소할까요?')) return;
    await fetch(`/api/entries/${token}/cancel`, { method: 'POST' });
    refresh();
  };

  const userDone = (kind: 'logout' | 'withdraw') => {
    clearToken(); setEntry(null);
    if (kind === 'withdraw') { location.href = '/'; return; }
    history.replaceState(null, '', '/');
    reload();
  };

  const heading = <Title order={3} className="mb-4">오란다 볼링 대기 접수</Title>;
  if (!me) return <Page title="오란다 볼링 대기 접수">{heading}</Page>;

  const logged = !!me.user;
  const verified = logged && !!me.user!.phone;
  const needConsent = logged && (me.consent?.missing || []).length > 0;
  // 접수 중지·시간대 밖이면 접수 단계를 보여주지 않는다. 접수는 공개이고 QR은 이 주소를 여는 용도다
  const blocked = !me.intake.open
    ? (me.intake.window ? '접수 가능 시간은 ' + me.intake.window + '입니다.' : '지금은 접수 중이 아닙니다.')
    : '';
  const q = params.get('login');
  const loginErr = q === 'failed' ? '로그인에 실패했습니다. 다시 시도해 주세요.' : q === 'withdrawn' ? '탈퇴 후 일정 기간 동안은 다시 가입할 수 없습니다. 문의는 매장으로 해 주세요.' : '';

  return (
    <Page title="오란다 볼링 대기 접수">
      {heading}
      <div className="flex flex-col gap-2 mb-4">
        {banners.map((b) => <Image key={b.id} src={`/banner/${b.id}`} alt="이벤트" loading="lazy" radius="md" />)}
      </div>

      {entry ? (
        <>
          {logged && <UserBar me={me} onDone={userDone} />}
          <StatusCard entry={entry} limit={me.arrivalLimitMin} onCancel={cancel} onAgain={() => setEntry(null)} onExpire={refresh} />
        </>
      ) : (
        <>
          {blocked && <Card><Text ta="center">{blocked}</Text></Card>}
          {logged && <UserBar me={me} onDone={userDone} />}
          {!blocked && needConsent && <Consent key={me.consent!.missing.join()} me={me} onSaved={reload} />}
          {!blocked && !logged && (
            <Card>
              <div className="flex flex-col gap-3">
                <Text ta="center" c="dimmed">간편 로그인 후 대기 접수를 할 수 있습니다.</Text>
                <Providers me={me} />
                {loginErr && <Alert color="red" role="alert">{loginErr}</Alert>}
              </div>
            </Card>
          )}
          {!blocked && logged && !verified && !needConsent && (
            <PhoneVerify hint="대기 접수를 하려면 휴대전화 인증이 필요합니다. 한 번만 인증하면 됩니다." onVerified={reload} onForbidden={reload} />
          )}
          {!blocked && verified && !needConsent && (
            <Card component="form" onSubmit={submit}>
              <div className="flex flex-col gap-3">
                <TextInput label="이름" size="md" autoComplete="name" maxLength={20} required value={name} onChange={(e) => setName(e.currentTarget.value)} />
                <Text c="dimmed" fz="sm">인증된 번호: {me.user!.phone}</Text>
                <NativeSelect label="인원 (최대 8명)"
      size="md"
      value={party}
      onChange={(e) => changeParty(Number(e.currentTarget.value))}
      data={Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}명` }))} />
                <div className="flex gap-4 items-end flex-nowrap">
                  <NativeSelect label="신발 대여 인원"
      size="md"
      className="flex-1"
      value={shoes}
      onChange={(e) => { setShoesTouched(true); setShoes(Number(e.currentTarget.value)); }}
      data={Array.from({ length: party + 1 }, (_, i) => ({ value: String(i), label: i === 0 ? '대여 안함' : i + '명' }))} />
                  <Button variant="default" size="md" onClick={() => { setShoesTouched(true); setShoes(0); }}>전체 대여 안함</Button>
                </div>
                <Alert color="blue" role="note">
                  접수 후 <b>{me.arrivalLimitMin}분 안에 카운터에서 도착 확인</b>을 받지 않으면 대기가 자동으로 만료됩니다. 접수 후 바로 매장으로 오셔서 직원에게 말씀해 주세요.
                </Alert>
                <FarNotice limit={me.arrivalLimitMin} />
                <Button type="submit" size="md" fullWidth>대기 접수</Button>
                {err && <Text c="red" role="alert">{err}</Text>}
              </div>
            </Card>
          )}
        </>
      )}

      <Text ta="center" c="dimmed" fz="sm" className="mt-5">
        <Anchor href="/tournament" c="dimmed">정기 대회 신청 →</Anchor> · <Anchor href="/calendar" c="dimmed">행사 일정 →</Anchor> · <Anchor href="/notice" c="dimmed">공지사항 →</Anchor>
      </Text>
    </Page>
  );
}

/** 접수 폼이 보일 때만 위치를 확인한다. 멀어도 접수는 막지 않고 안내만 보여 준다(PRD 4.3). */
function FarNotice({ limit }: { limit: number }) {
  const distance = useStoreDistance(true);
  if (distance === null || distance <= ALLOWED_RADIUS_M) return null;
  return (
    <Alert color="yellow" role="status">
      매장에서 약 {formatDistance(distance)} 떨어져 있습니다. 접수 후 {limit}분 안에 카운터에서 도착 확인을 받지 않으면 대기가 만료됩니다.
    </Alert>
  );
}

/** 도착 확인 안내: 접수 후 정해진 시간 안에 카운터에서 직원에게 도착 확인을 받아야 한다 */
function ArrivalNotice({ entry: e, onExpire }: { entry: PublicEntry; onExpire: () => void }) {
  const left = useCountdown(e.arrivalLeft, () => setTimeout(onExpire, 1200));
  if (e.arrived) return <Alert color="green" className="mt-3">도착 확인됨 · 직원이 부를 때까지 매장에서 기다려 주세요.</Alert>;
  return (
    <Alert color="yellow" className="mt-3" role="status">
      매장에 도착하면 카운터에서 직원에게 말씀해 도착 확인을 받아 주세요.{left !== null && <> <b>{mmss(left)}</b> 안에 확인받지 않으면 대기가 만료됩니다.</>}
    </Alert>
  );
}

function StatusCard({ entry: e, limit, onCancel, onAgain, onExpire }: { entry: PublicEntry; limit: number; onCancel: () => void; onAgain: () => void; onExpire: () => void }) {
  const who = `${e.name}님 · ${e.partySize}명` + (e.shoes === null ? '' : e.shoes ? ` · 신발 ${e.shoes}명` : ' · 신발 대여 안함');
  let main = '';
  let sub: ReactNode = '';
  if (e.status === 'WAITING') {
    main = `${e.position}번째`;
    sub = e.position === 1 ? '곧 직원이 부릅니다. 매장에서 기다려 주세요.' : `앞에 ${(e.position ?? 1) - 1}팀이 대기 중입니다.`;
  } else if (e.status === 'EXPIRED') {
    main = '도착 만료'; sub = <>접수 후 {limit}분 안에 카운터에서 도착 확인을 받지 않아 대기가 만료되었습니다.<br /><Anchor component="button" type="button" onClick={onAgain}>다시 접수하기</Anchor></>;
  } else if (e.status === 'ASSIGNED') {
    main = `${e.lanes}번 레인`;
    sub = <>배정되었습니다. 즐거운 시간 되세요!<br /><Anchor component="button" type="button" onClick={onAgain}>새로 접수하기</Anchor></>;
  } else {
    main = e.status === 'FINISHED' ? '이용이 끝났습니다' : '대기가 취소되었습니다';
    sub = <Anchor href="/">새로 접수하기</Anchor>;
  }
  return (
    <Card>
      <Text ta="center" c="dimmed">{who}</Text>
      <Text ta="center" fz={44} fw={700} className="my-2.5">{main}</Text>
      <Text ta="center" c="dimmed" component="div">{sub}</Text>
      {e.status === 'WAITING' && <ArrivalNotice entry={e} onExpire={onExpire} />}
      {e.status === 'WAITING' && <Button variant="default" fullWidth size="md" onClick={onCancel} className="mt-4">대기 취소</Button>}
    </Card>
  );
}

mount(<App />);
