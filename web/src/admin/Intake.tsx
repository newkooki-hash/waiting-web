import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Text, TextInput, Title } from '@mantine/core';
import { post } from '../lib/api';
import { Heading, Panel, bind } from './ui';
import type { Intake as IntakeInfo } from './types';
import { confirmDialog } from '../lib/dialogs';

export function Intake({ intake, reload }: { intake: IntakeInfo | null; reload: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [msg, setMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [saving, setSaving] = useState(false);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (!intake) return;
    setEnabled(intake.schedule.enabled); setStart(intake.schedule.start); setEnd(intake.schedule.end);
  }, [intake]);

  const qrHtml = useMemo(() => {
    if (!intake) return '';
    const q = qrcode(0, 'M'); q.addData(intake.url); q.make();
    return q.createImgTag(6, 0);
  }, [intake?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!intake) return <section />;

  const state = !intake.open ? '접수 중지' : intake.openNow ? '접수 중' : '접수 시간 외';

  const toggle = async () => {
    if (intake.open && !await confirmDialog('접수를 중지할까요? 손님이 새로 접수할 수 없게 됩니다.')) return;
    await post('/api/admin/intake/open', { open: !intake.open });
    reload();
  };
  const saveSched = async () => {
    setSaving(true); setMsg({ text: '저장 중…', color: 'dimmed' });
    const r = await post('/api/admin/intake/schedule', { enabled, start, end });
    setSaving(false);
    if (r.ok) {
      const s = r.body.schedule;
      setMsg({ color: 'green', text: s.enabled ? `저장되었습니다 (${s.start} ~ ${s.end})` : '저장되었습니다 (시간 제한 없음)' });
    } else setMsg({ color: 'red', text: r.body.error || '저장에 실패했습니다.' });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg({ text: '', color: '' }), 4000);
    reload();
  };
  const rotate = async () => {
    if (!await confirmDialog('QR을 새로 만들면 이전에 출력한 QR은 사용할 수 없습니다. 계속할까요?')) return;
    await post('/api/admin/intake/rotate');
    reload();
  };

  return (
    <section>
      <Heading title="QR 관리" sub="도착 인증용 QR입니다. 손님이 접수한 뒤 매장에서 스캔하면 대기가 '도착'으로 바뀝니다. 접수 후 10분 안에 스캔하지 않으면 '도착 만료'가 됩니다." />
      <div className="grid gap-4 grid-cols-1 min-[48em]:grid-cols-2">
        <Panel className="print:border-0 print:text-center">
          <div className="inline-block bg-white p-2.5 rounded-lg leading-none [&_img]:w-[220px] [&_img]:h-[220px] print:[&_img]:w-[340px] print:[&_img]:h-[340px]" dangerouslySetInnerHTML={{ __html: qrHtml }} />
          <div className="flex gap-4 items-center flex-wrap mt-3 print:hidden"><Button onClick={() => window.print()}>QR 인쇄</Button></div>
        </Panel>
        <div className="flex flex-col gap-0 print:hidden">
          <Panel>
            <Title order={5} className="mb-2.5">접수 상태</Title>
            <div className="flex gap-4 items-center flex-wrap">
              <Badge size="xl" variant="light" color={intake.openNow ? 'green' : 'red'}>{state}</Badge>
              <Button color={intake.open ? 'red' : undefined} variant={intake.open ? 'light' : 'filled'} onClick={toggle}>{intake.open ? '접수 중지하기' : '접수 시작하기'}</Button>
            </div>
            <Text c="dimmed" fz="sm" className="mt-2.5">접수를 중지해도 이미 대기 중인 손님은 유지됩니다.</Text>
          </Panel>
          <Panel>
            <Title order={5} className="mb-2.5">접수 가능 시간</Title>
            <div className="flex gap-4 items-end flex-wrap">
              <Checkbox label="시간 제한 사용" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
              <TextInput type="time" aria-label="시작" {...bind(start, setStart)} className="w-[130px]" />
              <Text className="pb-[6px]">~</Text>
              <TextInput type="time" aria-label="종료" {...bind(end, setEnd)} className="w-[130px]" />
              <Button loading={saving} onClick={saveSched}>저장</Button>
              <Text role="status" c={msg.color} className="pb-[6px]">{msg.text}</Text>
            </div>
            <Text c="dimmed" fz="sm" className="mt-2.5">종료가 시작보다 빠르면 자정을 넘기는 시간으로 봅니다 (예: 18:00~02:00). 시간대 밖에는 손님이 새로 접수할 수 없습니다.</Text>
          </Panel>
          <Panel>
            <Title order={5} className="mb-2.5">도착 인증 QR 관리</Title>
            <Button color="red" variant="light" onClick={rotate}>QR 새로 만들기</Button>
            <Text c="dimmed" fz="sm" className="mt-2.5">새로 만들면 이전에 출력한 QR은 사용할 수 없습니다. 인쇄물을 교체할 때만 누르세요.</Text>
            <Text c="dimmed" fz="xs" className="mt-2.5 break-all">{intake.url}</Text>
          </Panel>
        </div>
      </div>
    </section>
  );
}
