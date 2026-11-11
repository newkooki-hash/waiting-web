import { useEffect, useState } from 'react';
import { TextInput } from '@mantine/core';

const VALID = /^([01]\d|2[0-3]):[0-5]\d$/;
const clamp = (m: number) => ((m % 1440) + 1440) % 1440;
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 24시간제 HH:MM 입력. 브라우저 기본 시간 선택창은 마우스 휠로 값이 건너뛰어 원하는 분을 고르기 어려워 쓰지 않는다.
 * 숫자를 직접 입력하거나(2230 → 22:30), ↑/↓ 키로 1분(Shift는 10분)씩 바꾼다. 휠로는 값이 바뀌지 않는다.
 */
export function TimeField({ value, onChange, disabled, label, className }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (text: string) => {
    const d = text.replace(/\D/g, '').slice(0, 4);
    const p = d.padStart(4, '0');
    // 9 → 09:00, 930 → 09:30, 2230 → 22:30. 비었거나 잘못된 값은 이전 값으로 되돌린다
    const v = !d ? '' : d.length <= 2 ? `${d.padStart(2, '0')}:00` : `${p.slice(0, 2)}:${p.slice(2)}`;
    if (VALID.test(v)) { setDraft(v); onChange(v); } else setDraft(value);
  };
  const type = (text: string) => {
    const d = text.replace(/\D/g, '').slice(0, 4);
    const shown = d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d;
    setDraft(shown);
    if (d.length === 4 && VALID.test(shown)) onChange(shown);
  };
  return (
    <TextInput
      aria-label={label}
      className={className}
      disabled={disabled}
      inputMode="numeric"
      placeholder="HH:MM"
      maxLength={5}
      value={draft}
      onChange={(e) => type(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(e.currentTarget.value); return; }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const base = VALID.test(draft) ? Number(draft.slice(0, 2)) * 60 + Number(draft.slice(3)) : VALID.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : 0;
        const next = fmt(clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)));
        setDraft(next); onChange(next);
      }}
    />
  );
}
