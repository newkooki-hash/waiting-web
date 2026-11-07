import { useEffect, useState } from 'react';
import { Accordion, Anchor, Text, Title } from '@mantine/core';
import { InfoTabs, Page, mount } from './common';

interface Notice { date: string; title: string; body: string }

function App() {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  useEffect(() => { fetch('/api/notices').then((r) => r.json()).then((r) => setNotices(r.notices)); }, []);

  return (
    <Page title="오란다 볼링 공지사항">
      <Title order={3} className="mb-3">공지 및 일정</Title>
      <InfoTabs active="notice" />
      <Text c="dimmed" fz="sm" className="mb-3"><Anchor href="/" c="dimmed">← 처음으로</Anchor></Text>
      {notices && (notices.length ? (
        <Accordion variant="separated" radius="md">
          {notices.map((n, i) => (
            <Accordion.Item key={i} value={String(i)}>
              <Accordion.Control>
                <Text c="dimmed" fz="xs">{n.date}</Text>
                <Text fw={700}>{n.title}</Text>
              </Accordion.Control>
              <Accordion.Panel>
                {n.body ? <Text className="whitespace-pre-wrap">{n.body}</Text> : <Text c="dimmed">내용이 없습니다.</Text>}
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      ) : <Text c="dimmed">등록된 공지사항이 없습니다.</Text>)}
    </Page>
  );
}

mount(<App />);
