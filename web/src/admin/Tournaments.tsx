import { useRef, useState } from 'react';
import { Badge, Button, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { post } from '../lib/api';
import { formDialog, promptDialog } from '../lib/dialogs';
import { Actions, DataTable, EmptyRow, Heading, Meta, Msg, Panel, Rv, bind, useLoad } from './ui';

interface T {
  id: number; name: string; eventAt: string; applyStart: string; applyEnd: string; capacity: number; fee: number; info: string;
  taken: number; waitlist: number; ended: boolean; apply: 'before' | 'open' | 'closed';
}
interface TE {
  id: number; name: string; phone: string; status: string; manual: boolean; paidAt: string; appliedAt: string;
  deleteReason: string; refundMemo: string;
}

const T_STATUS: Record<string, string> = { PENDING: '입금 대기', CONFIRMED: '확정', WAITLIST: '대기', DELETED: '삭제' };
const T_APPLY = { before: '시작 전', open: '접수 중', closed: '마감' };
const dt = (v: string) => v.replace(' ', 'T'); // datetime-local 값
const EMPTY = { name: '', event: '', start: '', end: '', cap: '', fee: '', info: '' };

export function Tournaments() {
  const [list, setList] = useState<T[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [f, setF] = useState(EMPTY);
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const r = await fetch('/api/admin/tournaments');
    if (r.ok) setList((await r.json()).tournaments);
  };
  useLoad(load);

  const set = (k: keyof typeof EMPTY) => bind(f[k], (v) => setF({ ...f, [k]: v }));
  const reset = () => { setEditId(null); setF(EMPTY); };

  const save = async () => {
    setMsg('');
    const r = await post('/api/admin/tournaments', {
      id: editId, name: f.name, eventAt: f.event, applyStart: f.start, applyEnd: f.end, capacity: f.cap, fee: f.fee, info: f.info,
    });
    if (!r.ok) return setMsg(r.body.error || '저장에 실패했습니다.');
    reset(); load();
  };
  const edit = (t: T) => {
    setEditId(t.id);
    setF({ name: t.name, event: dt(t.eventAt), start: dt(t.applyStart), end: dt(t.applyEnd), cap: String(t.capacity), fee: t.fee ? String(t.fee) : '', info: t.info });
    formRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // 예정 대회는 가까운 순, 지난 대회는 최근 순으로 아래에 모아 보여 준다
  const upcoming = list.filter((t) => !t.ended).sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const past = list.filter((t) => t.ended).sort((a, b) => b.eventAt.localeCompare(a.eventAt));
  const ordered = [...upcoming, ...past];
  const open = list.find((t) => t.id === openId);

  return (
    <section>
      <Heading title="대회 관리" sub="접수 기간과 정원을 정하면 손님이 /tournament 페이지에서 신청합니다. 정원이 차면 대기로 받고, 자리가 나면 순서대로 입금 대기로 올라갑니다." />
      <Panel ref={formRef}>
        <form onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          <div className="flex gap-4 items-end flex-wrap">
            <Text fw={700} className="pb-[6px]">{editId ? '대회 수정' : '대회 등록'}</Text>
            <TextInput placeholder="대회명" maxLength={50} required {...set('name')} className="w-[200px]" />
            <TextInput label="대회" type="datetime-local" required {...set('event')} />
          </div>
          <div className="flex gap-4 items-end flex-wrap mt-3">
            <TextInput label="신청 시작" type="datetime-local" required {...set('start')} />
            <TextInput label="신청 종료" type="datetime-local" required {...set('end')} />
            <TextInput placeholder="정원" inputMode="numeric" required {...set('cap')} className="w-[80px]" />
            <TextInput placeholder="참가비(원)" inputMode="numeric" {...set('fee')} className="w-[110px]" />
          </div>
          <div className="flex gap-4 items-start flex-nowrap mt-3">
            <Textarea rows={7} placeholder="신청 안내 (입금 계좌, 주의사항 등. 손님 신청 화면에 그대로 표시됩니다)" maxLength={2000} className="flex-1" {...set('info')} />
            <Button type="submit">저장</Button>
            {editId && <Button variant="default" onClick={reset}>새 대회로</Button>}
          </div>
          <Msg>{msg}</Msg>
        </form>
      </Panel>
      <DataTable head={['대회', '대회일', '신청 기간', '신청 현황', '']}>
        {list.length ? ordered.map((t, i) => (
          <TRow key={t.id} t={t} divider={i === upcoming.length && past.length > 0} onEntries={() => setOpenId(t.id)} onEdit={() => edit(t)} />
        )) : <EmptyRow cols={5}>등록된 대회가 없습니다.</EmptyRow>}
      </DataTable>
      {open && <Entries key={open.id} t={open} onChanged={load} />}
    </section>
  );
}

function TRow({ t, divider, onEntries, onEdit }: { t: T; divider: boolean; onEntries: () => void; onEdit: () => void }) {
  return (
    <>
      {divider && <Table.Tr><Table.Td colSpan={5} c="dimmed" fz="xs" bg="var(--mantine-color-default-hover)">지난 대회</Table.Td></Table.Tr>}
      <Table.Tr style={t.ended ? { opacity: 0.6 } : undefined}>
        <Table.Td><Text fw={700}>{t.name}</Text>{t.fee ? <Meta>참가비 {t.fee.toLocaleString()}원</Meta> : null}</Table.Td>
        <Table.Td>{t.eventAt}</Table.Td>
        <Table.Td>{t.applyStart} ~ {t.applyEnd}<Meta>{t.ended ? '종료' : T_APPLY[t.apply]}</Meta></Table.Td>
        <Table.Td>{t.taken} / {t.capacity}명{t.waitlist ? ` · 대기 ${t.waitlist}` : ''}</Table.Td>
        <Actions><Button variant="default" size="xs" onClick={onEntries}>신청자</Button><Button variant="default" size="xs" onClick={onEdit}>수정</Button></Actions>
      </Table.Tr>
    </>
  );
}

function Entries({ t, onChanged }: { t: T; onChanged: () => void }) {
  const [rows, setRows] = useState<TE[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    const r = await fetch(`/api/admin/tournaments/${t.id}/entries`);
    if (r.ok) setRows((await r.json()).entries);
  };
  useLoad(load, [t.taken, t.waitlist]);

  const act = async (e: TE, kind: string) => {
    let body: Record<string, unknown> = {};
    if (kind === 'delete') {
      const v = await formDialog({ title: '신청 삭제', danger: true, confirmLabel: '삭제', fields: [
        { name: 'reason', label: '삭제 사유 (선택)' },
        { name: 'refundMemo', label: '환불 메모 (선택, 예: 환불 계좌 전달 완료)' },
      ] });
      if (!v) return;
      body = { reason: v.reason, refundMemo: v.refundMemo };
    }
    if (kind === 'memo') {
      const memo = await promptDialog('환불 메모', { value: e.refundMemo });
      if (memo === null) return;
      body = { memo };
    }
    setMsg('');
    const r = await post(`/api/admin/tournament-entries/${e.id}/${kind}`, body);
    if (!r.ok) setMsg(r.body.error || '처리에 실패했습니다.');
    await load(); onChanged();
  };
  const add = async () => {
    setMsg('');
    const r = await post(`/api/admin/tournaments/${t.id}/entries`, { name, phone });
    if (!r.ok) return setMsg(r.body.error || '등록에 실패했습니다.');
    setName(''); setPhone('');
    await load(); onChanged();
  };

  let n = 0;
  return (
    <Panel>
      <Title order={5} className="mb-3">{t.name} 신청자</Title>
      <form onSubmit={(ev) => { ev.preventDefault(); add(); }} className="mb-3">
        <div className="flex gap-4 items-end flex-wrap">
          <TextInput placeholder="이름" maxLength={20} required {...bind(name, setName)} className="w-[120px]" />
          <TextInput placeholder="전화" inputMode="numeric" required {...bind(phone, setPhone)} className="w-[150px]" />
          <Button type="submit">대리 신청</Button>
        </div>
      </form>
      <DataTable head={['#', '이름', '전화', '상태', '신청', '메모', '']} mb="xs">
        {rows.length ? rows.map((e) => {
          const del = e.status === 'DELETED';
          const num = del ? '' : ++n;
          const memo = del ? [e.deleteReason, e.refundMemo && '환불: ' + e.refundMemo].filter(Boolean).join(' / ') : '';
          return (
            <Table.Tr key={e.id} style={del ? { opacity: 0.55 } : undefined}>
              <Table.Td>{num}</Table.Td>
              <Table.Td><div className="flex gap-[6px] items-center flex-wrap"><Text fw={700}>{e.name}</Text>{e.manual && <Badge size="sm" variant="light" color="teal">대리</Badge>}</div></Table.Td>
              <Table.Td><Rv type="tournament" id={e.id} masked={e.phone} /></Table.Td>
              <Table.Td>{T_STATUS[e.status]}{e.paidAt && <Meta>입금 {e.paidAt.slice(5, 16)}</Meta>}</Table.Td>
              <Table.Td>{e.appliedAt.slice(5, 16)}</Table.Td><Table.Td>{memo}</Table.Td>
              <Actions>
                {e.status === 'PENDING' && <Button size="xs" onClick={() => act(e, 'confirm')}>입금 확인</Button>}
                {e.status === 'CONFIRMED' && <Button variant="default" size="xs" onClick={() => act(e, 'unconfirm')}>입금 취소</Button>}
                {!del ? <Button variant="light" color="red" size="xs" onClick={() => act(e, 'delete')}>삭제</Button> : <Button variant="default" size="xs" onClick={() => act(e, 'memo')}>환불 메모</Button>}
              </Actions>
            </Table.Tr>
          );
        }) : <EmptyRow cols={7}>신청자가 없습니다.</EmptyRow>}
      </DataTable>
      <Msg>{msg}</Msg>
    </Panel>
  );
}
