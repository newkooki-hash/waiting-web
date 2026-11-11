import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Image, Text } from '@mantine/core';
import { MemoNotice, Page, mount } from './common';
import { InstallTip } from './InstallTip';
import { useEvents } from '../lib/useEvents';
import { tournamentButton, type HomeTournament } from '../lib/tournamentButton';

interface Home { now: string; intake: { open: boolean; window: string | null; hours: { business: string; intake: string; intake24: boolean; memo: string; closed: boolean; label: string; note: string } }; waitingTeams: number; tournament: HomeTournament }

const LABEL = { whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.35 } as const;

function App() {
  const [h, setH] = useState<Home | null>(null);
  const [banners, setBanners] = useState<{ id: number }[]>([]);
  const [tip, setTip] = useState('');
  const tipTimer = useRef<number>(undefined);

  const load = useCallback(async () => {
    const r = await fetch('/api/home');
    if (r.ok) setH(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);
  useEvents(() => load()); // 대기 팀 수·접수 상태가 바뀌면 다시 읽는다
  useEffect(() => { fetch('/api/banners').then((r) => r.json()).then((b) => setBanners(b.banners)); }, []);

  // 접수 시작·마감 시각이 되면 새로고침 없이 버튼 상태를 바꾼다(서버 시각 기준으로 남은 시간을 계산)
  useEffect(() => {
    const t = h?.tournament;
    const target = t?.state === 'upcoming' ? t.applyStart : t?.state === 'open' ? t.applyEnd : null;
    if (!h || !target) return;
    const ms = Date.parse(target.replace(' ', 'T') + ':00') - Date.parse(h.now.replace(' ', 'T'));
    const id = setTimeout(load, Math.min(ms > 0 ? ms + 1000 : 5000, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [h, load]);

  const showTip = (text: string) => {
    setTip(text);
    clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(''), 5000);
  };

  const open = h?.intake.open ?? false;
  const reason = h?.intake.window ? `접수 가능 시간은 ${h.intake.window}입니다.` : '지금은 접수 중이 아닙니다.';
  const tb = tournamentButton(h?.tournament ?? { state: 'none' });

  return (
    <Page title="오란다 볼링파크">
      <div className="flex flex-col gap-2 mb-4">
        {banners.map((b) => <Image key={b.id} src={`/banner/${b.id}`} alt="이벤트" loading="lazy" radius="md" />)}
      </div>
      <div className="flex flex-col gap-3">
        {/* 1. 대기접수: 가장 크고 눈에 띄게 */}
        <Button size="xl" h={150} radius="lg" fullWidth disabled={!h || !open} styles={{ label: LABEL }} onClick={() => location.assign('/waiting')}>
          <div>
            <div className="text-[34px] font-extrabold">대기접수</div>
            <div className="text-base font-medium mt-1">
              {!h ? '불러오는 중…' : open ? (h.waitingTeams ? `현재 ${h.waitingTeams}팀 대기 중` : '지금 바로 접수할 수 있어요') : reason}
            </div>
          </div>
        </Button>
        {/* 2·3. 공지 및 일정 / 대회신청 */}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="default" h={110} radius="lg" styles={{ label: LABEL }} onClick={() => location.assign('/notice')}>
            <div>
              <div className="text-xl font-bold">공지 및 일정</div>
              <div className="text-sm font-normal opacity-70 mt-1">공지사항 · 행사 일정</div>
            </div>
          </Button>
          <Button
            variant={tb.active ? 'filled' : 'default'} color="grape" h={110} radius="lg" styles={{ label: LABEL }}
            data-disabled={!tb.active || undefined}
            onClick={() => (tb.active ? location.assign('/tournament') : showTip(tb.tip))}
          >
            <div>
              <div className="text-xl font-bold">대회신청</div>
              <div className="text-sm font-normal opacity-80 mt-1 break-keep">{h ? tb.sub : '불러오는 중…'}</div>
            </div>
          </Button>
        </div>
        {h && (
          <Text ta="center" c="dimmed" fz="sm" role="note">
            {h.intake.hours.closed
              ? <>오늘은 <b>휴무</b>입니다{h.intake.hours.note ? ` (${h.intake.hours.note})` : ''}</>
              : <>오늘({h.intake.hours.label}) 영업시간 <b>{h.intake.hours.business}</b>{h.intake.hours.business === h.intake.hours.intake ? ' · 대기접수도 같은 시간' : <> · 대기접수 <b>{h.intake.hours.intake}</b></>}{h.intake.hours.note ? ` · ${h.intake.hours.note}` : ''}</>}
          </Text>
        )}
        {h?.intake.hours.memo && <MemoNotice text={h.intake.hours.memo} />}
        {tip && <Alert color="grape" role="status">{tip}</Alert>}
      </div>
      <InstallTip />
      <Text ta="center" c="dimmed" fz="xs" className="mt-6">대기 접수 후 15분 안에 카운터에서 도착 확인을 받아 주세요.</Text>
    </Page>
  );
}

mount(<App />);
