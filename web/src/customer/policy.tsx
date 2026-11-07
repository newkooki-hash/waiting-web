import { useEffect, useState } from 'react';
import { Paper, Text, Title } from '@mantine/core';
import { mount } from './common';
import { Box, Container } from '@mantine/core';

interface Policy { title: string; body: string; updatedAt?: string }

function App() {
  const type = location.pathname === '/privacy' ? 'privacy' : 'terms';
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => { fetch('/api/policy?type=' + type).then((r) => r.json()).then(setP); }, [type]);
  useEffect(() => { document.title = p ? `${p.title} · 오란다 볼링` : '오란다 볼링'; }, [p]);

  return (
    <>
      <Box bg="dark.8" c="gray.0" py="sm"><Container size={640}><Text fw={700}>오란다 볼링파크</Text></Container></Box>
      <Container size={640} py="lg">
        <Title order={3}>{p?.title}</Title>
        <Text c="dimmed" fz="sm">{p?.body ? `시행 ${(p.updatedAt || '').slice(0, 10)}` : ''}</Text>
        {p && (
          <Paper withBorder radius="md" p="lg" mt="md">
            <Text c={p.body ? undefined : 'dimmed'} style={{ whiteSpace: 'pre-wrap' }}>{p.body || '아직 등록된 내용이 없습니다.'}</Text>
          </Paper>
        )}
      </Container>
    </>
  );
}

mount(<App />);
