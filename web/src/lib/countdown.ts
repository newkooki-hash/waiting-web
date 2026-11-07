import { useEffect, useRef, useState } from 'react';

/** 남은 초를 1초마다 줄여 보여 준다. 0이 되면 onZero를 한 번 부른다(서버와 시계 차이를 감안해 호출한 쪽이 잠시 뒤 다시 조회한다). */
export function useCountdown(initial: number | null, onZero: () => void) {
  const [left, setLeft] = useState(initial);
  const zero = useRef(onZero);
  zero.current = onZero;
  useEffect(() => {
    if (initial === null) { setLeft(null); return; }
    const end = Date.now() + initial * 1000;
    let fired = false;
    const tick = () => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0 && !fired) { fired = true; clearInterval(id); zero.current(); }
    };
    const id = setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
  }, [initial]);
  return left;
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
