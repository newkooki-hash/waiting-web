import { useState } from 'react';
import { Badge, Button, FileInput, Modal, Table, Text, TextInput } from '@mantine/core';
import { post } from '../lib/api';
import { Actions, DataTable, EmptyRow, Heading, Meta, Panel, Rv, bind, useLoad } from './ui';
import { confirmDialog, alertDialog } from '../lib/dialogs';

interface Member {
  id: number; name: string; age: number | null; gender: string; phone: string; email: string;
  joinedAt: string; lastUsedAt: string; source: string; linked: boolean; tier: string;
}
interface LogRow { changedAt: string; field: string; oldValue: string | null; newValue: string | null; changedBy: string }
interface ImportResult { error?: string; total: number; imported: number; duplicate: number; errors: { line: number; reason: string; row: string[] }[] }

export function Members() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [last, setLast] = useState(1);
  const [liftPhone, setLiftPhone] = useState('');
  const [lift, setLift] = useState<{ ok: boolean; text: string }>({ ok: true, text: '' });
  const [report, setReport] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [log, setLog] = useState<LogRow[] | null>(null);

  const load = async (p = page, query = q) => {
    const r = await fetch('/api/admin/members?' + new URLSearchParams({ q: query, page: String(p) }));
    if (!r.ok) return;
    const b = await r.json();
    setRows(b.entries); setTotal(b.total); setLast(Math.max(1, Math.ceil(b.total / b.size)));
  };
  useLoad(() => load());
  const go = (p: number) => { setPage(p); load(p); };

  const doLift = async () => {
    const r = await post('/api/admin/withdrawals/lift', { phone: liftPhone });
    setLift({ ok: r.ok, text: r.ok ? '해제되었습니다.' : r.body.error || '해제에 실패했습니다.' });
    if (r.ok) setLiftPhone('');
  };

  const importCsv = async () => {
    if (!file) return alertDialog('가져올 CSV 파일을 선택하세요.');
    const csv = await file.text();
    setImporting(true);
    const r = await post('/api/admin/members/import', { csv });
    setImporting(false);
    if (!r.ok) return setReport({ error: r.body.error || '가져오기에 실패했습니다.', total: 0, imported: 0, duplicate: 0, errors: [] });
    setReport(r.body);
    setFile(null);
    go(1);
  };
  const downloadErrors = (errors: ImportResult['errors']) => {
    const cell = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const text = '﻿' + [['줄', '사유', '원본'], ...errors.map((e) => [e.line, e.reason, e.row.join(' | ')])].map((x) => x.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = 'member_import_errors.csv'; a.click();
  };

  const showLog = async (m: Member) => {
    const b = await (await fetch('/api/admin/members/log?id=' + m.id)).json();
    setLog(b.entries);
  };
  const remove = async (m: Member) => {
    if (!await confirmDialog(`'${m.name}' 회원을 삭제할까요?\n회원 정보가 지워지고 접수·대회 기록은 이름과 연락처가 지워진 채 통계용으로만 남습니다. 되돌릴 수 없습니다.`)) return;
    const r = await post('/api/admin/members/delete', { id: m.id });
    if (!r.ok) await alertDialog(r.body.error || '삭제에 실패했습니다.');
    load();
  };
  const setTier = async (m: Member) => {
    const to = m.tier === '정회원' ? '일반' : '정회원';
    if (!await confirmDialog(to === '정회원' ? '본인 확인을 마친 회원을 정회원으로 지정할까요? 정회원은 대회에 신청할 수 있습니다.' : '일반회원으로 되돌릴까요?')) return;
    await post('/api/admin/members/tier', { id: m.id, tier: to });
    load();
  };

  return (
    <section>
      <Heading title="회원관리" sub="연락처와 이메일은 일부만 표시됩니다. 원문은 비밀번호를 다시 입력해야 볼 수 있고, 조회 기록이 남습니다." />
      <Panel>
        <form onSubmit={(ev) => { ev.preventDefault(); go(1); }}>
          <div className="flex gap-4 items-end flex-wrap">
            <TextInput placeholder="이름·연락처·이메일 검색" {...bind(q, setQ)} className="w-[240px]" />
            <Button type="submit">검색</Button>
            <span className="flex-1"></span>
            <FileInput placeholder="CSV 파일 선택" accept=".csv,text/csv" aria-label="가져올 CSV 파일" clearable value={file} onChange={setFile} />
            <Button variant="default" loading={importing} onClick={importCsv}>CSV 가져오기</Button>
          </div>
        </form>
      </Panel>
      <Panel>
        <form onSubmit={(ev) => { ev.preventDefault(); doLift(); }}>
          <div className="flex gap-4 items-end flex-wrap">
            <Text fw={700} className="pb-[6px]">재가입 제한 해제</Text>
            <TextInput placeholder="탈퇴한 번호" inputMode="numeric" required {...bind(liftPhone, setLiftPhone)} className="w-[150px]" />
            <Button type="submit" variant="default">해제</Button>
            <Text c="dimmed" fz="sm" className="pb-[6px]">탈퇴한 번호는 일정 기간 다시 가입할 수 없습니다.</Text>
            <Text role="status" c={lift.ok ? 'green' : 'red'} className="pb-[6px]">{lift.text}</Text>
          </div>
        </form>
      </Panel>
      {report && (
        <Panel>
          {report.error ? <Text c="red">{report.error}</Text> : (
            <div className="flex gap-4 items-center flex-wrap">
              <Text><b>가져오기 결과</b> 전체 {report.total}건 · 추가 {report.imported}건 · 중복 건너뜀 {report.duplicate}건 · 오류 {report.errors.length}건</Text>
              {report.errors.length > 0 && <Button variant="default" size="xs" onClick={() => downloadErrors(report.errors)}>오류 행 내려받기</Button>}
            </div>
          )}
        </Panel>
      )}
      <DataTable head={['이름', '나이', '성별', '연락처', '이메일', '가입일', '마지막 이용', '구분', '']} mb="xs">
        {rows.length ? rows.map((m) => (
          <Table.Tr key={m.id}>
            <Table.Td><Text fw={700}>{m.name}</Text></Table.Td><Table.Td>{m.age ?? ''}</Table.Td><Table.Td>{m.gender}</Table.Td>
            <Table.Td><Rv type="member" id={m.id} masked={m.phone} /></Table.Td><Table.Td>{m.email}</Table.Td><Table.Td>{m.joinedAt}</Table.Td><Table.Td>{m.lastUsedAt || '-'}</Table.Td>
            <Table.Td>{m.source}{m.linked ? ' · 연결' : ''}<div><Badge size="sm" variant="light" color={m.tier === '정회원' ? 'teal' : 'gray'}>{m.tier}</Badge></div></Table.Td>
            <Actions>
              <Button variant="light" color="red" size="xs" onClick={() => remove(m)}>삭제</Button>
              <Button variant="default" size="xs" onClick={() => showLog(m)}>이력</Button>
              <Button variant="default" size="xs" onClick={() => setTier(m)}>{m.tier === '정회원' ? '일반으로' : '정회원 지정'}</Button>
            </Actions>
          </Table.Tr>
        )) : <EmptyRow cols={9}>회원이 없습니다. CSV로 가져오거나 손님이 번호 인증을 하면 추가됩니다.</EmptyRow>}
      </DataTable>
      <div className="flex gap-4 items-center flex-wrap">
        <Button variant="default" disabled={page <= 1} onClick={() => go(page - 1)}>이전</Button>
        <Text role="status">{page} / {last}쪽 · 총 {total}명</Text>
        <Button variant="default" disabled={page >= last} onClick={() => go(page + 1)}>다음</Button>
      </div>
      <Modal opened={log !== null} onClose={() => setLog(null)} title="변경 이력" centered size="lg">
        {log && (log.length ? (
          <Table verticalSpacing="xs">
            <Table.Tbody>
              {log.map((e, i) => (
                <Table.Tr key={i}><Table.Td>{e.changedAt.slice(0, 16)}</Table.Td><Table.Td>{e.field}</Table.Td><Table.Td>{e.oldValue ?? '없음'} → {e.newValue ?? '없음'}</Table.Td><Table.Td>{e.changedBy}</Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : <Meta>기록이 없습니다.</Meta>)}
        <div className="flex gap-4 items-center justify-end flex-wrap mt-4"><Button variant="default" onClick={() => setLog(null)}>닫기</Button></div>
      </Modal>
    </section>
  );
}
