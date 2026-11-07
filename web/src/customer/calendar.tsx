import { useEffect, useState } from 'react';
import { Anchor, Button, Text, Title } from '@mantine/core';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { Card, InfoTabs, Page, mount } from './common';
import { DOW, shiftMonth, today } from '../lib/api';

interface CalEvent { date: string; title: string; memo: string }

function App() {
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const t = today();

  useEffect(() => {
    fetch('/api/calendar?month=' + month).then((r) => r.json()).then((r) => setEvents(r.events));
  }, [month]);

  return (
    <Page title="오란다 볼링 행사 일정">
      <Title order={3} className="mb-3">공지 및 일정</Title>
      <InfoTabs active="calendar" />
      <Text c="dimmed" fz="sm" className="mb-3"><Anchor href="/" c="dimmed">← 처음으로</Anchor></Text>
      <div className="flex gap-4 items-center justify-between flex-wrap mb-3">
        <Button variant="default" aria-label="이전 달" leftSection={<LuChevronLeft />} onClick={() => setMonth(shiftMonth(month, -1))}>이전</Button>
        <Text fw={700}>{month.slice(0, 4)}년 {Number(month.slice(5))}월</Text>
        <Button variant="default" aria-label="다음 달" rightSection={<LuChevronRight />} onClick={() => setMonth(shiftMonth(month, 1))}>다음</Button>
      </div>
      {events && (events.length ? events.map((e, i) => {
        const d = new Date(e.date + 'T00:00:00');
        return (
          <Card key={i} style={e.date === t ? { borderColor: 'var(--mantine-primary-color-filled)' } : undefined} className="p-4 mb-2.5">
            <Text c="blue" fw={700} fz="sm">{d.getMonth() + 1}월 {d.getDate()}일 ({DOW[d.getDay()]}){e.date === t ? ' · 오늘' : ''}</Text>
            <Text fw={700}>{e.title}</Text>
            {e.memo && <Text c="dimmed" fz="sm" className="whitespace-pre-wrap">{e.memo}</Text>}
          </Card>
        );
      }) : <Card><Text c="dimmed">이 달에 등록된 일정이 없습니다.</Text></Card>)}
    </Page>
  );
}

mount(<App />);
