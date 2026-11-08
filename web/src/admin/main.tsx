import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Menu, Paper, PasswordInput, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { LuChevronDown } from 'react-icons/lu';
import { mountApp } from '../lib/app';
import { post } from '../lib/api';
import { useEvents } from '../lib/useEvents';
import { Blacklist } from './Blacklist';
import { Limits } from './Limits';
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

const VIEWS = ['queue', 'history', 'stats', 'tournaments', 'calendar', 'notices', 'members', 'blacklist', 'limits', 'intake'] as const;
type View = (typeof VIEWS)[number];
const SETTINGS: [View, string][] = [['history', '이력 조회'], ['calendar', '행사 일정'], ['notices', '공지/이미지'], ['stats', '통계'], ['members', '회원 관리'], ['blacklist', '블랙리스트'], ['limits', '접수 제한']];

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
    <Paper component="form" onSubmit={submit} withBorder radius="md" className="p-8 max-w-[340px] mx-auto mt-[12vh]">
      <Title order={4} className="mb-4">오란다 볼링 관리자</Title>
      <TextInput placeholder="아이디" autoComplete="username" required value={id} onChange={(e) => setId(e.currentTarget.value)} className="mb-3" />
      <PasswordInput placeholder="비밀번호" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.currentTarget.value)} className="mb-3" />
      <Button type="submit" fullWidth>로그인</Button>
      {err && <Text c="red" role="alert" className="mt-3">{err}</Text>}
    </Paper>
  );
}

/** 상단 메뉴 한 칸 */
const NAV = 'flex items-center gap-2 h-full px-4 font-semibold whitespace-nowrap no-underline cursor-pointer border-b-[3px]';
const ACTIVE = 'text-white border-[var(--mantine-color-teal-5)]';
const IDLE = 'text-[var(--mantine-color-gray-5)] border-transparent';
function NavLink({ active, children, ...rest }: { active?: boolean; children: React.ReactNode } & React.ComponentProps<'a'>) {
  return (
    <a {...rest} className={`${NAV} ${active ? ACTIVE : IDLE}`}>
      {children}
    </a>
  );
}

const Dot = ({ color, blink, title }: { color?: string; blink?: boolean; title?: string }) => (
  <span title={title} style={{ background: color ?? 'var(--mantine-color-red-6)' }}
    className={`inline-block w-[9px] h-[9px] rounded-full ${blink ? 'animate-blink' : ''}`} />
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
      <header className="sticky top-0 z-[5] bg-[var(--mantine-color-dark-8)] text-white">
        <div className="mx-auto w-full max-w-[1100px] px-4">
          <div className="flex gap-5 items-center flex-nowrap h-[56px]">
            <span className="font-bold whitespace-nowrap max-[991px]:hidden">오란다 볼링파크</span>
            <nav aria-label="관리 메뉴" className="flex flex-1 gap-1 items-center flex-nowrap h-full">
              <NavLink href="#queue" active={view === 'queue'}>대기 관리</NavLink>
              <NavLink href="#tournaments" active={view === 'tournaments'}>대회 관리</NavLink>
              <NavLink href="#intake" active={view === 'intake'}>QR 관리 <Dot color={intakeColor} title={intakeTitle} /></NavLink>
              <NavLink role="button" tabIndex={0} title={sound.title} onClick={sound.toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sound.toggle(); } }}>
                알림음 <Dot color={soundColor} blink={sound.dot.includes('blink')} />
              </NavLink>
              <Menu trigger="hover" openDelay={50} closeDelay={150} position="bottom-start" withinPortal>
                <Menu.Target>
                  <UnstyledButton className={`${NAV} ${inSettings ? ACTIVE : IDLE}`}>
                    설정 <LuChevronDown />
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  {SETTINGS.map(([v, label]) => (
                    <Menu.Item key={v} component="a" href={`#${v}`} fw={view === v ? 700 : 400}>{label}</Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            </nav>
            <Button variant="white" color="dark" size="xs" onClick={async () => { await post('/api/admin/logout'); onLogout(); }}>로그아웃</Button>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-[1100px] px-4 pt-5 pb-12">
        {view === 'queue' && <Queue tick={tick} onUnauthorized={onUnauthorized} />}
        {view === 'history' && <History />}
        {view === 'tournaments' && <Tournaments />}
        {view === 'calendar' && <CalendarView />}
        {view === 'notices' && <Notices />}
        {view === 'stats' && <StatsView />}
        {view === 'members' && <Members />}
        {view === 'blacklist' && <Blacklist onChanged={() => setTick((t) => t + 1)} />}
        {view === 'limits' && <Limits />}
        {view === 'intake' && <Intake intake={intake} reload={loadIntake} />}
      </div>
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
