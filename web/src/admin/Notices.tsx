import { useState } from 'react';
import { Button, Checkbox, FileInput, Group, Image, Paper, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { post, today } from '../lib/api';
import { Actions, DataTable, EmptyRow, Heading, Meta, Msg, Panel, bind, useLoad } from './ui';
import { confirmDialog } from '../lib/dialogs';

interface Notice { id: number; date: string; title: string; body: string }
interface Banner { id: number }
interface Policy { type: string; title: string; body: string; version: number; consentVersion: number; updatedAt: string }

export function Notices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [nMsg, setNMsg] = useState('');
  const [bMsg, setBMsg] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadPolicies = async () => {
    const r = await fetch('/api/admin/policies');
    if (r.ok) setPolicies((await r.json()).policies);
  };
  const load = async () => {
    loadPolicies();
    const [n, b] = await Promise.all([fetch('/api/admin/notices'), fetch('/api/admin/banners')]);
    if (!n.ok || !b.ok) return;
    setNotices((await n.json()).notices);
    setBanners((await b.json()).banners);
  };
  useLoad(load);

  const resetForm = () => { setEditId(null); setDate(today()); setTitle(''); setBody(''); };
  const save = async () => {
    setNMsg('');
    const r = await post('/api/admin/notices', { id: editId, date, title, body });
    if (!r.ok) return setNMsg(r.body.error || '저장에 실패했습니다.');
    resetForm(); load();
  };
  const remove = async (n: Notice) => {
    if (!await confirmDialog(`'${n.title}' 공지를 삭제할까요?`)) return;
    await post('/api/admin/notices/remove', { id: n.id });
    load();
  };

  const upload = async () => {
    setBMsg('');
    if (!file) return setBMsg('이미지를 선택하세요.');
    if (file.size > 3 * 1024 * 1024) return setBMsg('이미지가 너무 큽니다. 3MB 이하로 올려 주세요.');
    const data = await new Promise<string>((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result as string); fr.readAsDataURL(file); });
    setUploading(true);
    const r = await post('/api/admin/banners', { data });
    setUploading(false);
    if (!r.ok) return setBMsg(r.body.error || '올리기에 실패했습니다.');
    setFile(null); load();
  };
  const bannerAct = async (id: number, kind: 'up' | 'down' | 'remove') => {
    if (kind === 'remove') { if (!await confirmDialog('이미지를 삭제할까요?')) return; await post('/api/admin/banners/remove', { id }); }
    else await post('/api/admin/banners/move', { id, dir: kind });
    load();
  };

  return (
    <section>
      <Heading title="공지·이벤트 이미지" sub="공지사항은 손님 화면의 `공지사항`에, 이벤트 이미지는 대기 접수 화면 맨 위에 표시됩니다." />
      <Panel>
        <Title order={5} mb="sm">공지사항</Title>
        <form onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          <Group align="flex-start" mb="sm" wrap="wrap">
            <TextInput type="date" aria-label="날짜" required {...bind(date, setDate)} />
            <TextInput placeholder="제목" maxLength={100} required w={240} {...bind(title, setTitle)} />
            <Textarea rows={4} placeholder="내용" maxLength={5000} style={{ flex: 1, minWidth: 240 }} {...bind(body, setBody)} />
            <Button type="submit">{editId ? '수정 저장' : '등록'}</Button>
            {editId && <Button variant="default" onClick={resetForm}>수정 취소</Button>}
          </Group>
        </form>
        <Msg>{nMsg}</Msg>
        <DataTable head={['날짜', '제목', '']} mb="0">
          {notices.length ? notices.map((x) => (
            <Table.Tr key={x.id}>
              <Table.Td>{x.date}</Table.Td>
              <Table.Td><Text fw={700}>{x.title}</Text>{x.body && <Meta>{x.body.slice(0, 80)}{x.body.length > 80 ? '…' : ''}</Meta>}</Table.Td>
              <Actions>
                <Button variant="default" size="xs" onClick={() => { setEditId(x.id); setDate(x.date); setTitle(x.title); setBody(x.body); }}>수정</Button>
                <Button variant="light" color="red" size="xs" onClick={() => remove(x)}>삭제</Button>
              </Actions>
            </Table.Tr>
          )) : <EmptyRow cols={3}>등록된 공지사항이 없습니다.</EmptyRow>}
        </DataTable>
      </Panel>
      <Panel>
        <Title order={5} mb="sm">이벤트 이미지</Title>
        <Group align="center">
          <FileInput placeholder="이미지 선택" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="이미지 파일" clearable value={file} onChange={setFile} />
          <Button loading={uploading} onClick={upload}>올리기</Button>
          <Text c="dimmed" fz="sm">PNG·JPG·GIF·WEBP, 3MB 이하, 최대 30개. 위에서부터 순서대로 보입니다.</Text>
        </Group>
        <Msg>{bMsg}</Msg>
        <Stack gap="xs" mt="sm">
          {banners.length ? banners.map((x, i) => (
            <Paper withBorder radius="md" p="xs" key={x.id}>
              <Group wrap="nowrap">
                <Image src={`/api/admin/banner-image?id=${x.id}`} alt={`이벤트 이미지 ${i + 1}`} w={160} mah={90} fit="cover" radius="sm" />
                <Text style={{ flex: 1 }}>#{i + 1}</Text>
                <Button variant="default" size="xs" disabled={i === 0} onClick={() => bannerAct(x.id, 'up')}>위로</Button>
                <Button variant="default" size="xs" disabled={i === banners.length - 1} onClick={() => bannerAct(x.id, 'down')}>아래로</Button>
                <Button variant="light" color="red" size="xs" onClick={() => bannerAct(x.id, 'remove')}>삭제</Button>
              </Group>
            </Paper>
          )) : <Meta>등록된 이미지가 없습니다.</Meta>}
        </Stack>
      </Panel>
      <Panel>
        <Title order={5} mb="xs">이용약관·개인정보처리방침</Title>
        <Text c="dimmed" fz="sm" mb="sm">손님은 로그인한 뒤 첫 이용 때 동의합니다. 내용이 비어 있는 약관은 동의를 요구하지 않습니다. 이용약관 같은 일반 개정은 공지로 알리고, 수집 항목을 늘리거나 이용 목적을 바꾸는 중요한 변경만 <b>재동의 필요</b>를 체크해 모든 회원이 다시 동의하게 하세요.</Text>
        <PolicyBoxes policies={policies} reload={loadPolicies} />
      </Panel>
    </section>
  );
}

