import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 새 대기 알림음. 브라우저는 사용자가 한 번 누르기 전에는 소리를 낼 수 없어,
 * 켜기 버튼을 누르거나 화면을 처음 누를 때 오디오를 준비한다.
 */
export function useSound() {
  const [on, setOn] = useState(() => localStorage.getItem('alertSound') === '1');
  const [running, setRunning] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const onRef = useRef(on);
  onRef.current = on;

  const ensure = useCallback(() => {
    if (!audio.current) {
      const ctx = new AudioContext();
      ctx.onstatechange = () => setRunning(ctx.state === 'running');
      audio.current = ctx;
    }
    return audio.current;
  }, []);

  const prepare = useCallback(() => ensure().resume().then(() => setRunning(audio.current!.state === 'running')), [ensure]);

  const beep = useCallback(() => {
    const ctx = audio.current;
    if (!onRef.current || !ctx || ctx.state !== 'running') return;
    [880, 1175].forEach((hz, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.18;
      o.frequency.value = hz; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.start(t); o.stop(t + 0.17);
    });
  }, []);

  // 켜 둔 상태로 열면 오디오를 미리 만들어, 자동 재생이 허용되는 환경에서는 클릭 없이 바로 켜진다
  useEffect(() => {
    if (on) { const ctx = ensure(); setRunning(ctx.state === 'running'); }
    const onClick = () => { if (onRef.current) prepare(); };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async () => {
    const next = !on;
    setOn(next); onRef.current = next;
    localStorage.setItem('alertSound', next ? '1' : '0');
    if (next) { await prepare(); beep(); }
  };

  // 불빛: 초록 = 소리 나는 상태, 주황 깜빡임 = 켰지만 브라우저가 막은 상태(화면을 한 번 클릭), 꺼짐은 빨강
  const dot = !on ? '' : running ? 'on' : 'off blink';
  const title = !on ? '알림음 꺼짐 (눌러서 켜기)' : running ? '알림음 켜짐' : '알림음을 켰지만 소리가 막혀 있습니다. 화면을 한 번 클릭하세요';
  return { dot, title, toggle, beep };
}
