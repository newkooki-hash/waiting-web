import { useCallback, useEffect, useRef, useState } from 'react';
import { Anchor, Badge, Button, NativeSelect, Paper, Text, TextInput, Title } from '@mantine/core';
import { Card, Consent, Page, PhoneVerify, Providers, UserBar, mount, useMe } from './common';
import { post } from '../lib/api';
import { confirmDialog } from '../lib/dialogs';

interface Tournament {
  id: number; name: string; eventAt: string; applyStart: string; applyEnd: string;
  taken: number; capacity: number; waitlist: number; fee: number; info: string;
  apply: 'before' | 'open' | 'closed'; mine: '' | 'PENDING' | 'CONFIRMED' | 'WAITLIST' | null;
}
interface Profile { fullMember: boolean; birthDate: string; birthYear: number | null; gender: string }

const MINE: Record<string, [string, string]> = { PENDING: ['입금 대기', 'orange'], CONFIRMED: ['신청 확정', 'green'], WAITLIST: ['대기 중', 'orange'] };

function App() {
  const { me, reload } = useMe();
  const [list, setList] = useState<Tournament[] | null>(null);
  const [err, setErr] = useState('');
  const [fullMember, setFullMember] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const m = await reload();
    const { tournaments } = await (await fetch('/api/tournaments')).json();
    setList(tournaments);
    return m;
  }, [reload]);
  useEffect(() => { load(); }, [load]);

  const heading = <Title order={3} className="mb-4">정기 대회 신청</Title>;
  if (!me) return <Page title="오란다 볼링 정기 대회 신청">{heading}</Page>;

  const logged = !!me.user;
  const verified = logged && !!me.user!.phone;
  const needConsent = logged && (me.consent?.missing || []).length > 0;
  const full = fullMember ?? !!me.user?.fullMember;

  const act = async (t: Tournament, kind: 'apply' | 'cancel') => {
    setErr('');
    if (!me.user) return setErr('먼저 로그인해 주세요.');
    if (kind === 'cancel' && !await confirmDialog('신청을 취소할까요?')) return;
    const r = await post(`/api/tournaments/${t.id}/${kind}`);
    if (!r.ok) setErr(r.body.error || '처리에 실패했습니다.');
    load();
  };

  return (
    <Page title="오란다 볼링 정기 대회 신청">
      {heading}
      <Text c="dimmed" fz="sm" className="mb-3"><Anchor href="/" c="dimmed">← 처음으로</Anchor></Text>

      {!logged && (
        <Card>
          <div className="flex flex-col gap-3">
            <Text c="dimmed" fz="sm">간편 로그인 후 신청할 수 있습니다.</Text>
            <Providers me={me} next="tournament" />
          </div>
        </Card>
      )}
      {logged && (
        <UserBar me={me} onDone={(kind) => { if (kind === 'withdraw') location.href = '/tournament'; else { setFullMember(null); load(); } }} />
      )}
      {needConsent && <Consent key={me.consent!.missing.join()} me={me} onSaved={load} />}
      {logged && !verified && !needConsent && (
        <PhoneVerify hint="신청 확인과 안내를 위해 휴대전화 인증이 필요합니다. 한 번만 인증하면 됩니다." purpose="tournament" onVerified={load} />
      )}
      {verified && !needConsent && <ProfileCard onFullMember={setFullMember} onSaved={load} />}

      {list && (list.length ? list.map((t) => {
        const mine = t.mine ? MINE[t.mine] : undefined;
        // 신청하기는 관리자가 정한 신청 시작 시각부터 켜진다. 취소는 입금 전 신청에만
        const canApply = t.apply === 'open' && logged && verified && full && !mine;
        const canCancel = !!mine && t.mine !== 'CONFIRMED';
        const notice = logged && verified && !full ? '대회는 정회원만 신청할 수 있습니다. 위에서 생년월일과 성별을 입력해 정회원으로 가입해 주세요.' : '';
        return (
          <Card key={t.id}>
            <div className="flex flex-col gap-1">
              <Title order={4}>{t.name}</Title>
              <Text c="dimmed" fz="sm">대회 {t.eventAt}</Text>
              <Text c="dimmed" fz="sm">신청 {t.applyStart} ~ {t.applyEnd}</Text>
              <Text c="dimmed" fz="sm">참가 {t.taken}명 / 정원 {t.capacity}명 · 대기 {t.waitlist}명{t.fee ? ` · 참가비 ${t.fee.toLocaleString()}원` : ''}</Text>
              {t.info && <Paper bg="var(--mantine-color-default-hover)" radius="sm" fz="sm" className="p-2.5 whitespace-pre-wrap">{t.info}</Paper>}
              <div className="mt-2">
                {mine ? <Badge color={mine[1]} variant="light">{mine[0]}</Badge>
                  : t.apply === 'before' ? <Badge color="gray" variant="light">신청 시작 전</Badge>
                  : t.apply === 'closed' ? <Badge color="gray" variant="light">신청 마감</Badge> : null}
              </div>
              {t.mine === 'CONFIRMED' && <Text c="dimmed" fz="sm">취소는 매장에 문의해 주세요.</Text>}
              {notice && <Text c="dimmed" fz="sm">{notice}</Text>}
              <div className="flex gap-4 items-center flex-wrap [&>*]:flex-1 mt-3">
                <Button size="md" disabled={!canApply} onClick={() => act(t, 'apply')}>{t.taken >= t.capacity ? '대기 신청' : '신청하기'}</Button>
                <Button size="md" variant="default" disabled={!canCancel} onClick={() => act(t, 'cancel')}>신청 취소</Button>
              </div>
            </div>
          </Card>
        );
      }) : <Card><Text c="dimmed">진행 중인 대회가 없습니다.</Text></Card>)}
      {err && <Text c="red" role="alert">{err}</Text>}
    </Page>
  );
}

