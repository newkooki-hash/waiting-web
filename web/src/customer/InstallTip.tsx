import { useEffect, useState } from 'react';
import { Button, Paper, Text } from '@mantine/core';
import { LuSmartphone } from 'react-icons/lu';

const KEY = 'installTipDismissed';
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
const isIos = /iPhone|iPad|iPod/i.test(ua);
const inApp = /KAKAOTALK|NAVER\(inapp|NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua); // 인앱 브라우저는 홈 화면에 추가할 수 없다
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** 홈 화면에 바로가기를 만드는 방법을 알려 준다. 이미 설치했거나 닫은 적이 있으면 보이지 않는다 */
export function InstallTip() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [hidden, setHidden] = useState(() => { try { return !!localStorage.getItem(KEY); } catch { return false; } });

  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setPrompt(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', on);
    window.addEventListener('appinstalled', () => setHidden(true));
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);

  if (!isMobile || hidden || standalone()) return null;
  const close = () => { try { localStorage.setItem(KEY, '1'); } catch { /* 저장이 막혀도 이번 화면에서는 닫는다 */ } setHidden(true); };
  const install = async () => { if (!prompt) return; await prompt.prompt(); if ((await prompt.userChoice).outcome === 'accepted') setHidden(true); setPrompt(null); };

  let steps: string;
  if (inApp) steps = '지금은 카카오톡·네이버 앱 안에서 열려 있어요. 화면 메뉴(⋯)에서 "다른 브라우저로 열기"를 누른 뒤, 크롬·사파리에서 홈 화면에 추가해 주세요.';
  else if (isIos) steps = '사파리 아래쪽의 공유 버튼(□↑)을 누르고 "홈 화면에 추가"를 선택하세요.';
  else steps = '브라우저 메뉴(⋮)에서 "홈 화면에 추가"를 선택하세요.';

  return (
    <Paper withBorder radius="lg" className="p-4 mt-4">
      <div className="flex gap-3 items-start">
        <LuSmartphone size={26} className="shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1">
          <Text fw={700}>홈 화면에 바로가기 추가</Text>
          <Text c="dimmed" fz="sm" className="mt-1">아이콘을 눌러 바로 대기 접수와 공지를 확인할 수 있어요.</Text>
          {prompt && !inApp ? <Button size="sm" className="mt-3" onClick={install}>홈 화면에 추가</Button> : <Text fz="sm" className="mt-2">{steps}</Text>}
        </div>
      </div>
      <div className="text-right mt-2"><Button variant="subtle" color="gray" size="compact-xs" onClick={close}>다시 보지 않기</Button></div>
    </Paper>
  );
}
