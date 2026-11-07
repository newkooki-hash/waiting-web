import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Badge, Button, Collapse, Paper, Table, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { LuCheck, LuChevronDown, LuChevronRight, LuHourglass, LuPlus, LuRefreshCw, LuUser } from 'react-icons/lu';
import { post } from '../lib/api';
import { formDialog, promptDialog } from '../lib/dialogs';
import { Actions, EmptyRow, Meta, Msg, Rv, bind } from './ui';
import type { QueueEntry } from './types';

// 대기 줄 격자: 넓은 화면은 6열, 1000px 이하는 메모 열을 접고, 760px 이하는 시간·전화도 이름 아래로 접는다
const GRID = 'grid items-center gap-[10px] px-4 grid-cols-[44px_minmax(0,1fr)_60px] min-[761px]:grid-cols-[56px_80px_minmax(150px,1.6fr)_70px_minmax(130px,1.2fr)] min-[1001px]:grid-cols-[72px_100px_minmax(170px,1.6fr)_90px_minmax(140px,1.2fr)_minmax(100px,1.4fr)] min-[1001px]:gap-3 min-[1001px]:px-6';
const BORDER = 'border-[var(--mantine-color-default-border)]';
const ICON_BOX = 'rounded-xl bg-white/20 grid place-items-center text-[22px] w-11 h-11';
const Sep = () => <span className={`w-px self-stretch mx-1.5 bg-[var(--mantine-color-default-border)]`} />;

const EMPTY = { name: '', phone: '', party: '', shoes: '', memo: '' };

