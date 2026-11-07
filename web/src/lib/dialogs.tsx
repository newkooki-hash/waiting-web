import { useEffect, useState, type FormEvent } from 'react';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';

/**
 * confirm / prompt / alert 를 대신하는 모달. 브라우저 기본 창처럼 await로 결과를 받는다.
 * <DialogHost />가 화면에 한 번 올라가 있어야 한다(mountApp이 넣어 준다).
 */
export interface Field {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  inputMode?: 'numeric' | 'text';
}

interface Request {
  kind: 'form' | 'confirm' | 'alert';
  title?: string;
  message?: string;
  fields?: Field[];
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: Record<string, string> | boolean | null) => void;
}

let push: ((r: Request) => void) | null = null;
const ask = <T,>(r: Omit<Request, 'resolve'>) => new Promise<T>((resolve) => {
  if (!push) throw new Error('DialogHost가 없습니다');
  push({ ...r, resolve: resolve as Request['resolve'] });
});

/** 값을 입력받는다. 취소하면 null */
export const formDialog = (o: { title: string; message?: string; fields: Field[]; confirmLabel?: string; danger?: boolean }) =>
  ask<Record<string, string> | null>({ kind: 'form', ...o });

/** 한 줄 입력. 취소하면 null */
export async function promptDialog(title: string, o: { value?: string; required?: boolean; message?: string; inputMode?: 'numeric' | 'text'; danger?: boolean } = {}) {
  const r = await formDialog({ title, message: o.message, danger: o.danger, fields: [{ name: 'v', label: title, value: o.value, required: o.required, inputMode: o.inputMode }] });
  return r ? r.v : null;
}

export const confirmDialog = (message: string, o: { confirmLabel?: string; danger?: boolean } = {}) =>
  ask<boolean>({ kind: 'confirm', message, ...o });

export const alertDialog = (message: string) => ask<void>({ kind: 'alert', message });

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const cur = queue[0];

  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    return () => { push = null; };
  }, []);
  useEffect(() => {
    setValues(Object.fromEntries((cur?.fields ?? []).map((f) => [f.name, f.value ?? ''])));
  }, [cur]);

  const done = (v: Record<string, string> | boolean | null) => {
    cur.resolve(v);
    setQueue((q) => q.slice(1));
  };
  const cancel = () => done(cur.kind === 'confirm' ? false : null);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    done(cur.kind === 'form' ? values : true);
  };

  const title = cur?.title ?? (cur?.kind === 'alert' ? '알림' : cur?.kind === 'confirm' ? '확인' : '');
  return (
    <Modal opened={!!cur} onClose={cancel} title={title} centered closeOnClickOutside={cur?.kind !== 'form'} withCloseButton={false} zIndex={1000}>
      {cur && (
        <form onSubmit={submit}>
          <Stack gap="sm">
            {cur.message && <Text style={{ whiteSpace: 'pre-line' }}>{cur.message}</Text>}
            {cur.fields?.map((f, i) => (
              <TextInput key={f.name} label={cur.fields!.length > 1 || cur.title !== f.label ? f.label : undefined} aria-label={f.label} placeholder={f.placeholder}
                required={f.required} inputMode={f.inputMode} data-autofocus={i === 0 ? true : undefined}
                value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.currentTarget.value })} />
            ))}
            <Group justify="flex-end">
              {cur.kind !== 'alert' && <Button variant="default" type="button" onClick={cancel}>취소</Button>}
              <Button type="submit" color={cur.danger ? 'red' : undefined} data-autofocus={cur.kind !== 'form' ? true : undefined}>{cur.confirmLabel ?? '확인'}</Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
