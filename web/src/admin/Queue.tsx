import { Fragment, useCallback, useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, Button, Collapse, Menu, Paper, Table, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { LuCheck, LuChevronDown, LuChevronRight, LuHourglass, LuPlus, LuRefreshCw, LuUser } from 'react-icons/lu';
import { post } from '../lib/api';
import { mmss, useCountdown } from '../lib/countdown';
import { confirmDialog, formDialog, promptDialog } from '../lib/dialogs';
import { Actions, EmptyRow, Meta, Msg, Rv, bind } from './ui';
import type { QueueEntry } from './types';

// 대기 줄 격자: 넓은 화면은 6열, 1000px 이하는 메모 열을 접고, 760px 이하는 시간·전화도 이름 아래로 접는다
const GRID = 'grid items-center gap-[10px] px-4 grid-cols-[44px_minmax(0,1fr)_60px] min-[761px]:grid-cols-[56px_80px_minmax(150px,1.6fr)_70px_minmax(130px,1.2fr)] min-[1001px]:grid-cols-[72px_100px_minmax(170px,1.6fr)_90px_minmax(140px,1.2fr)_minmax(100px,1.4fr)] min-[1001px]:gap-3 min-[1001px]:px-6';
const BORDER = 'border-[var(--mantine-color-default-border)]';
const ICON_BOX = 'rounded-xl border border-[var(--mantine-color-default-border)] grid place-items-center text-[22px] w-11 h-11';
// 상단 막대: 배경 없이 아래 선만, 글자는 진한 회색(어두운 화면에서는 밝은 회색)
const HEAD_TEXT = 'text-[light-dark(var(--mantine-color-dark-6),var(--mantine-color-gray-2))]';
const Sep = () => <span className={`w-px self-stretch mx-1.5 bg-[var(--mantine-color-default-border)]`} />;

/** 대기현황의 시간: 도착 확인을 받은 팀은 도착 시각(이 순서로 줄을 섬), 미도착(예비)은 접수 시각을 흐리게 */
const queueTime = (e: QueueEntry) => e.arrivedAt
  ? e.arrivedAt.slice(11, 16)
  : <span className="text-[var(--mantine-color-dimmed)]" title="접수 시각 (도착 확인 전)">{e.createdAt.slice(11, 16)}</span>;

/**
 * 표 칸 정렬 기준: 주 텍스트(이름·인원 등)는 항상 줄의 세로 중앙선에 맞춘다.
 * 보조 정보(신발 수, 방문 횟수 등)는 중앙선 아래에 따로 붙여서 주 텍스트의 높이에 영향을 주지 않는다.
 * 좁은 화면(760px 이하)에서는 보조 정보가 주 텍스트 아래로 이어져 쌓인다.
 */
function Cell({ children, sub, className = '' }: { children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`relative self-stretch flex flex-col justify-center min-[761px]:flex-row min-[761px]:justify-start min-[761px]:items-center ${className}`}>
      {children}
      {sub && <div className="min-[761px]:absolute min-[761px]:left-0 min-[761px]:top-[calc(50%+14px)] min-[761px]:whitespace-nowrap">{sub}</div>}
    </div>
  );
}

const EMPTY = { name: '', phone: '', party: '', shoes: '', memo: '' };