export function Queue({ tick, onUnauthorized }: { tick: number; onUnauthorized: () => void }) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [visitMonths, setVisitMonths] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState(EMPTY);
  const [doneOpen, done_] = useDisclosure(false);

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/entries');
    if (r.status === 401) return onUnauthorized();
    const b = await r.json();
    setEntries(b.entries);
    setVisitMonths(b.visitMonths);
  }, [onUnauthorized]);
  useEffect(() => { load(); }, [load, tick]);

  const waitingList = entries.filter((e) => e.status !== 'ASSIGNED');
  const done = entries.filter((e) => e.status === 'ASSIGNED').reverse();
  const selected = waitingList.some((e) => e.id === selectedId) ? selectedId : null;
  const m = (k: keyof typeof EMPTY) => bind(manual[k], (v) => setManual({ ...manual, [k]: v }));

  const addManual = async (ev: FormEvent) => {
    ev.preventDefault();
    setMsg('');
    const r = await post('/api/admin/entries', { name: manual.name, phone: manual.phone, partySize: manual.party, shoes: manual.shoes, memo: manual.memo });
    if (!r.ok) return setMsg(r.body.error || '등록에 실패했습니다.');
    setManual(EMPTY);
    load();
  };

  // 버튼마다 필요한 값을 prompt로 묻고 서버에 보낸다
  const run = async (e: QueueEntry, act: string) => {
    let body: Record<string, unknown> = {};
    const memo0 = e.memo, party0 = String(e.partySize), shoes0 = e.shoes === null ? '' : String(e.shoes);
    if (act === 'assign') {
      const lanes = await promptDialog('배정할 레인 번호 (예: 5,6)', { required: true });
      if (!lanes) return;
      body = { lanes };
    }
    if (act === 'cancel') { // 사유는 비워도 된다
      const reason = await promptDialog('취소 사유를 입력하세요 (선택)');
      if (reason === null) return;
      body = { reason };
    }
    if (act === 'relane') {
      const lanes = await promptDialog('바꿀 레인 번호 (예: 5,6)', { value: e.lanes, required: true });
      if (!lanes) return;
      body = { lanes };
    }
    if (act === 'blacklist') {
      const reason = await promptDialog('블랙리스트 등록 사유 (필수)', { required: true, danger: true, message: '이 번호의 대기 중인 건은 취소됩니다.' });
      if (!reason) return;
      body = { reason };
    }
    if (act === 'edit') { // 배정 완료 표의 `수정`은 인원·신발·메모를 한 창에서 묻는다
      const v = await formDialog({ title: `${e.name} 수정`, fields: [
        { name: 'party', label: '인원 (1~8)', value: party0, required: true, inputMode: 'numeric' },
        { name: 'shoes', label: '신발 대여 인원 (비우면 미확인)', value: shoes0, inputMode: 'numeric' },
        { name: 'memo', label: '메모', value: memo0 },
      ] });
      if (!v) return;
      body = { partySize: v.party, shoes: v.shoes, memo: v.memo };
    }
    if (act === 'edit-party') { // 대기자 메뉴는 하나씩 묻는다
      const party = await promptDialog('인원 (1~8)', { value: party0, required: true, inputMode: 'numeric' });
      if (party === null) return;
      body = { partySize: party, memo: memo0 }; // 신발은 보내지 않으면 새 인원을 넘지 않게만 줄어든다
    }
    if (act === 'edit-shoes') {
      const shoes = await promptDialog(`신발 대여 인원 (0~${party0}, 0=대여 안함)`, { value: shoes0, inputMode: 'numeric' });
      if (shoes === null) return;
      body = { partySize: party0, shoes, memo: memo0 };
    }
    if (act === 'edit-memo') {
      const memo = await promptDialog('메모', { value: memo0 });
      if (memo === null) return;
      body = { partySize: party0, memo }; // 신발은 그대로
    }
    setMsg('');
    const r = await post(`/api/admin/entries/${e.id}/${act.startsWith('edit') ? 'edit' : act}`, body);
    if (!r.ok) setMsg(r.body.error || '처리에 실패했습니다.');
    load();
  };

  const toggle = (id: number) => setSelectedId(selected === id ? null : id);
  const onKey = (ev: KeyboardEvent, id: number) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); toggle(id); }
  };
  const shoesNote = (e: QueueEntry) => (e.shoes === null ? null : <Meta>신발 {e.shoes}</Meta>); // 신발 대여 인원(미확인이면 표시 안 함)
  const refreshIcon = <LuRefreshCw />;

  return (
    <section>
      {/* 배정완료목록 (접고 펼침) */}
      <Paper withBorder radius="lg" className="mb-4 overflow-hidden">
        <div className="flex gap-4 items-center justify-between flex-nowrap bg-[var(--mantine-color-blue-7)] text-[#fff] px-5 py-4">
          <UnstyledButton onClick={done_.toggle} aria-expanded={doneOpen} className="flex-1 text-inherit">
            <div className="flex gap-4 items-center flex-nowrap">
              <div className={ICON_BOX}><LuCheck /></div>
              <div>
                <div className="flex gap-[6px] items-center flex-wrap"><Text fw={700} fz="lg">배정완료목록</Text>
                  <LuChevronDown className={`opacity-70 transition-transform duration-150 ${doneOpen ? 'rotate-180' : ''}`} /></div>
                <Text fz="sm" opacity={0.8}>최근 배정 순 · {done.length}팀</Text>
              </div>
            </div>
          </UnstyledButton>
          <Button radius="xl" color="white" c="blue.7" leftSection={refreshIcon} onClick={load}>새로고침</Button>
        </div>
        <Collapse in={doneOpen}>
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="sm">
              <Table.Thead><Table.Tr>{['이름', '전화', '인원', '레인', '배정 시각', ''].map((h, i) => <Table.Th key={i} fz="xs" c="dimmed">{h}</Table.Th>)}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {done.length ? done.map((e) => (
                  <Table.Tr key={e.id}>
                    <Table.Td><Text fw={700}>{e.name}</Text>{e.memo && <Meta>{e.memo}</Meta>}</Table.Td>
                    <Table.Td><Rv type="entry" id={e.id} masked={e.phone} /></Table.Td>
                    <Table.Td>{e.partySize}명{shoesNote(e)}</Table.Td>
                    <Table.Td><Badge color="blue" variant="light" size="lg">{e.lanes}번</Badge></Table.Td>
                    <Table.Td>{(e.assignedAt || '').slice(11, 16)}</Table.Td>
                    <Actions>
                      <Button variant="default" size="xs" onClick={() => run(e, 'relane')}>레인 변경</Button>
                      <Button variant="default" size="xs" onClick={() => run(e, 'edit')}>수정</Button>
                      <Button variant="light" color="red" size="xs" onClick={() => run(e, 'cancel')}>배정 취소</Button>
                    </Actions>
                  </Table.Tr>
                )) : <EmptyRow cols={6}>오늘 배정한 팀이 없습니다.</EmptyRow>}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Collapse>
      </Paper>

      {/* 대기현황 */}
      <Paper withBorder radius="lg" className="overflow-hidden">
        <div className="flex gap-4 items-center flex-wrap bg-[var(--mantine-color-teal-7)] text-[#fff] px-5 py-4">
          <div className={ICON_BOX}><LuHourglass /></div>
          <div className="flex-1">
            <div className="flex gap-2 items-baseline flex-wrap"><Text fw={700} fz="lg">대기현황</Text><Text>{waitingList.length}팀</Text></div>
            <Text fz="sm" opacity={0.8}>레인 배정 대기 중인 고객 현황 · 총 {waitingList.reduce((s, e) => s + e.partySize, 0)}명</Text>
          </div>
          <Button radius="xl" color="white" c="teal.7" leftSection={<LuPlus />} onClick={() => setManualOpen(!manualOpen)}>추가</Button>
          <Button radius="xl" color="white" c="teal.7" leftSection={refreshIcon} onClick={load}>새로고침</Button>
        </div>
        {manualOpen && (
          <form onSubmit={addManual} className={`bg-[var(--mantine-color-teal-light)] p-4 border-b ${BORDER}`}>
            <div className="flex gap-4 items-end flex-wrap">
              <Text fw={700}>수기 등록</Text>
              <TextInput placeholder="이름" maxLength={20} required autoFocus {...m('name')} className="w-[120px]" />
              <TextInput placeholder="전화 (선택)" inputMode="numeric" {...m('phone')} className="w-[150px]" />
              <TextInput placeholder="인원" inputMode="numeric" required {...m('party')} className="w-[70px]" />
              <TextInput placeholder="신발 (선택)" inputMode="numeric" title="신발 대여 인원. 비워 두면 미확인" {...m('shoes')} className="w-[100px]" />
              <TextInput placeholder="메모 (선택)" maxLength={200} {...m('memo')} className="w-[180px]" />
              <Button type="submit">등록</Button>
            </div>
          </form>
        )}
        <div className={`${GRID} min-h-11 bg-[var(--mantine-color-default-hover)] text-[var(--mantine-color-dimmed)] font-bold text-[.95rem] max-[760px]:hidden`} aria-hidden="true"><span>번호</span><span>신청시간</span><span>이름</span><span>인원</span><span>전화번호</span><span className="max-[1000px]:hidden">메모</span></div>
        <div>
          {waitingList.length ? waitingList.map((e, i) => (
            <div key={e.id} className={`border-t ${BORDER} ${e.id === selected ? 'bg-[var(--mantine-color-teal-light)]' : ''} ${e.status === 'CALLED' ? 'shadow-[inset_4px_0_0_var(--mantine-color-orange-filled)]' : ''}`}>
              <div className={`${GRID} min-h-16 cursor-pointer hover:bg-[var(--mantine-color-default-hover)]`} tabIndex={0} role="button" aria-expanded={e.id === selected} onClick={() => toggle(e.id)} onKeyDown={(ev) => onKey(ev, e.id)}>
                <div><Badge circle size="xl" color={e.status === 'CALLED' ? 'orange' : 'teal'}>{i + 1}</Badge></div>
                <div className="font-mono max-[760px]:hidden">{e.createdAt.slice(11, 16)}</div>
                <div className="flex items-center gap-1.5 min-w-0 font-semibold"><LuChevronRight className={`shrink-0 transition-transform duration-150 ${e.id === selected ? 'rotate-90 text-[var(--mantine-color-teal-filled)]' : 'text-[var(--mantine-color-dimmed)]'}`} /><span className="flex flex-col min-w-0">
                  <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                    {e.name}
                    {e.status === 'CALLED' && <Badge color="orange" variant="light" size="sm">호출됨</Badge>}
                    {e.manual && <Badge color="teal" variant="light" size="sm">수기</Badge>}
                  </span>
                  {e.visits !== null && <Text fz="xs" c="dimmed" title={`최근 ${visitMonths}개월 동안 레인 배정을 받은 날 수`}>{visitMonths}개월 {e.visits ? e.visits + '회 방문' : '첫 방문'}</Text>}
                  <Text fz="xs" c="dimmed" className="hidden max-[760px]:block">{e.createdAt.slice(11, 16)}{e.phone && <> · <Rv type="entry" id={e.id} masked={e.phone} /></>}</Text>
                  {e.memo && <Text fz="xs" c="dimmed" className="hidden max-[1000px]:block">{e.memo}</Text>}
                </span></div>
                <div>{e.partySize}명{shoesNote(e)}</div>
                <div className="font-mono max-[760px]:hidden">{e.phone ? <Rv type="entry" id={e.id} masked={e.phone} /> : '—'}</div>
                <div className="max-[1000px]:hidden">{e.memo || '—'}</div>
              </div>
              {e.id === selected && (
                <div className={`flex flex-wrap items-center gap-2 px-4 min-[1001px]:px-6 py-3 border-t ${BORDER} bg-[var(--mantine-color-teal-light)]`}>
                  <div className="flex gap-1 items-center flex-wrap text-[var(--mantine-color-teal-8)] font-bold"><LuUser /> {e.name}</div><Sep />
                  {e.status === 'WAITING' && <Button color="orange" onClick={() => run(e, 'call')}>호출</Button>}
                  <Button color="teal" onClick={() => run(e, 'assign')}>레인배정</Button>
                  <Button variant="default" title="한 칸 뒤로" onClick={() => run(e, 'yield')}>양보하기</Button>
                  <Button variant="default" onClick={() => run(e, 'tail')}>맨뒤로보내기</Button>
                  <Button variant="default" onClick={() => run(e, 'cancel')}>대기취소</Button>
                  <Sep />
                  <Button variant="outline" color="blue" onClick={() => run(e, 'edit-party')}>인원수정</Button>
                  <Button variant="outline" color="blue" onClick={() => run(e, 'edit-shoes')}>신발수정</Button>
                  <Button variant="outline" color="blue" onClick={() => run(e, 'edit-memo')}>메모설정</Button>
                  <Sep />
                  <Button variant="outline" color="red" onClick={() => run(e, 'blacklist')}>블랙리스트</Button>
                </div>
              )}
            </div>
          )) : <Text ta="center" c="dimmed" className="py-10">대기 중인 팀이 없습니다. 손님이 QR로 접수하면 여기에 바로 나타납니다.</Text>}
        </div>
      </Paper>
      <Msg>{msg}</Msg>
    </section>
  );
}