function ProfileCard({ onFullMember, onSaved }: { onFullMember: (v: boolean) => void; onSaved: () => void }) {
  const [full, setFull] = useState(false);
  const [birth, setBirth] = useState('');
  const [gender, setGender] = useState('');
  const [birthYear, setBirthYear] = useState<number | null>(null);
  const [hint, setHint] = useState('대회 신청에는 생년월일과 성별이 필요합니다. 핸디캡 적용에 쓰이며, 매장에서 확인할 수 있습니다.');
  const [err, setErr] = useState('');
  const loaded = useRef(false);

  useEffect(() => {
    (async () => {
      const r = await fetch('/api/tournament-profile');
      if (!r.ok) return;
      const p: Profile = await r.json();
      setFull(p.fullMember); onFullMember(p.fullMember);
      if (loaded.current) return; // 입력 중인 값을 덮어쓰지 않는다
      loaded.current = true;
      setBirth(p.birthDate); setGender(p.gender); setBirthYear(p.birthYear && !p.birthDate ? p.birthYear : null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setErr('');
    const r = await post('/api/tournament-profile', { birthDate: birth, gender });
    if (!r.ok) return setErr(r.body.error || '저장에 실패했습니다.');
    setHint('저장되었습니다. 정회원으로 대회에 신청할 수 있습니다.');
    setFull(true); onFullMember(true);
    onSaved();
  };

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Title order={4}>{full ? '내 정보 (정회원)' : '정회원 가입'}</Title>
        <Text c="dimmed" fz="sm">{hint}</Text>
        <TextInput label="생년월일"
      type="date"
      size="md"
      min="1900-01-01"
      required
      value={birth}
      onChange={(e) => setBirth(e.currentTarget.value)}
      description={birthYear ? `기존 정보: ${birthYear}년생. 정확한 생년월일을 입력해 주세요.` : undefined} />
        <NativeSelect label="성별"
      size="md"
      required
      value={gender}
      onChange={(e) => setGender(e.currentTarget.value)}
      data={[{ value: '', label: '선택' }, { value: 'm', label: '남' }, { value: 'f', label: '여' }]} />
        <Button size="md" fullWidth onClick={save}>저장</Button>
        {err && <Text c="red" role="alert">{err}</Text>}
        <Text c="dimmed" fz="sm">허위로 입력한 경우 대회 참가가 제한될 수 있습니다. 입력한 내용이 바뀌면 이력이 기록됩니다.</Text>
      </div>
    </Card>
  );
}

mount(<App />);
