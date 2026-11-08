import { useEffect, useState, type FormEvent } from 'react';
import { ActionIcon, Button, Modal, Text, TextInput } from '@mantine/core';
import { LuMinus, LuPlus } from 'react-icons/lu';

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
  /** 숫자 −/+ 버튼과 직접 입력. max에 { field }를 주면 그 칸의 값을 넘지 못하고, 그 칸이 바뀔 때 함께 따라간다 */
  stepper?: { min: number; max: number | { field: string }; unit?: string; zeroLabel?: string };
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
  const limitOf = (f: Field, vs: Record<string, string>) => {
    const m = f.stepper!.max;
    return typeof m === 'number' ? m : Number(vs[m.field]) || 0;
  };
  // 값을 바꾼다. 다른 숫자 칸의 상한이 되는 칸(인원)이 바뀌면, 같은 값이던 칸(신발)은 따라가고 아니면 상한을 넘지 않게만 줄인다
  const setField = (name: string, raw: string) => {
    const next = { ...values };
    const f = cur.fields!.find((x) => x.name === name)!;
    if (f.stepper) {
      const digits = raw.replace(/\D/g, '');
      const n = digits === '' ? NaN : Math.min(Number(digits), limitOf(f, values));
      next[name] = Number.isNaN(n) ? '' : String(Math.max(n, f.stepper.min));
      for (const g of cur.fields!) {
        if (g.stepper && typeof g.stepper.max !== 'number' && g.stepper.max.field === name) {
          const old = values[g.name];
          next[g.name] = old === values[name] ? next[name] : String(Math.min(Number(old) || 0, Number(next[name]) || 0));
        }
      }
    } else next[name] = raw;
    setValues(next);
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    done(cur.kind === 'form' ? values : true);
  };

  const title = cur?.title ?? (cur?.kind === 'alert' ? '알림' : cur?.kind === 'confirm' ? '확인' : '');
  return (
    <Modal opened={!!cur} onClose={cancel} title={title} centered closeOnClickOutside={cur?.kind !== 'form'} withCloseButton={false} zIndex={1000}>
      {cur && (
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            {cur.message && <Text className="whitespace-pre-line">{cur.message}</Text>}
            {cur.fields?.map((f, i) => f.stepper ? (
              <div key={f.name}>
                <Text fz="sm" fw={500} className="mb-1">{f.label}</Text>
                <div className="flex items-center gap-2">
                  <ActionIcon type="button" variant="light" color="gray" size={44} radius="md" aria-label={f.label + ' 줄이기'} disabled={Number(values[f.name] || 0) <= f.stepper.min}
                    onClick={() => setField(f.name, String(Number(values[f.name] || 0) - 1))}><LuMinus size={22} /></ActionIcon>
                  <TextInput className="flex-1" size="md" inputMode="numeric" aria-label={f.label} data-autofocus={i === 0 ? true : undefined}
                    styles={{ input: { textAlign: 'center', fontWeight: 700, fontSize: 20, paddingInline: 64 } }}
                    rightSection={<Text fz="sm" c="dimmed" className="pr-3 w-full text-right">{values[f.name] === '0' && f.stepper.zeroLabel ? f.stepper.zeroLabel : f.stepper.unit}</Text>} rightSectionWidth={64}
                    value={values[f.name] ?? ''} onChange={(e) => setField(f.name, e.currentTarget.value)} />
                  <ActionIcon type="button" variant="filled" color="dark" size={44} radius="md" aria-label={f.label + ' 늘리기'} disabled={Number(values[f.name] || 0) >= limitOf(f, values)}
                    onClick={() => setField(f.name, String(Number(values[f.name] || 0) + 1))}><LuPlus size={22} /></ActionIcon>
                </div>
              </div>
            ) : (
              <TextInput key={f.name}
      label={cur.fields!.length > 1 || cur.title !== f.label ? f.label : undefined}
      aria-label={f.label}
      placeholder={f.placeholder}
      required={f.required}
      inputMode={f.inputMode}
      data-autofocus={i === 0 ? true : undefined}
      value={values[f.name] ?? ''}
      onChange={(e) => setField(f.name, e.currentTarget.value)} />
            ))}
            <div className="flex gap-4 items-center justify-end flex-wrap">
              {cur.kind !== 'alert' && <Button variant="default" type="button" onClick={cancel}>취소</Button>}
              <Button type="submit" color={cur.danger ? 'red' : undefined} data-autofocus={cur.kind !== 'form' ? true : undefined}>{cur.confirmLabel ?? '확인'}</Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