/** 미도착 배지: 접수 후 도착 제한(15분)까지 남은 시간을 센다. 0이 되면 잠시 뒤 다시 조회해 '도착 만료'로 옮긴다 */
function Unarrived({ left, onZero }: { left: number | null; onZero: () => void }) {
  const s = useCountdown(left, () => setTimeout(onZero, 1200));
  return <Badge color="gray" variant="outline" size="sm">미도착{s !== null && ' ' + mmss(s)}</Badge>;
}

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

  // 실제 대기(도착 확인을 받은 팀, 확인한 순서)가 위, 예비 대기(미도착)가 아래. 서버가 이 순서로 보내 준다
  const waitingList = entries.filter((e) => e.status === 'WAITING');
  const realCount = waitingList.filter((e) => e.arrivedAt).length;
  const expired = entries.filter((e) => e.status === 'EXPIRED');
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
    if (act === 'arrive' && e.status === 'EXPIRED' && !await confirmDialog(`${e.name}님의 대기를 복구할까요?\n도착 확인 처리되어 실제 대기의 맨 뒤로 들어갑니다.`, { confirmLabel: '복구' })) return;
    const memo0 = e.memo, party0 = String(e.partySize), shoes0 = e.shoes === null ? '' : String(e.shoes);
    if (act === 'assign') {
      const lanes = await promptDialog('배정할 레인 (예: 5, 5~6, 5.6)', { required: true });
      if (!lanes) return;
      body = { lanes };
    }
    if (act === 'cancel') { // 사유는 비워도 된다
      const reason = await promptDialog('취소 사유를 입력하세요 (선택)');
      if (reason === null) return;
      body = { reason };
    }
    if (act === 'relane') {
      const lanes = await promptDialog('바꿀 레인 (예: 5, 5~6, 5.6)', { value: e.lanes, required: true });
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
    if (act === 'edit-party') { // 인원과 신발 대여 인원을 한 창에서 −/+ 로 바꾼다(손님 접수 화면과 같은 방식)
      const v = await formDialog({ title: `${e.name} 인원수정`, message: e.shoes === null ? '신발 대여 인원이 비어 있어 인원과 같게 채웠습니다.' : undefined, fields: [
        { name: 'party', label: '인원 (최대 8명)', value: party0, stepper: { min: 1, max: 8, unit: '명' } },
        { name: 'shoes', label: '신발 대여 인원', value: e.shoes === null ? party0 : String(e.shoes), stepper: { min: 0, max: { field: 'party' }, unit: '명', zeroLabel: '대여 안함' } },
      ] });
      if (!v) return;
      body = { partySize: v.party, shoes: v.shoes, memo: memo0 };
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
  // 신발 대여 인원: 인원 아래에 배지로 항상 표시한다(미확인은 입력되지 않은 건)
  const shoesNote = (e: QueueEntry) => (
    <Badge size="sm" variant="light" color="gray">{e.shoes === null ? '신발 미확인' : e.shoes === 0 ? '신발 대여 안함' : `신발 ${e.shoes}켤레`}</Badge>
  );
  const refreshIcon = <LuRefreshCw />;

  return (
    <section>
      {/* 배정완료목록 (접고 펼침) */}
      <Paper withBorder radius="lg" className="mb-4 overflow-hidden">
        <div className={`flex gap-4 items-center justify-between flex-nowrap ${HEAD_TEXT} border-b ${BORDER} px-5 py-4`}>
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
          <Button radius="xl" variant="default" leftSection={refreshIcon} onClick={load}>새로고침</Button>
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
                    <Table.Td><Badge color="gray" variant="light" size="lg">{e.lanes}번</Badge></Table.Td>
                    <Table.Td>{(e.assignedAt || '').slice(11, 16)}</Table.Td>
                    <Actions>
                      <Button variant="default" size="xs" onClick={() => run(e, 'relane')}>레인 변경</Button>
                      <Button variant="default" size="xs" onClick={() => run(e, 'edit')}>수정</Button>
                      <Button variant="default" size="xs" onClick={() => run(e, 'cancel')}>배정 취소</Button>
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
        <div className={`flex gap-4 items-center flex-wrap ${HEAD_TEXT} border-b ${BORDER} px-5 py-4`}>
          <div className={ICON_BOX}><LuHourglass /></div>
          <div className="flex-1">
            <div className="flex gap-2 items-baseline flex-wrap"><Text fw={700} fz="lg">대기현황</Text><Text>{waitingList.length}팀</Text></div>
            <Text fz="sm" opacity={0.8}>레인 배정 대기 중인 고객 현황 · 총 {waitingList.reduce((s, e) => s + e.partySize, 0)}명</Text>
          </div>
          <Button radius="xl" variant="default" leftSection={<LuPlus />} onClick={() => setManualOpen(!manualOpen)}>추가</Button>
          <Button radius="xl" variant="default" leftSection={refreshIcon} onClick={load}>새로고침</Button>
        </div>
        {manualOpen && (
          <form onSubmit={addManual} className={`bg-[var(--mantine-color-default-hover)] p-4 border-b ${BORDER}`}>
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
        <div className={`${GRID} min-h-11 bg-[var(--mantine-color-default-hover)] text-[var(--mantine-color-dimmed)] font-bold text-[.95rem] max-[760px]:hidden`} aria-hidden="true"><span>번호</span><span>도착시간</span><span>이름</span><span>인원</span><span>전화번호</span><span className="max-[1000px]:hidden">메모</span></div>
        <div>
          {waitingList.length ? waitingList.map((e, i) => (
            <Fragment key={e.id}>
            {(i === 0 || i === realCount) && (
              <div className={`px-5 py-2 border-t ${BORDER} ${i < realCount ? 'bg-[var(--mantine-color-default-hover)]' : ''}`}>
                <Text fw={700} fz="sm">{i < realCount ? `실제 대기 ${realCount}팀` : `예비 대기 ${waitingList.length - realCount}팀`}<Text span c="dimmed" fz="xs"> · {i < realCount ? '카운터 도착 확인을 받은 순서' : '도착 확인 전. 확인을 받으면 실제 대기 맨 뒤로 들어갑니다'}</Text></Text>
              </div>
            )}
            <div className={`border-t ${BORDER} ${e.id === selected ? 'bg-[var(--mantine-color-default-hover)]' : ''}`}>
              <Menu opened={e.id === selected} onChange={(o) => { if (!o) setSelectedId(null); }} position="bottom-end" offset={4} width={200} shadow="md" withinPortal>
                <Menu.Target>
              <div className={`${GRID} min-h-[76px] cursor-pointer hover:bg-[var(--mantine-color-default-hover)]`} tabIndex={0} role="button" aria-expanded={e.id === selected} onClick={() => toggle(e.id)} onKeyDown={(ev) => onKey(ev, e.id)}>
                <div>{e.arrivedAt ? <Badge circle size="xl" color="dark">{i + 1}</Badge> : <Badge circle size="xl" color="gray" variant="outline" title="예비 대기(도착 확인 전)">{`예${i - realCount + 1}`}</Badge>}</div>
                <div className="font-mono max-[760px]:hidden">{queueTime(e)}</div>
                <Cell
                  sub={<div className="flex flex-col min-[761px]:pl-[22px]">
                    {e.visits !== null && <Text fz="xs" c="dimmed" title={`최근 ${visitMonths}개월 동안 레인 배정을 받은 날 수`}>{visitMonths}개월 {e.visits ? e.visits + '회 방문' : '첫 방문'}</Text>}
                    <Text fz="xs" c="dimmed" className="hidden max-[760px]:block">{queueTime(e)}{e.phone && <> · <Rv type="entry" id={e.id} masked={e.phone} /></>}</Text>
                    {e.memo && <Text fz="xs" c="dimmed" className="hidden max-[1000px]:block">{e.memo}</Text>}
                  </div>}
                >
                  <div className="flex items-center gap-1.5 min-w-0 font-semibold">
                    <LuChevronRight className={`shrink-0 transition-transform duration-150 ${e.id === selected ? 'rotate-90 text-[var(--mantine-color-text)]' : 'text-[var(--mantine-color-dimmed)]'}`} />
                    <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                      {e.name}
                      {e.manual && <Badge color="gray" variant="light" size="sm">수기</Badge>}
                      {!e.arrivedAt && <><Unarrived left={e.arrivalLeft} onZero={load} /><Button size="compact-xs" color="dark" onClick={(ev) => { ev.stopPropagation(); run(e, 'arrive'); }}>도착 확인</Button></>}
                    </span>
                  </div>
                </Cell>
                <Cell sub={shoesNote(e)}><span>{e.partySize}명</span></Cell>
                <div className="font-mono max-[760px]:hidden">{e.phone ? <Rv type="entry" id={e.id} masked={e.phone} /> : '—'}</div>
                <div className="max-[1000px]:hidden">{e.memo || '—'}</div>
              </div>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>{e.name}</Menu.Label>
                  {!e.arrivedAt && <Menu.Item onClick={() => run(e, 'arrive')}>도착 확인</Menu.Item>}
                  <Menu.Item onClick={() => run(e, 'assign')}>레인배정</Menu.Item>
                  <Menu.Item onClick={() => run(e, 'edit-party')}>인원수정</Menu.Item>
                  <Menu.Item onClick={() => run(e, 'edit-memo')}>메모설정</Menu.Item>
                  <Menu.Divider />
                  <Menu.Item onClick={() => run(e, 'yield')}>양보하기</Menu.Item>
                  <Menu.Item onClick={() => run(e, 'tail')}>맨뒤로보내기</Menu.Item>
                  <Menu.Item onClick={() => run(e, 'cancel')}>대기취소</Menu.Item>
                  <Menu.Divider />
                  <Menu.Item color="red" onClick={() => run(e, 'blacklist')}>블랙리스트</Menu.Item>
                </Menu.Dropdown>              </Menu>
            </div>
            </Fragment>
          )) : <Text ta="center" c="dimmed" className="py-10">대기 중인 팀이 없습니다. 손님이 접수하면 여기에 바로 나타납니다.</Text>}
        </div>
      </Paper>

      {/* 도착 만료: 접수 후 15분 안에 도착 확인을 하지 않은 오늘의 건. 매장에 와 있으면 도착 확인으로 되살린다 */}
      {expired.length > 0 && (
        <Paper withBorder radius="lg" className="mt-4 overflow-hidden">
          <div className="px-5 py-3 bg-[var(--mantine-color-default-hover)]"><Text fw={700}>도착 만료 {expired.length}팀 <Text span c="dimmed" fz="sm">· 최근 12시간, 접수 후 제한 시간 안에 도착 확인을 받지 못한 건</Text></Text></div>
          <div className={`${GRID} min-h-11 text-[var(--mantine-color-dimmed)] font-bold text-[.95rem] border-t ${BORDER} max-[760px]:hidden`} aria-hidden="true"><span>번호</span><span>접수시간</span><span>이름</span><span>인원</span><span>전화번호</span><span className="max-[1000px]:hidden">메모</span></div>
          {expired.map((e, i) => (
            <div key={e.id} className={`${GRID} min-h-[76px] border-t ${BORDER}`}>
              <div><Badge circle size="xl" color="gray" variant="light">{i + 1}</Badge></div>
              <div className="font-mono max-[760px]:hidden">{e.createdAt.slice(11, 16)}</div>
              <Cell
                sub={<div className="flex flex-col gap-1">
                  <Button color="dark" variant="light" size="compact-xs" onClick={() => run(e, 'arrive')}>도착 확인(대기 복구)</Button>
                  <Text fz="xs" c="dimmed" className="hidden max-[760px]:block">{e.createdAt.slice(11, 16)}{e.phone && <> · <Rv type="entry" id={e.id} masked={e.phone} /></>}</Text>
                  {e.memo && <Text fz="xs" c="dimmed" className="hidden max-[1000px]:block">{e.memo}</Text>}
                </div>}
              >
                <span className="flex items-center gap-1.5 font-semibold">
                  {e.name}
                  <Badge color="gray" variant="outline" size="sm">도착 만료</Badge>
                </span>
              </Cell>
              <Cell sub={shoesNote(e)}><span>{e.partySize}명</span></Cell>
              <div className="font-mono max-[760px]:hidden">{e.phone ? <Rv type="entry" id={e.id} masked={e.phone} /> : '—'}</div>
              <div className="max-[1000px]:hidden">{e.memo || '—'}</div>
            </div>
          ))}
        </Paper>
      )}
      <Msg>{msg}</Msg>
    </section>
  );
}
