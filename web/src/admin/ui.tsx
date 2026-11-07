import { createContext, useContext, useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Anchor, Button, Modal, Paper, Table, Text, TextInput, Title, type PaperProps } from '@mantine/core';
import { post } from '../lib/api';

export const STATUS: Record<string, string> = { WAITING: '대기', ASSIGNED: '배정', FINISHED: '종료', CANCELED: '취소', EXPIRED: '도착 만료' };
/** 상태별 색: 대기=청록, 배정·종료=파랑, 취소=빨강, 도착 만료=회색 */
export const STATUS_COLOR: Record<string, string> = { WAITING: 'teal', ASSIGNED: 'blue', FINISHED: 'blue', CANCELED: 'red', EXPIRED: 'gray' };

/** <input value onChange> 한 쌍을 state와 묶는다 */
export const bind = (value: string, set: (v: string) => void) => ({
  value,
  onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(e.currentTarget.value),
});

export function Heading({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <Title order={3}>{title}</Title>
      {sub && <Text c="dimmed" fz="sm">{sub}</Text>}
    </div>
  );
}

export function Panel({ children, ...rest }: { children: ReactNode } & PaperProps & Record<string, unknown>) {
  return <Paper withBorder radius="md" {...rest} className="p-4 mb-4">{children}</Paper>;
}

export function Msg({ children, ok }: { children: ReactNode; ok?: boolean }) {
  return children ? <Text c={ok ? 'green' : 'red'} role="alert" className="mt-1">{children}</Text> : null;
}

/** 표에 내용이 없을 때 한 줄로 안내한다 */
export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return <Table.Tr><Table.Td colSpan={cols} ta="center" c="dimmed" className="py-8">{children}</Table.Td></Table.Tr>;
}

export function DataTable({ head, children, mb = 'md' }: { head: ReactNode[]; children: ReactNode; mb?: string }) {
  return (
    <Paper withBorder radius="md" mb={mb}>
      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead><Table.Tr>{head.map((h, i) => <Table.Th key={i} fz="xs" c="dimmed">{h}</Table.Th>)}</Table.Tr></Table.Thead>
          <Table.Tbody>{children}</Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

/** 줄 끝의 버튼 묶음 */
export function Actions({ children }: { children: ReactNode }) {
  return <Table.Td><div className="flex gap-2.5 items-center justify-end flex-nowrap">{children}</div></Table.Td>;
}

export const Meta = ({ children }: { children: ReactNode }) => <Text c="dimmed" fz="xs">{children}</Text>;

// 원문 보기: 마스킹된 번호를 누르면 조회 사유를 묻고, 사유와 함께 기록한 뒤 닫기 전까지만 보여 준다
type Target = { type: string; id: number };
const RevealCtx = createContext<(t: Target) => void>(() => {});

export function RevealProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');

  const open = (t: Target) => { setTarget(t); setReason(''); setOut(''); setErr(''); setOpened(true); };
  const close = () => { setOut(''); setOpened(false); };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const r = await post('/api/admin/reveal', { ...target, reason });
    if (!r.ok) return setErr(r.body.error || '조회에 실패했습니다.');
    setErr('');
    setOut(`${r.body.phone}  ${r.body.email}`.trim());
    setReason('');
  };

  return (
    <RevealCtx.Provider value={open}>
      {children}
      <Modal opened={opened} onClose={close} title="원문 보기" centered>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <TextInput placeholder="조회 사유 (예: 분실물 연락, 미결제 확인)" maxLength={100} autoComplete="off" required data-autofocus {...bind(reason, setReason)} />
            {out && <Text fw={700} role="status">{out}</Text>}
            {err && <Text c="red" role="alert">{err}</Text>}
            <div className="flex gap-4 items-center justify-end flex-wrap">
              <Button variant="default" onClick={close}>닫기</Button>
              {!out && <Button type="submit">확인</Button>}
            </div>
          </div>
        </form>
      </Modal>
    </RevealCtx.Provider>
  );
}

export function Rv({ type, id, masked }: { type: string; id: number; masked?: string }) {
  const open = useContext(RevealCtx);
  if (!masked) return null;
  return (
    <Anchor component="button"
      type="button"
      c="inherit"
      fz="inherit"
      td="underline"
      className="decoration-dotted underline-offset-[3px]"
      title="누르면 원문 조회(사유 입력)"
      onClick={(ev) => { ev.stopPropagation(); open({ type, id }); }}>{masked}</Anchor>
  );
}

/** 마운트될 때와 deps가 바뀔 때 load를 부른다 */
export function useLoad(load: () => void | Promise<void>, deps: unknown[] = []) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, deps);
}
