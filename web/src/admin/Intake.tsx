import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Text, TextInput, Title } from '@mantine/core';
import { post, setBusinessStart } from '../lib/api';
import { Heading, Panel, bind } from './ui';
import type { Intake as IntakeInfo } from './types';

const HOURS_ROW = 'grid items-center gap-2 grid-cols-[112px_minmax(96px,1fr)_14px_minmax(96px,1fr)_150px] [&_label]:whitespace-nowrap';

/** 주소 한 줄: 복사 버튼과(지원하는 기기에서) 공유 버튼 */
function LinkRow({ label, url, share }: { label: string; url: string; share?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); } catch {
      const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setDone(true); window.setTimeout(() => setDone(false), 2000);
  };
  const canShare = share && typeof navigator !== 'undefined' && 'share' in navigator;
  return (
    <div>
      <Text fz="xs" c="dimmed">{label}</Text>
      <div className="flex gap-2 items-center flex-wrap">
        <Text fz="sm" className="break-all flex-1 min-w-[200px]">{url}</Text>
        <Button size="compact-sm" variant="default" onClick={copy}>{done ? '복사됨' : '주소 복사'}</Button>
        {canShare && <Button size="compact-sm" variant="default" onClick={() => navigator.share({ title: '오란다 볼링파크', text: '대기접수 · 공지 및 일정 · 대회 신청', url }).catch(() => {})}>공유</Button>}
      </div>
    </div>
  );
}