function PolicyBoxes({ policies, reload }: { policies: Policy[]; reload: () => void }) {
  const [msg, setMsg] = useState<{ text: string; ok: boolean }>({ text: '', ok: false });
  return (
    <div>
      {policies.map((p) => <PolicyBox key={p.type + p.version} p={p} onResult={(text, ok) => { setMsg({ text, ok }); if (ok) reload(); }} />)}
      <Msg ok={msg.ok}>{msg.text}</Msg>
    </div>
  );
}

function PolicyBox({ p, onResult }: { p: Policy; onResult: (text: string, ok: boolean) => void }) {
  const [body, setBody] = useState(p.body);
  const [reconsent, setReconsent] = useState(false);
  const [notify, setNotify] = useState(true);
  const [summary, setSummary] = useState('');

  const save = async () => {
    if (!await confirmDialog(reconsent ? '저장하면 모든 회원이 다시 동의해야 접수할 수 있습니다. 저장할까요?' : '저장할까요? 개정 내용은 공지로 안내되고, 회원은 다시 동의하지 않아도 됩니다.')) return;
    onResult('', false);
    const r = await post('/api/admin/policies', { type: p.type, body, reconsent, notify, summary });
    if (!r.ok) return onResult(r.body.error || '저장에 실패했습니다.', false);
    onResult(!r.body.changed ? '변경된 내용이 없습니다.' : r.body.reconsent ? '저장되었습니다. 모든 회원에게 다시 동의를 받습니다.' : '저장되었습니다. 회원은 다시 동의하지 않아도 됩니다.', true);
  };

  return (
    <Stack gap="xs" mb="lg">
      <Group>
        <Text fw={700}>{p.title}</Text>
        <Text c="dimmed" fz="xs">
          {p.version ? `버전 ${p.version} · 수정 ${(p.updatedAt || '').slice(0, 16)}${p.consentVersion < p.version ? ` · 동의 기준 버전 ${p.consentVersion}` : ''}` : '아직 등록되지 않음 (동의를 요구하지 않음)'}
        </Text>
        <a href={`/${p.type}`} target="_blank" rel="noopener">손님 화면 보기</a>
      </Group>
      <Textarea rows={8} {...bind(body, setBody)} />
      <Group>
        <Checkbox label="재동의 필요 (수집 항목·이용 목적 변경 등)" checked={reconsent} onChange={(e) => setReconsent(e.currentTarget.checked)} />
        <Checkbox label="공지사항에 개정 안내 올리기" checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />
      </Group>
      <TextInput placeholder="개정 내용 요약 (공지에 표시, 선택)" maxLength={1000} {...bind(summary, setSummary)} />
      <div><Button onClick={save}>저장</Button></div>
    </Stack>
  );
}
