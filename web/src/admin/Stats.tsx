import { useState, type ReactNode } from 'react';
import { Button, Paper, Progress, Table, Text, TextInput, Title } from '@mantine/core';
import { DOW, getJson, today } from '../lib/api';
import { DataTable, EmptyRow, Heading, Msg, Panel, bind, useLoad } from './ui';

const minText = (v: number | null) => (v === null ? '-' : `${v}분`);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

interface Stats {
  total: { teams: number; people: number; assigned: number; canceled: number; expired: number; waiting: number; avgWait: number | null; avgAssignedWait: number | null; avgCanceledWait: number | null; medianWait: number | null; maxWait: number | null };
  manual: number;
  hours: { hour: number; teams: number; avgWait: number | null }[];
  weekdays: { dow: number; teams: number; people: number; canceled: number; avgWait: number | null }[];
  days: { day: string; teams: number; people: number; assigned: number; canceled: number; avgWait: number | null }[];
}

function Card({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <Paper withBorder radius="md" className="p-4">
      <Text c="dimmed" fz="sm">{label}</Text>
      <Text fz={28} fw={800} lh={1.2}>{value}</Text>
      {sub ? <Text c="dimmed" fz="sm">{sub}</Text> : null}
    </Paper>
  );
}

export function StatsView() {
  const [from, setFrom] = useState(addDays(today(), -29));
  const [to, setTo] = useState(today());
  const [msg, setMsg] = useState('');
  const [s, setS] = useState<Stats | null>(null);

  const load = async (f = from, t = to) => {
    setMsg('');
    const r = await getJson<Stats & { error?: string }>('/api/admin/stats?' + new URLSearchParams({ from: f, to: t }));
    if (!r.ok) return setMsg(r.body.error || '조회에 실패했습니다.');
    setS(r.body);
  };
  useLoad(() => load());
  const setRange = (days: number) => {
    const f = addDays(today(), -(days - 1));
    setFrom(f); setTo(today()); load(f, today());
  };

  const t = s?.total;
  const rate = t ? (t.teams ? Math.round(t.canceled / t.teams * 1000) / 10 : 0) : 0;
  const peak = s ? Math.max(1, ...s.hours.map((h) => h.teams)) : 1;

  return (
    <section>
      <Heading title="통계" sub="접수일 기준입니다. 대기 시간은 접수부터 레인 배정까지이고, 배정 없이 취소된 건은 접수부터 취소까지입니다." />
      <Panel>
        <form onSubmit={(ev) => { ev.preventDefault(); load(); }}>
          <div className="flex gap-4 items-end flex-wrap">
            <TextInput type="date" aria-label="시작일" required {...bind(from, setFrom)} />
            <Text className="pb-[6px]">~</Text>
            <TextInput type="date" aria-label="종료일" required {...bind(to, setTo)} />
            <Button type="submit">조회</Button>
            {[7, 30, 90].map((d) => <Button key={d} variant="default" onClick={() => setRange(d)}>최근 {d}일</Button>)}
          </div>
        </form>
      </Panel>
      <Msg>{msg}</Msg>
      {s && t && (
        <>
          <div className="grid gap-4 grid-cols-2 min-[48em]:grid-cols-3 min-[62em]:grid-cols-5 mb-4">
            <Card label="접수" value={`${t.teams}팀`} sub={`${t.people}명 · 수기 ${s.manual}팀`} />
            <Card label="배정" value={`${t.assigned}팀`} sub={t.waiting ? `대기 중 ${t.waiting}팀` : ''} />
            <Card label="취소율" value={`${rate}%`} sub={`${t.canceled}팀 취소 · ${t.expired}팀 도착 만료`} />
            <Card label="평균 대기" value={minText(t.avgWait)} sub={`배정 ${minText(t.avgAssignedWait)} · 취소 ${minText(t.avgCanceledWait)}`} />
            <Card label="대기 중앙값·최장" value={minText(t.medianWait)} sub={`최장 ${minText(t.maxWait)}`} />
          </div>
          <Panel>
            <Title order={5} className="mb-2.5">시간대별 접수</Title>
            {s.hours.length ? s.hours.map((h) => (
              <div key={h.hour} className="flex gap-3 items-center flex-nowrap py-[3px]">
                <Text fz="sm" className="w-[36px]">{String(h.hour).padStart(2, '0')}시</Text>
                <Progress value={Math.round(h.teams / peak * 100)} color="teal" size="md" className="flex-1" aria-label={`${h.hour}시`} />
                <Text ta="right" fz="sm" c="dimmed" className="w-[130px]">{h.teams}팀 · {minText(h.avgWait)}</Text>
              </div>
            )) : <Text c="dimmed" fz="sm">기간 내 접수가 없습니다.</Text>}
          </Panel>
          <Title order={5} className="mb-2.5">요일별</Title>
          <DataTable head={['요일', '접수 팀', '인원', '취소', '평균 대기']}>
            {s.weekdays.length ? s.weekdays.map((w) => (
              <Table.Tr key={w.dow}><Table.Td>{DOW[w.dow]}</Table.Td><Table.Td>{w.teams}</Table.Td><Table.Td>{w.people}</Table.Td><Table.Td>{w.canceled}</Table.Td><Table.Td>{minText(w.avgWait)}</Table.Td></Table.Tr>
            )) : <EmptyRow cols={5}>자료가 없습니다.</EmptyRow>}
          </DataTable>
          <Title order={5} className="mb-2.5">일별</Title>
          <DataTable head={['날짜', '접수 팀', '인원', '배정', '취소', '평균 대기']}>
            {s.days.length ? [...s.days].reverse().map((d) => (
              <Table.Tr key={d.day}><Table.Td>{d.day}</Table.Td><Table.Td>{d.teams}</Table.Td><Table.Td>{d.people}</Table.Td><Table.Td>{d.assigned}</Table.Td><Table.Td>{d.canceled}</Table.Td><Table.Td>{minText(d.avgWait)}</Table.Td></Table.Tr>
            )) : <EmptyRow cols={6}>자료가 없습니다.</EmptyRow>}
          </DataTable>
        </>
      )}
    </section>
  );
}
