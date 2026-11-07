import { useState } from 'react';
import { Button, Text, TextInput, Title } from '@mantine/core';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { DOW, post, shiftMonth, today } from '../lib/api';
import { Heading, Meta, Msg, Panel, bind, useLoad } from './ui';
import { confirmDialog } from '../lib/dialogs';

const DAY = 'min-h-14 min-[721px]:min-h-[76px] p-[3px] min-[721px]:p-1.5 text-left font-[inherit] text-inherit border rounded-lg overflow-hidden cursor-pointer';
const EV = 'block mt-0.5 px-1 text-[.72rem] min-[721px]:text-[.8rem] leading-[1.35] rounded bg-[var(--mantine-color-blue-light)] text-[var(--mantine-color-blue-light-color)] overflow-hidden text-ellipsis whitespace-nowrap';

interface Ev { id: number; date: string; title: string; memo: string }

export function CalendarView() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [day, setDay] = useState('');
  const [events, setEvents] = useState<Ev[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [memo, setMemo] = useState('');
  const [msg, setMsg] = useState('');

  const load = async (m = month) => {
    const r = await fetch('/api/admin/calendar?month=' + m);
    if (r.ok) setEvents((await r.json()).events);
  };
  useLoad(() => load(), [month]);

  const resetForm = () => { setEditId(null); setTitle(''); setMemo(''); };
  const go = (m: string, d: string) => { setMonth(m); setDay(d); resetForm(); };

  const [y, mo] = month.split('-').map(Number);
  const t = today();
  const first = new Date(y, mo - 1, 1), start = new Date(y, mo - 1, 1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i % 7 === 0 && i >= 35 && d.getMonth() !== mo - 1) break; // 마지막 줄이 다음 달뿐이면 생략
    const key = d.toLocaleDateString('sv');
    const evs = events.filter((e) => e.date === key);
    cells.push(
      <button key={key} className={`${DAY} ${key === day ? 'bg-[var(--mantine-color-blue-light)] border-[var(--mantine-color-blue-filled)]' : key === t ? 'bg-[var(--mantine-color-body)] border-[var(--mantine-color-blue-filled)]' : 'bg-[var(--mantine-color-body)] border-[var(--mantine-color-default-border)]'} ${d.getMonth() !== mo - 1 ? 'opacity-40' : ''}`}
        onClick={() => { setMsg(''); resetForm(); setDay(key); if (key.slice(0, 7) !== month) setMonth(key.slice(0, 7)); }}>
        <b className={`block text-[.95rem] ${d.getDay() === 0 ? 'text-[var(--mantine-color-red-filled)]' : ''}`}>{d.getDate()}</b>
        {evs.slice(0, 3).map((e) => <span className={EV} key={e.id}>{e.title}</span>)}
        {evs.length > 3 && <span className={EV}>+{evs.length - 3}</span>}
      </button>,
    );
  }

  const dayEvents = events.filter((e) => e.date === day);
  const save = async () => {
    setMsg('');
    const r = await post('/api/admin/calendar', { id: editId, date: day, title, memo });
    if (!r.ok) return setMsg(r.body.error || '저장에 실패했습니다.');
    resetForm(); load();
  };
  const remove = async (e: Ev) => {
    if (!await confirmDialog(`'${e.title}' 일정을 삭제할까요?`)) return;
    await post('/api/admin/calendar/remove', { id: e.id });
    resetForm(); load();
  };

  return (
    <section>
      <Heading title="행사 일정" sub="날짜를 눌러 그날의 행사·일정을 등록합니다. 손님은 대기 접수 화면의 `행사 일정`에서 볼 수 있습니다." />
      <div className="flex gap-4 items-center flex-wrap mb-3">
        <Button variant="default" aria-label="이전 달" leftSection={<LuChevronLeft />} onClick={() => go(shiftMonth(month, -1), '')}>이전</Button>
        <Text fw={700} ta="center" className="w-[110px]">{y}년 {mo}월</Text>
        <Button variant="default" aria-label="다음 달" rightSection={<LuChevronRight />} onClick={() => go(shiftMonth(month, 1), '')}>다음</Button>
        <Button variant="default" onClick={() => go(today().slice(0, 7), today())}>오늘</Button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {DOW.map((d) => <div className="text-center text-[.9rem] py-1 text-[var(--mantine-color-dimmed)]" key={d}>{d}</div>)}
        {cells}
      </div>
      <Panel className="mt-4">
        <Title order={5} className="mb-2.5">{day ? `${Number(day.slice(5, 7))}월 ${Number(day.slice(8))}일 일정` : '날짜를 선택하세요'}</Title>
        <div className="mb-3">
          {day && (dayEvents.length ? dayEvents.map((e) => (
            <div key={e.id} className="flex gap-4 items-center flex-nowrap py-1.5 border-b border-[var(--mantine-color-default-border)]">
              <div className="flex-1"><Text fw={700}>{e.title}</Text>{e.memo && <Meta>{e.memo}</Meta>}</div>
              <Button variant="default" size="xs" onClick={() => { setEditId(e.id); setTitle(e.title); setMemo(e.memo); }}>수정</Button>
              <Button variant="light" color="red" size="xs" onClick={() => remove(e)}>삭제</Button>
            </div>
          )) : <Meta>등록된 일정이 없습니다.</Meta>)}
        </div>
        {day && (
          <form onSubmit={(ev) => { ev.preventDefault(); save(); }}>
            <div className="flex gap-4 items-end flex-wrap">
              <TextInput placeholder="제목 (예: 챔프전 신청 마감)" maxLength={50} required {...bind(title, setTitle)} className="w-[240px]" />
              <TextInput placeholder="메모 (선택)" maxLength={500} className="flex-1 min-w-[200px]" {...bind(memo, setMemo)} />
              <Button type="submit">{editId ? '수정 저장' : '등록'}</Button>
              {editId && <Button variant="default" onClick={resetForm}>수정 취소</Button>}
            </div>
          </form>
        )}
        <Msg>{msg}</Msg>
      </Panel>
    </section>
  );
}
