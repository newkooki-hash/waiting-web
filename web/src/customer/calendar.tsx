import { useEffect, useState } from 'react';
import { Anchor, Button, Group, Text, Title } from '@mantine/core';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { Card, Page, mount } from './common';
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
      <Title order={3} mb="md">행사 일정</Title>
      <Text c="dimmed" fz="sm" mb="sm"><Anchor href="/" c="dimmed">← 대기 접수</Anchor></Text>
      <Group justify="space-between" mb="sm">
        <Button variant="default" aria-label="이전 달" leftSection={<LuChevronLeft />} onClick={() => setMonth(shiftMonth(month, -1))}>이전</Button>
        <Text fw={700}>{month.slice(0, 4)}년 {Number(month.slice(5))}월</Text>
        <Button variant="default" aria-label="다음 달" rightSection={<LuChevronRight />} onClick={() => setMonth(shiftMonth(month, 1))}>다음</Button>
      </Group>
      {events && (events.length ? events.map((e, i) => {
        const d = new Date(e.date + 'T00:00:00');
        return (
          <Card key={i} p="md" mb="xs" style={e.date === t ? { borderColor: 'var(--mantine-primary-color-filled)' } : undefined}>
            <Text c="blue" fw={700} fz="sm">{d.getMonth() + 1}월 {d.getDate()}일 ({DOW[d.getDay()]}){e.date === t ? ' · 오늘' : ''}</Text>
            <Text fw={700}>{e.title}</Text>
            {e.memo && <Text c="dimmed" fz="sm" style={{ whiteSpace: 'pre-wrap' }}>{e.memo}</Text>}
          </Card>
        );
      }) : <Card><Text c="dimmed">이 달에 등록된 일정이 없습니다.</Text></Card>)}
    </Page>
  );
}

mount(<App />);
