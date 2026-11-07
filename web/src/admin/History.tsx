import { useState } from 'react';
import { Badge, Button, Table, Text, TextInput } from '@mantine/core';
import { today } from '../lib/api';
import { DataTable, EmptyRow, Heading, Panel, Rv, STATUS, STATUS_COLOR, bind, useLoad } from './ui';

interface Row {
  id: number; createdAt: string; name: string; phone: string; partySize: number; shoes: number | '';
  status: string; lanes: string; waitMin: number | ''; manual: boolean; memo: string; cancelReason: string;
}

export function History() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [q, setQ] = useState('');
  const [lane, setLane] = useState('');
  const [rows, setRows] = useState<Row[]>([]);

  const query = () => new URLSearchParams({ from, to: to || from, q, lane });
  const load = async () => {
    const r = await fetch('/api/admin/history?' + query());
    if (!r.ok) return;
    setRows((await r.json()).entries);
  };
  useLoad(load);

  return (
    <section>
      <Heading title="이력 조회" sub="접수일 기준으로 찾습니다. 취소·종료된 건도 포함됩니다." />
      <Panel>
        <form onSubmit={(ev) => { ev.preventDefault(); load(); }}>
          <div className="flex gap-4 items-end flex-wrap">
            <TextInput type="date" aria-label="시작일" {...bind(from, setFrom)} />
            <Text className="pb-[6px]">~</Text>
            <TextInput type="date" aria-label="종료일" {...bind(to, setTo)} />
            <TextInput placeholder="이름 또는 전화" {...bind(q, setQ)} className="w-[150px]" />
            <TextInput placeholder="레인" inputMode="numeric" {...bind(lane, setLane)} className="w-[80px]" />
            <Button type="submit">조회</Button>
            <Button variant="default" onClick={() => { location.href = '/api/admin/history?format=csv&' + query(); }}>엑셀(CSV) 내려받기</Button>
          </div>
        </form>
      </Panel>
      <DataTable head={['접수', '이름', '전화', '인원', '신발', '상태', '레인', '대기', '경로', '메모·사유']} mb="xs">
        {rows.length ? rows.map((e) => (
          <Table.Tr key={e.id}>
            <Table.Td>{e.createdAt.slice(5, 16)}</Table.Td><Table.Td><Text fw={700}>{e.name}</Text></Table.Td>
            <Table.Td><Rv type="entry" id={e.id} masked={e.phone} /></Table.Td>
            <Table.Td>{e.partySize}명</Table.Td><Table.Td>{e.shoes === '' ? '-' : e.shoes}</Table.Td>
            <Table.Td><Badge variant="light" color={STATUS_COLOR[e.status]}>{STATUS[e.status]}</Badge></Table.Td>
            <Table.Td>{e.lanes}</Table.Td><Table.Td>{e.waitMin === '' ? '' : e.waitMin + '분'}</Table.Td>
            <Table.Td>{e.manual ? '수기' : 'QR'}</Table.Td>
            <Table.Td>{[e.memo, e.cancelReason && '취소: ' + e.cancelReason].filter(Boolean).join(' / ')}</Table.Td>
          </Table.Tr>
        )) : <EmptyRow cols={10}>조건에 맞는 이력이 없습니다.</EmptyRow>}
      </DataTable>
      <Text c="dimmed" fz="sm">{rows.length}건{rows.length >= 2000 ? ' (최대 2000건까지 표시)' : ''}</Text>
    </section>
  );
}
