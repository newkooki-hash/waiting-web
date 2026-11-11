import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Anchor, Button, Checkbox, Paper, PaperProps, PinInput, Text, TextInput } from '@mantine/core';
import { mountApp } from '../lib/app';
import { post } from '../lib/api';
import type { Me } from '../lib/types';
import { confirmDialog, alertDialog } from '../lib/dialogs';

export function mount(node: ReactNode) {
  mountApp(node);
}

/** 손님 화면 공통 틀: 상단 브랜드 띠 + 좁은 본문 */
export function Page({ title, children }: { title?: string; children: ReactNode }) {
  useEffect(() => { if (title) document.title = title; }, [title]);
  return (
    <>
      <div className="bg-[var(--mantine-color-dark-8)] text-[var(--mantine-color-gray-0)] py-3">
        <div className="mx-auto w-full max-w-[420px] px-4"><Anchor href="/" c="inherit" underline="never"><Text fw={700}>오란다 볼링파크</Text></Anchor></div>
      </div>
      <div className="mx-auto w-full max-w-[420px] px-4 py-5">{children}</div>
    </>
  );
}

/** 공지사항·행사 일정 화면 위의 탭(링크) */
/** 관리자가 적은 영업 안내 메모. 줄마다 한 항목으로 보여 준다(HTML 아님, 글자 그대로) */
export function MemoNotice({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  return (
    <Paper withBorder radius="md" p="sm" role="note" className="bg-[var(--mantine-color-yellow-light)]">
      <Text fz="sm" fw={700} className="mb-1">안내</Text>
      <ul className="m-0 pl-5 text-sm leading-relaxed break-keep">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </Paper>
  );
}

export function InfoTabs({ active }: { active: 'notice' | 'calendar' }) {
  return (
    <div className="flex gap-2 mb-4">
      <Button component="a" href="/notice" fullWidth variant={active === 'notice' ? 'filled' : 'default'}>공지사항</Button>
      <Button component="a" href="/calendar" fullWidth variant={active === 'calendar' ? 'filled' : 'default'}>행사 일정</Button>
    </div>
  );
}

export function Card({ children, ...rest }: { children: ReactNode } & PaperProps & Record<string, unknown>) {
  return <Paper withBorder radius="md" {...rest} className="p-5 mb-3">{children}</Paper>;
}

/** /api/me 를 불러와 두고 reload()로 다시 읽는다 */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const reload = useCallback(async () => {
    const m: Me = await (await fetch('/api/me')).json();
    setMe(m);
    return m;
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { me, reload };
}

export function UserBar({ me, onDone }: { me: Me; onDone: (kind: 'logout' | 'withdraw') => void }) {
  const withdraw = async () => {
    if (!await confirmDialog('탈퇴하면 회원 정보가 삭제되고 대기 중인 접수는 취소됩니다. 일정 기간 동안은 다시 가입할 수 없습니다. 탈퇴할까요?')) return;
    const r = await post('/api/me/withdraw', { confirm: true });
    if (!r.ok) return alertDialog(r.body.error || '탈퇴에 실패했습니다.');
    await alertDialog('탈퇴가 완료되었습니다.');
    onDone('withdraw');
  };
  const logout = async () => {
    await post('/api/logout');
    onDone('logout');
  };
  return (
    <div className="flex gap-4 items-center justify-between flex-wrap mb-2.5 text-[var(--mantine-color-dimmed)] text-[var(--mantine-font-size-sm)]">
      <span>{me.user!.name}님</span>
      <div className="flex gap-[6px] items-center flex-wrap">
        <Anchor component="button" type="button" fz="sm" c="dimmed" onClick={withdraw}>회원 탈퇴</Anchor>·
        <Anchor component="button" type="button" fz="sm" c="dimmed" onClick={logout}>로그아웃</Anchor>
      </div>
    </div>
  );
}

const SSO_COLOR: Record<string, { bg: string; fg: string }> = {
  kakao: { bg: '#fee500', fg: '#191919' },
  naver: { bg: '#03c75a', fg: '#fff' },
};

export function Providers({ me, next }: { me: Me; next?: string }) {
  if (!me.providers.length) return <Text ta="center" c="dimmed">로그인 설정이 아직 되어 있지 않습니다.</Text>;
  return (
    <div className="flex flex-col gap-2.5">
      {me.providers.map((p) => (
        <Button key={p.id}
      component="a"
      href={`/auth/${p.id}${next ? `?next=${next}` : ''}`}
      size="md"
      fullWidth
      color={SSO_COLOR[p.id]?.bg}
      c={SSO_COLOR[p.id]?.fg}>
          {p.label}로 시작하기
        </Button>
      ))}
    </div>
  );
}

export function Consent({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const miss = me.consent?.missing || [];
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [marketing, setMarketing] = useState(!!me.consent?.marketing);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    const body: Record<string, boolean> = { marketing };
    if (miss.includes('terms')) body.terms = terms;
    if (miss.includes('privacy')) body.privacy = privacy;
    const r = await post('/api/consent', body);
    if (!r.ok) return setErr(r.body.error || '저장에 실패했습니다.');
    onSaved();
  };
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Text fw={700}>서비스 이용 동의</Text>
        {miss.includes('terms') && (
          <Checkbox checked={terms}
      onChange={(e) => setTerms(e.currentTarget.checked)}
      label={<>[필수] <Anchor href="/terms" target="_blank" rel="noopener">이용약관</Anchor>에 동의합니다</>} />
        )}
        {miss.includes('privacy') && (
          <Checkbox checked={privacy}
      onChange={(e) => setPrivacy(e.currentTarget.checked)}
      label={<>[필수] <Anchor href="/privacy" target="_blank" rel="noopener">개인정보 수집·이용</Anchor>에 동의합니다</>} />
        )}
        <Checkbox checked={marketing} onChange={(e) => setMarketing(e.currentTarget.checked)} label="[선택] 이벤트·행사 소식 수신에 동의합니다" />
        <Button size="md" onClick={submit}>동의하고 계속하기</Button>
        {err && <Text c="red" role="alert">{err}</Text>}
      </div>
    </Card>
  );
}

export function PhoneVerify({ hint, purpose, onVerified, onForbidden }: {
  hint: string; purpose?: string; onVerified: () => void; onForbidden?: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [left, setLeft] = useState(0); // 다시 받기까지 남은 초
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const send = async () => {
    setErr(''); setBusy(true);
    const r = await post('/api/phone/send', purpose ? { phone, for: purpose } : { phone });
    if (r.status === 403) onForbidden?.();
    setBusy(false);
    if (!r.ok) return setErr(r.body.error || '요청에 실패했습니다.');
    setSent(true); setLeft(60);
  };
  const check = async (value = code) => {
    setErr('');
    const r = await post('/api/phone/verify', { code: value });
    if (!r.ok) return setErr(r.body.error || '인증에 실패했습니다.');
    if (r.body.merge) { // 같은 번호로 다른 플랫폼에 가입한 회원이 있다
      const m = r.body.merge as { providers: string[]; phone: string };
      const ok = await confirmDialog(`이미 ${m.providers.join('·')}로 가입된 회원입니다 (${m.phone}). 이 로그인도 같은 회원으로 통합할까요? 통합하면 어느 쪽으로 로그인해도 같은 대기 정보를 씁니다.`, { confirmLabel: '통합하기' });
      if (!ok) return setErr('통합하지 않으면 이 로그인으로는 접수할 수 없습니다. 기존 로그인 방식으로 이용하거나 다시 인증해 주세요.');
      const mr = await post('/api/phone/merge', {});
      if (!mr.ok) return setErr(mr.body.error || '통합에 실패했습니다.');
    }
    onVerified();
  };
  const sendLabel = left > 0 ? `다시 받기 (${left})` : sent ? '다시 받기' : '인증번호 받기';
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Text c="dimmed" fz="sm">{hint}</Text>
        <TextInput label="휴대전화번호" type="tel" inputMode="numeric" autoComplete="tel" placeholder="01012345678" size="md" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
        <Button size="md" loading={busy} disabled={left > 0} onClick={send}>{sendLabel}</Button>
        {sent && (
          <div className="flex flex-col gap-2.5 items-center">
            <Text fz="sm" c="dimmed" ta="left" className="w-full">인증번호 6자리</Text>
            <PinInput length={6} type="number" oneTimeCode autoFocus size="md" value={code} onChange={setCode} onComplete={check} aria-label="인증번호" />
            <Button size="md" fullWidth disabled={code.length < 6} onClick={() => check()}>확인</Button>
          </div>
        )}
        {err && <Text c="red" role="alert">{err}</Text>}
      </div>
    </Card>
  );
}
