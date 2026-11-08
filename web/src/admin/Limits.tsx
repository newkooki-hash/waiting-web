import { useState } from 'react';
import { Badge, Button, Table, Text } from '@mantine/core';
import { post } from '../lib/api';
import { Actions, DataTable, EmptyRow, Heading, Meta, Panel, Rv, useLoad } from './ui';
import { confirmDialog } from '../lib/dialogs';

interface Limit { id: number; phone: string; startsAt: string; endsAt: string; releasedAt: string | null; active: boolean }
interface Expired { id: number; name: string; phone: string; expiredAt: string; excluded: boolean; count: number }
interface Log { at: string; phone: string; action: string; entryId: number | null }
interface Data { enforce: boolean; rule: { count: number; days: number; banDays: number }; limits: Limit[]; expired: Expired[]; log: Log[] }

const ACTION: Record<string, string> = { limit: '제한 시작', release: '제한 해제', reset: '횟수 초기화', exclude: '오처리 제외', include: '제외 취소' };

export function Limits() {
  const [d, setD] = useState<Data | null>(null);
  const load = async () => {
    const r = await fetch('/api/admin/limits');
    if (r.ok) setD(await r.json());
  };
  useLoad(load);
  if (!d) return null;

  const act = async (url: string, body: object, ask?: string) => {
    if (ask && !await confirmDialog(ask)) return;
    await post(url, body);
    load();
  };

  return (
    <section>
      <Heading title="접수 제한" sub={`최근 ${d.rule.days}일 안에 도착 만료가 ${d.rule.count}회가 되면 ${d.rule.banDays}일간 접수가 제한됩니다. 본인·직원 취소는 세지 않고, 도착 확인으로 복구한 건은 자동으로 빠집니다.`} />
      {!d.enforce && (
        <Panel>
          <Text fw={700}>베타 기간: 집계만 하고 접수는 막지 않습니다.</Text>
          <Meta>아래 제한 대상은 시행했다면 막혔을 번호입니다. 실제 도착 만료 비율과 오처리를 확인한 뒤 서버 설정 NOSHOW_ENFORCE=1 로 시행합니다.</Meta>
        </Panel>
      )}
      <DataTable head={['전화', '시작', '해제 예정', '상태', '']} mb="md">
        {d.limits.length ? d.limits.map((l) => (
          <Table.Tr key={l.id}>
            <Table.Td><Rv type="limit" id={l.id} masked={l.phone} /></Table.Td>
            <Table.Td>{l.startsAt.slice(0, 16)}</Table.Td>
            <Table.Td>{l.endsAt.slice(0, 10)}</Table.Td>
            <Table.Td>{l.releasedAt ? <Badge color="gray">해제됨 {l.releasedAt.slice(5, 16)}</Badge> : l.active ? <Badge color={d.enforce ? 'red' : 'orange'}>{d.enforce ? '제한 중' : '제한 대상(미시행)'}</Badge> : <Badge color="gray">종료</Badge>}</Table.Td>
            <Actions>{l.active && <Button variant="default" size="xs" onClick={() => act('/api/admin/limits/release', { id: l.id }, '제한을 해제할까요?')}>즉시 해제</Button>}</Actions>
          </Table.Tr>
        )) : <EmptyRow cols={5}>제한 대상이 없습니다.</EmptyRow>}
      </DataTable>

      <Heading title="최근 도착 만료" sub="매장에 와 있었는데 확인이 늦어 만료된 건은 `오처리 제외`로 집계에서 뺍니다." />
      <DataTable head={['만료 시각', '이름', '전화', '누적', '']} mb="md">
        {d.expired.length ? d.expired.map((e) => (
          <Table.Tr key={e.id} c={e.excluded ? 'dimmed' : undefined}>
            <Table.Td>{e.expiredAt.slice(0, 16)}</Table.Td>
            <Table.Td><Text fw={700} span>{e.name}</Text></Table.Td>
            <Table.Td><Rv type="entry" id={e.id} masked={e.phone} /></Table.Td>
            <Table.Td>{e.excluded ? <Badge color="gray">제외됨</Badge> : `${e.count}회`}</Table.Td>
            <Actions>
              <Button variant="default" size="xs" onClick={() => act('/api/admin/limits/exclude', { entryId: e.id, excluded: !e.excluded })}>{e.excluded ? '제외 취소' : '오처리 제외'}</Button>
              <Button variant="default" size="xs" onClick={() => act('/api/admin/limits/reset', { entryId: e.id }, '이 번호의 횟수를 0으로 초기화할까요? 진행 중인 제한도 해제됩니다.')}>횟수 초기화</Button>
            </Actions>
          </Table.Tr>
        )) : <EmptyRow cols={5}>최근 도착 만료 건이 없습니다.</EmptyRow>}
      </DataTable>

      <Heading title="이력" />
      <DataTable head={['시각', '전화', '내용']} mb="xs">
        {d.log.length ? d.log.map((l, i) => (
          <Table.Tr key={i}><Table.Td>{l.at.slice(0, 16)}</Table.Td><Table.Td>{l.phone}</Table.Td><Table.Td>{ACTION[l.action] || l.action}</Table.Td></Table.Tr>
        )) : <EmptyRow cols={3}>이력이 없습니다.</EmptyRow>}
      </DataTable>
    </section>
  );
}
