import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Switch, Text, TextInput, Textarea, Title } from '@mantine/core';
import { post, setBusinessStart } from '../lib/api';
import { Heading, Panel } from './ui';
import { TimeField } from './TimeField';
import type { DayRule, Intake as IntakeInfo } from './types';

const DAYS = ['월', '화', '수', '목', '금', '토', '일', '공휴일']; // 화면 순서(월~일, 공휴일)
const IDX = [1, 2, 3, 4, 5, 6, 0, 7]; // 화면 순서 → 서버 인덱스(0=일, 7=공휴일)
const NEW_RULE: DayRule = { biz: { closed: false, h24: false, start: '10:00', end: '22:00' } };

/** 한 줄 규칙 입력(네이버 플레이스 방식): 영업 시작 ~ 종료, 오른쪽 스위치 켬=영업 / 끔=휴무 */
function RuleFields({ rule, onChange }: { rule: DayRule; onChange: (r: DayRule) => void }) {
  const set = (biz: Partial<DayRule['biz']>) => onChange({ biz: { ...rule.biz, ...biz } });
  const off = rule.biz.closed;
  const time = 'min-w-[130px]';
  return (
    <>
      <TimeField label="영업 시작" className={time} disabled={off} value={rule.biz.start} onChange={(v) => set({ start: v })} />
      <Text ta="center" c="dimmed">~</Text>
      <TimeField label="영업 종료" className={time} disabled={off} value={rule.biz.end} onChange={(v) => set({ end: v })} />
      <Switch size="md" color="green" onLabel="영업" offLabel="휴무" aria-label="영업 여부" checked={!off} onChange={(e) => set({ closed: !e.currentTarget.checked })} />
    </>
  );
}
const ROW = 'grid items-center gap-2 grid-cols-[64px_140px_16px_140px_72px]';
const dateLabel = (d: string) => { const x = new Date(d + 'T00:00:00'); return `${x.getMonth() + 1}/${x.getDate()}(${'일월화수목금토'[x.getDay()]})`; };

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
  const [days, setDays] = useState<DayRule[]>(Array.from({ length: 8 }, () => NEW_RULE));
  const [dayStart, setDayStart] = useState('00:00');
  const [waitBefore, setWaitBefore] = useState('0');
  const [waitOpen, setWaitOpen] = useState('0');
  const [memo, setMemo] = useState('');
  const [exDate, setExDate] = useState('');
  const [exRule, setExRule] = useState<DayRule>({ ...NEW_RULE, biz: { ...NEW_RULE.biz, closed: true } });
  const [exNote, setExNote] = useState('');
  const [msg, setMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [saving, setSaving] = useState(false);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (!intake) return;
    setDays(intake.schedule); setDayStart(intake.dayStart); setWaitBefore(String(intake.waitBefore)); setWaitOpen(String(intake.waitOpen)); setMemo(intake.hours.memo);
  }, [intake]);

  const qrHtml = useMemo(() => {
    if (!intake) return '';
    const q = qrcode(0, 'M'); q.addData(intake.url); q.make();
    return q.createImgTag(6, 0);
  }, [intake?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!intake) return <section />;

  const flash = (m: { text: string; color: string }) => { setMsg(m); clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg({ text: '', color: '' }), 4000); };
  const addException = async () => {
    if (!exDate) return flash({ color: 'red', text: '예외 날짜를 선택하세요.' });
    const r = await post('/api/admin/intake/exception', { date: exDate, biz: exRule.biz, note: exNote });
    flash(r.ok ? { color: 'green', text: '예외 날짜를 저장했습니다.' } : { color: 'red', text: r.body.error || '저장에 실패했습니다.' });
    if (r.ok) { setExDate(''); setExNote(''); }
    reload();
  };
  const saveMemo = async () => {
    const r = await post('/api/admin/intake/memo', { memo });
    flash(r.ok ? { color: 'green', text: '안내 메모를 저장했습니다.' } : { color: 'red', text: r.body.error || '저장에 실패했습니다.' });
    reload();
  };
  const delException = async (date: string) => { await post('/api/admin/intake/exception/delete', { date }); reload(); };
  const all24 = days.every((d) => d.biz.h24 && !d.biz.closed); // 24시간 영업은 하나로 통일(요일별 설정 없음)
  const set24 = (on: boolean) => setDays(days.map((d) => ({ biz: { ...d.biz, h24: on, closed: false } })));
  const ruleText = (r: DayRule) => (r.biz.closed ? '휴무' : `영업 ${r.biz.h24 ? '24시간' : r.biz.start + '~' + r.biz.end}`);

  const save = async () => {
    setSaving(true); setMsg({ text: '저장 중…', color: 'dimmed' });
    const r = await post('/api/admin/intake/schedule', { days, dayStart, waitBefore: Number(waitBefore), waitOpen: Number(waitOpen) });
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
              <div className="rounded-lg p-3.5 bg-[var(--mantine-color-blue-light)]">
                <Text fz="sm" fw={600} c="blue">오늘({intake.hours.label}){intake.hours.note ? ` · ${intake.hours.note}` : ''}</Text>
                {intake.hours.closed ? (
                  <Text fz={22} fw={700} className="mt-1">휴무</Text>
                ) : (
                  <div className="flex gap-x-8 gap-y-1 flex-wrap mt-1">
                    <div><Text fz="xs" c="dimmed">영업</Text><Text fz={22} fw={700} className="leading-tight">{intake.hours.business}</Text></div>
                    <div><Text fz="xs" c="dimmed">대기접수</Text><Text fz={22} fw={700} className="leading-tight">{intake.hours.intake}</Text></div>
                  </div>
                )}
              </div>
              <Switch size="md" color="green" label="24시간 영업" description="켜면 모든 요일·공휴일이 24시간 영업이고, 요일별 시간·휴무는 설정하지 않습니다." checked={all24} onChange={(e) => set24(e.currentTarget.checked)} />
              {!all24 && (
                <>
                  <div className="overflow-x-auto"><div className="flex flex-col gap-2 min-w-[460px]">
                    {IDX.map((idx, k) => (
                      <div key={idx} className={ROW}>
                        <Text fw={600} fz="sm">{DAYS[k]}</Text>
                        <RuleFields rule={days[idx]} onChange={(r) => setDays(days.map((d, i) => (i === idx ? r : d)))} />
                      </div>
                    ))}
                  </div></div>
                  <div className="flex gap-3 items-center flex-wrap">
                    <Button size="compact-sm" variant="default" onClick={() => setDays(days.map(() => days[1]))}>월요일 설정을 모든 요일·공휴일에 적용</Button>
                  </div>
                </>
              )}
              <div className="flex gap-2 items-center flex-wrap">
                <Text fw={600} fz="sm" className="whitespace-nowrap">대기접수 시작</Text>
                <Text fz="sm">영업 시작</Text>
                <TextInput type="number" min={0} max={180} aria-label="대기접수 시작(분 전)" value={waitOpen} onChange={(e) => setWaitOpen(e.currentTarget.value)} onWheel={(e) => e.currentTarget.blur()} className="w-[90px]" />
                <Text fz="sm">분 전부터 (0이면 영업 시작 시각부터)</Text>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <Text fw={600} fz="sm" className="whitespace-nowrap">대기접수 마감</Text>
                <Text fz="sm">영업 종료</Text>
                <TextInput type="number" min={0} max={180} aria-label="대기접수 마감(분 전)" value={waitBefore} onChange={(e) => setWaitBefore(e.currentTarget.value)} onWheel={(e) => e.currentTarget.blur()} className="w-[90px]" />
                <Text fz="sm">분 전까지 (두 값은 모든 요일 공통, 0이면 영업 종료 시각까지)</Text>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <Text fw={600} fz="sm" className="whitespace-nowrap">영업일 기준</Text>
                <TimeField label="영업일이 바뀌는 시각" value={dayStart} onChange={setDayStart} className="w-[110px]" />
                <Text c="dimmed" fz="sm">에 영업일이 바뀝니다 (이력·통계 기준, 00:00~11:59)</Text>
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <Button loading={saving} onClick={save}>저장</Button>
                <Text role="status" c={msg.color}>{msg.text}</Text>
              </div>
            </div>
            <Text c="dimmed" fz="sm" className="mt-3">공휴일 칸은 법정 공휴일(설날·추석 연휴, 대체공휴일 포함)에 자동 적용됩니다. 종료가 시작보다 빠르면 다음 날 새벽까지 이어지는 시간입니다 (예: 18:00~02:00). 대기접수는 영업 시작 M분 전부터 영업 종료 N분 전까지 받습니다. 특정 날짜만 다르게 하려면 아래 예외 날짜를 등록하세요. 대기접수 시간 밖에는 손님이 새로 대기접수를 할 수 없고, 사이트 접속·공지·일정·대회 신청은 시간과 상관없이 이용할 수 있습니다. 손님 화면에는 영업시간과 대기접수 시간이 안내됩니다.</Text>
          </Panel>
          <Panel>
            <Title order={5} className="mb-1">영업 안내 메모 (손님에게 표시)</Title>
            <Text c="dimmed" fz="sm" className="mb-3">메인 화면과 대기접수 화면에 "안내" 상자로 보입니다. 줄을 바꾸면 항목이 나뉩니다. 비워서 저장하면 표시되지 않습니다.</Text>
            <Textarea rows={4} maxLength={500} aria-label="영업 안내 메모" placeholder={'예)\n공휴일 전날은 04시까지 영업합니다.\n영업 종료 1시간 전에는 현장 대기만 가능합니다.\n방문 전 전화 주세요.'} value={memo} onChange={(e) => setMemo(e.currentTarget.value)} />
            <div className="flex gap-3 items-center flex-wrap mt-2">
              <Button onClick={saveMemo}>메모 저장</Button>
              <Text c="dimmed" fz="xs">{memo.length}/500</Text>
              <Text role="status" c={msg.color}>{msg.text}</Text>
            </div>
          </Panel>
          <Panel>
            <Title order={5} className="mb-2.5">예외 날짜 (임시 휴무·단축 영업)</Title>
            <Text c="dimmed" fz="sm" className="mb-3">요일·공휴일 설정보다 우선합니다. 임시공휴일·선거일처럼 자동 목록에 없는 날도 여기에 등록하세요. 같은 날짜를 다시 저장하면 덮어씁니다.</Text>
            <div className="overflow-x-auto"><div className="flex flex-col gap-2 min-w-[460px]">
              <div className="flex gap-2 items-center flex-wrap">
                <TextInput type="date" aria-label="예외 날짜" value={exDate} onChange={(e) => setExDate(e.currentTarget.value)} className="w-[200px]" />
                <TextInput placeholder="사유 (손님 화면에 표시, 예: 정기 휴무)" aria-label="사유" value={exNote} onChange={(e) => setExNote(e.currentTarget.value)} maxLength={60} className="flex-1 min-w-[220px]" />
              </div>
              <div className={ROW}>
                <Text fw={600} fz="sm">적용</Text>
                <RuleFields rule={exRule} onChange={setExRule} />
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <Button onClick={addException}>예외 날짜 저장</Button>
              </div>
            </div></div>
            <div className="mt-3 flex flex-col gap-1">
              {intake.exceptions.length === 0 && <Text c="dimmed" fz="sm">등록된 예외 날짜가 없습니다.</Text>}
              {intake.exceptions.map((x) => (
                <div key={x.date} className="flex gap-2 items-center flex-wrap">
                  <Text fz="sm" fw={600} className="w-[80px]">{dateLabel(x.date)}</Text>
                  <Text fz="sm">{ruleText(x)}{x.note ? ` · ${x.note}` : ''}</Text>
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => delException(x.date)}>삭제</Button>
                </div>
              ))}
            </div>
            <Text fw={600} fz="sm" className="mt-4 mb-1">다가오는 공휴일 (자동)</Text>
            <div className="flex gap-1.5 flex-wrap">
              {intake.holidays.slice(0, 14).map((h) => <Badge key={h.date} variant="light" color="gray" size="lg">{dateLabel(h.date)} {h.name}</Badge>)}
            </div>
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
