import { useEffect, useState } from 'react';
import { Paper, Text, Title } from '@mantine/core';
import { mount } from './common';

interface Policy { title: string; body: string; updatedAt?: string }

function App() {
  const type = location.pathname === '/privacy' ? 'privacy' : 'terms';
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => { fetch('/api/policy?type=' + type).then((r) => r.json()).then(setP); }, [type]);
  useEffect(() => { document.title = p ? `${p.title} · 오란다 볼링` : '오란다 볼링'; }, [p]);

  return (
    <>
      <div className="bg-[var(--mantine-color-dark-8)] text-[var(--mantine-color-gray-0)] py-3"><div className="mx-auto w-full max-w-[640px] px-4"><Text fw={700}>오란다 볼링파크</Text></div></div>
      <div className="mx-auto w-full max-w-[640px] px-4 py-5">
        <Title order={3}>{p?.title}</Title>
        <Text c="dimmed" fz="sm">{p?.body ? `시행 ${(p.updatedAt || '').slice(0, 10)}` : ''}</Text>
        {p && (
          <Paper withBorder radius="md" className="p-5 mt-4">
            <Text c={p.body ? undefined : 'dimmed'} className="whitespace-pre-wrap">{p.body || '아직 등록된 내용이 없습니다.'}</Text>
          </Paper>
        )}
      </div>
    </>
  );
}

mount(<App />);
