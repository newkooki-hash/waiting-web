import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Box, Button, Container, Group, Menu, Paper, PasswordInput, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { LuChevronDown } from 'react-icons/lu';
import { mountApp } from '../lib/app';
import './admin.css';
import { post } from '../lib/api';
import { useEvents } from '../lib/useEvents';
import { Blacklist } from './Blacklist';
import { CalendarView } from './Calendar';
import { History } from './History';
import { Intake } from './Intake';
import { Members } from './Members';
import { Notices } from './Notices';
import { Queue } from './Queue';
import { StatsView } from './Stats';
import { Tournaments } from './Tournaments';
import { RevealProvider } from './ui';
import { useSound } from './useSound';
import type { Intake as IntakeInfo } from './types';

const VIEWS = ['queue', 'history', 'stats', 'tournaments', 'calendar', 'notices', 'members', 'blacklist', 'intake'] as const;
type View = (typeof VIEWS)[number];
const SETTINGS: [View, string][] = [['history', '이력 조회'], ['calendar', '행사 일정'], ['notices', '공지/이미지'], ['stats', '통계'], ['members', '회원 관리'], ['blacklist', '블랙리스트']];

const readView = (): View => {
  const h = location.hash.slice(1) as View;
  return VIEWS.includes(h) ? h : 'queue'; // 옛 #done 주소는 대기 관리로 연결된다
};

function Login({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const r = await post('/api/admin/login', { id: id.trim(), password: pw });
    if (!r.ok) return setErr(r.body.error);
    setPw('');
    onDone();
  };
  return (
    <Paper component="form" onSubmit={submit} withBorder radius="md" p="xl" maw={340} mx="auto" mt="12vh">
      <Title order={4} mb="md">오란다 볼링 관리자</Title>
      <TextInput placeholder="아이디" autoComplete="username" required mb="sm" value={id} onChange={(e) => setId(e.currentTarget.value)} />
      <PasswordInput placeholder="비밀번호" autoComplete="current-password" required mb="sm" value={pw} onChange={(e) => setPw(e.currentTarget.value)} />
      <Button type="submit" fullWidth>로그인</Button>
      {err && <Text c="red" role="alert" mt="sm">{err}</Text>}
    </Paper>
  );
}

/** 상단 메뉴 한 칸 */
function NavLink({ active, children, ...rest }: { active?: boolean; children: React.ReactNode } & React.ComponentProps<'a'>) {
  return (
    <Box component="a" {...rest} px="md" h="100%" c={active ? 'white' : 'gray.5'}
      style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, whiteSpace: 'nowrap', textDecoration: 'none', cursor: 'pointer', borderBottom: `3px solid ${active ? 'var(--mantine-color-teal-5)' : 'transparent'}` }}>
      {children}
    </Box>
  );
}

const Dot = ({ color, blink, title }: { color?: string; blink?: boolean; title?: string }) => (
  <Box component="span" title={title} w={9} h={9}
    style={{ borderRadius: '50%', background: color ?? 'var(--mantine-color-red-6)', animation: blink ? 'blink 1s steps(2, start) infinite' : undefined }} />
);

function Shell({ onLogout, onUnauthorized }: { onLogout: () => void; onUnauthorized: () => void }) {
  const [view, setView] = useState<View>(readView);
  const [intake, setIntake] = useState<IntakeInfo | null>(null);
  const [tick, setTick] = useState(0);
  const sound = useSound();

  useEffect(() => {
    const on = () => setView(readView());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const loadIntake = useCallback(async () => {
    const r = await fetch('/api/admin/intake');
    if (r.status === 401) return onUnauthorized();
    if (r.ok) setIntake(await r.json());
  }, [onUnauthorized]);
  useEffect(() => { loadIntake(); }, [loadIntake]);

  useEvents((data) => { setTick((t) => t + 1); if (data === 'new') sound.beep(); });

  const intakeColor = !intake ? undefined : intake.openNow ? 'var(--mantine-color-green-5)' : intake.open ? 'var(--mantine-color-orange-5)' : undefined;
  const intakeTitle = !intake ? '' : !intake.open ? '접수 중지' : intake.openNow ? '접수 중' : '접수 시간 외';
  const soundColor = sound.dot === 'on' ? 'var(--mantine-color-green-5)' : sound.dot ? 'var(--mantine-color-orange-5)' : undefined;
  const inSettings = SETTINGS.some(([v]) => v === view);

  return (
    <div>
      <Box component="header" bg="dark.8" c="white" style={{ position: 'sticky', top: 0, zIndex: 5 }}>
        <Container size={1100} px="md">
          <Group gap="lg" h={56} wrap="nowrap">
            <Text fw={700} visibleFrom="md" style={{ whiteSpace: 'nowrap' }}>오란다 볼링파크</Text>
            <Group component="nav" aria-label="관리 메뉴" gap={4} h="100%" wrap="nowrap" style={{ flex: 1 }}>
              <NavLink href="#queue" active={view === 'queue'}>대기 관리</NavLink>
              <NavLink href="#tournaments" active={view === 'tournaments'}>대회 관리</NavLink>
              <NavLink href="#intake" active={view === 'intake'}>QR 관리 <Dot color={intakeColor} title={intakeTitle} /></NavLink>
              <NavLink role="button" tabIndex={0} title={sound.title} onClick={sound.toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sound.toggle(); } }}>
                알림음 <Dot color={soundColor} blink={sound.dot.includes('blink')} />
              </NavLink>
              <Menu trigger="hover" openDelay={50} closeDelay={150} position="bottom-start" withinPortal>
                <Menu.Target>
                  <UnstyledButton h="100%" px="md" c={inSettings ? 'white' : 'gray.5'} fw={600}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: `3px solid ${inSettings ? 'var(--mantine-color-teal-5)' : 'transparent'}` }}>
                    설정 <LuChevronDown />
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  {SETTINGS.map(([v, label]) => (
                    <Menu.Item key={v} component="a" href={`#${v}`} fw={view === v ? 700 : 400}>{label}</Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            </Group>
            <Button variant="white" color="dark" size="xs" onClick={async () => { await post('/api/admin/logout'); onLogout(); }}>로그아웃</Button>
          </Group>
        </Container>
      </Box>
      <Container size={1100} px="md" pt="lg" pb={48}>
        {view === 'queue' && <Queue tick={tick} onUnauthorized={onUnauthorized} />}
        {view === 'history' && <History />}
        {view === 'tournaments' && <Tournaments />}
        {view === 'calendar' && <CalendarView />}
        {view === 'notices' && <Notices />}
        {view === 'stats' && <StatsView />}
        {view === 'members' && <Members />}
        {view === 'blacklist' && <Blacklist onChanged={() => setTick((t) => t + 1)} />}
        {view === 'intake' && <Intake intake={intake} reload={loadIntake} />}
      </Container>
    </div>
  );
}

function App() {
  // null = 확인 중, false = 로그인 필요
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => { document.title = '오란다 볼링 관리자'; }, []);
  useEffect(() => { fetch('/api/admin/intake').then((r) => setAuthed(r.status !== 401)); }, []);
  const lost = useCallback(() => setAuthed(false), []);

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <RevealProvider><Shell onLogout={() => setAuthed(false)} onUnauthorized={lost} /></RevealProvider>;
}

mountApp(<App />);