export function Intake({ intake, reload }: { intake: IntakeInfo | null; reload: () => void }) {
  const [bizAll, setBizAll] = useState(true);
  const [bizStart, setBizStart] = useState('10:00');
  const [bizEnd, setBizEnd] = useState('22:00');
  const [dayStart, setDayStart] = useState('00:00');
  const [waitSame, setWaitSame] = useState(true);
  const [waitStart, setWaitStart] = useState('10:00');
  const [waitEnd, setWaitEnd] = useState('22:00');
  const [msg, setMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [saving, setSaving] = useState(false);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (!intake) return;
    setBizAll(intake.biz.h24); setBizStart(intake.biz.start); setBizEnd(intake.biz.end); setDayStart(intake.dayStart);
    setWaitSame(intake.wait.same); setWaitStart(intake.wait.start); setWaitEnd(intake.wait.end);
  }, [intake]);

  const qrHtml = useMemo(() => {
    if (!intake) return '';
    const q = qrcode(0, 'M'); q.addData(intake.url); q.make();
    return q.createImgTag(6, 0);
  }, [intake?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!intake) return <section />;

  const save = async () => {
    setSaving(true); setMsg({ text: '저장 중…', color: 'dimmed' });
    const r = await post('/api/admin/intake/hours', {
      biz: { h24: bizAll, start: bizStart, end: bizEnd, ...(bizAll ? { dayStart } : {}) },
      wait: { same: waitSame, start: waitStart, end: waitEnd },
    });
    setSaving(false);
    if (r.ok) setBusinessStart(r.body.bizDay); // 이력·통계의 `오늘`이 바뀐 영업일 기준을 따르도록
    setMsg(r.ok ? { color: 'green', text: '저장되었습니다.' } : { color: 'red', text: r.body.error || '저장에 실패했습니다.' });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg({ text: '', color: '' }), 4000);
    reload();
  };

  return (
    <section>
      <Heading title="QR 관리" sub="손님이 스캔하면 메인 화면이 열리는 QR입니다. 도착 확인은 카운터에서 직원이 대기 현황의 '도착 확인' 버튼으로 합니다." />
      <div className="grid gap-4 grid-cols-1 min-[48em]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel className="print:border-0 print:text-center">
          <div className="inline-block bg-white p-2.5 rounded-lg leading-none [&_img]:w-[220px] [&_img]:h-[220px] print:[&_img]:w-[340px] print:[&_img]:h-[340px]" dangerouslySetInnerHTML={{ __html: qrHtml }} />
          <div className="flex gap-4 items-center flex-wrap mt-3 print:hidden"><Button onClick={() => window.print()}>QR 인쇄</Button></div>
        </Panel>
        <div className="flex flex-col gap-0 print:hidden">
          <Panel>
            <div className="flex gap-3 items-center flex-wrap mb-3">
              <Title order={5}>영업시간 · 대기접수 시간</Title>
              <Badge size="lg" variant="light" color={intake.openNow ? 'green' : 'gray'}>{intake.openNow ? '지금 대기접수 가능' : '지금은 대기접수 시간이 아님'}</Badge>
            </div>
            <div className="flex flex-col gap-4">
              {/* 두 줄이 같은 열: 이름 | 시작 | ~ | 종료 | (오른쪽 끝) 체크박스 */}
              <div className={HOURS_ROW}>
                <Text fw={600} fz="sm" className="whitespace-nowrap">영업시간</Text>
                <TextInput type="time" aria-label="영업 시작" disabled={bizAll} {...bind(bizStart, setBizStart)} />
                <Text ta="center">~</Text>
                <TextInput type="time" aria-label="영업 종료" disabled={bizAll} {...bind(bizEnd, setBizEnd)} />
                <Checkbox label="24시간 영업" checked={bizAll} onChange={(e) => setBizAll(e.currentTarget.checked)} className="justify-self-start" />
              </div>
              <div className={HOURS_ROW}>
                <Text fw={600} fz="sm" className="whitespace-nowrap">영업일 기준</Text>
                <TextInput type="time" aria-label="영업일이 바뀌는 시각" disabled={!bizAll} value={bizAll ? dayStart : intake.bizDay} onChange={(e) => setDayStart(e.currentTarget.value)} />
                <Text c="dimmed" fz="sm" className="col-span-3 whitespace-nowrap">{bizAll ? '에 영업일이 바뀝니다 (이력·통계 기준)' : '영업시간에서 자동으로 정해집니다'}</Text>
              </div>
              <div className={HOURS_ROW}>
                <Text fw={600} fz="sm" className="whitespace-nowrap">대기접수 시간</Text>
                <TextInput type="time" aria-label="접수 시작" disabled={waitSame} {...bind(waitStart, setWaitStart)} />
                <Text ta="center">~</Text>
                <TextInput type="time" aria-label="접수 종료" disabled={waitSame} {...bind(waitEnd, setWaitEnd)} />
                <Checkbox label="영업시간과 동일" checked={waitSame} onChange={(e) => setWaitSame(e.currentTarget.checked)} className="justify-self-start" />
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <Button loading={saving} onClick={save}>저장</Button>
                <Text role="status" c={msg.color}>{msg.text}</Text>
              </div>
            </div>
            <Text c="dimmed" fz="sm" className="mt-3">종료가 시작보다 빠르면 자정을 넘기는 시간으로 봅니다 (예: 18:00~02:00). 대기접수 시간 밖에는 손님이 새로 대기접수를 할 수 없고, 사이트 접속·공지·일정·대회 신청은 시간과 상관없이 이용할 수 있습니다. 손님 화면에는 영업시간과 대기접수 시간이 안내됩니다.</Text>
          </Panel>
          <Panel>
            <Title order={5} className="mb-2.5">접수 주소</Title>
            <Text c="dimmed" fz="sm">QR을 스캔하면 아래 주소의 메인 화면(대기접수·공지 및 일정·대회신청)이 열립니다. 주소가 바뀌지 않으므로 출력한 QR은 계속 쓸 수 있습니다. QR을 쓸 수 없는 손님에게는 주소를 복사하거나 공유해 전달하세요.</Text>
            <div className="mt-3 flex flex-col gap-2">
              <LinkRow label="메인 화면" url={intake.url} share />
              <LinkRow label="대기접수 바로가기" url={intake.url.replace(/\/$/, '') + '/waiting'} />
            </div>
          </Panel>
        </div>
      </div>
    </section>
  );
}
