import { useState } from 'react';
import { Button, Group, Table, Text, TextInput } from '@mantine/core';
import { post } from '../lib/api';
import { Actions, DataTable, EmptyRow, Heading, Msg, Panel, Rv, bind, useLoad } from './ui';
import { confirmDialog } from '../lib/dialogs';

interface Item { id: number; name: string; phone: string; reason: string; createdAt: string }

export function Blacklist({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<Item[]>([]);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    const r = await fetch('/api/admin/blacklist');
    if (r.ok) setRows((await r.json()).entries);
  };
  useLoad(load);

  const add = async () => {
    setMsg('');
    const r = await post('/api/admin/blacklist', { phone, name, reason });
    if (!r.ok) return setMsg(r.body.error || '등록에 실패했습니다.');
    setPhone(''); setName(''); setReason('');
    load(); onChanged();
  };
  const remove = async (id: number) => {
    if (!await confirmDialog('블랙리스트에서 해제할까요?')) return;
    await post('/api/admin/blacklist/remove', { id });
    load();
  };

  return (
    <section>
      <Heading title="블랙리스트" sub="등록된 번호는 접수할 수 없습니다. 사유는 직원만 볼 수 있고 손님에게는 보이지 않습니다." />
      <Panel>
        <form onSubmit={(ev) => { ev.preventDefault(); add(); }}>
          <Group align="flex-end">
            <TextInput placeholder="전화" inputMode="numeric" required w={150} {...bind(phone, setPhone)} />
            <TextInput placeholder="이름 (선택)" maxLength={20} w={120} {...bind(name, setName)} />
            <TextInput placeholder="등록 사유" maxLength={200} required w={260} {...bind(reason, setReason)} />
            <Button type="submit">등록</Button>
          </Group>
        </form>
      </Panel>
      <DataTable head={['이름', '전화', '사유', '등록일', '']} mb="xs">
        {rows.length ? rows.map((b) => (
          <Table.Tr key={b.id}>
            <Table.Td><Text fw={700}>{b.name || ''}</Text></Table.Td><Table.Td><Rv type="blacklist" id={b.id} masked={b.phone} /></Table.Td><Table.Td>{b.reason}</Table.Td>
            <Table.Td>{b.createdAt.slice(0, 10)}</Table.Td>
            <Actions><Button variant="default" size="xs" onClick={() => remove(b.id)}>해제</Button></Actions>
          </Table.Tr>
        )) : <EmptyRow cols={5}>등록된 번호가 없습니다.</EmptyRow>}
      </DataTable>
      <Msg>{msg}</Msg>
    </section>
  );
}
