import { DOW } from './api';

/** 서버(/api/home)와 관리자 미리보기가 같이 쓰는 대회신청 버튼 상태 */
export interface HomeTournament {
  state: 'open' | 'upcoming' | 'closed' | 'none';
  name?: string; applyStart?: string; applyEnd?: string; eventAt?: string;
  full?: boolean; // 정원이 찼는지(찼어도 대기 신청은 받는다)
  next?: { name: string; applyStart: string } | null; // 마감 상태일 때 다음에 열리는 대회
}

const parse = (ts: string) => new Date(ts.replace(' ', 'T'));
/** 2026-11-15 10:00 → 11월 15일(일) 10:00 */
export const when = (ts: string) => {
  const d = parse(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${DOW[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** active: 누를 수 있는 상태, sub: 버튼 안의 작은 글, tip: 비활성 버튼을 눌렀을 때의 안내 */
export function tournamentButton(t: HomeTournament): { active: boolean; sub: string; tip: string } {
  if (t.state === 'open') return { active: true, sub: `접수중 · ${when(t.applyEnd!)} 마감${t.full ? ' · 대기 신청' : ''}`, tip: '' };
  if (t.state === 'upcoming') return { active: false, sub: `${when(t.applyStart!)} 오픈`, tip: `대회 신청은 ${when(t.applyStart!)}에 열립니다.` };
  if (t.state === 'closed') {
    const next = t.next ? ` 다음 대회 신청은 ${when(t.next.applyStart)}에 열립니다.` : '';
    return { active: false, sub: t.next ? `접수 마감 · 다음 ${when(t.next.applyStart)} 오픈` : '접수 마감', tip: `이번 대회 신청은 마감되었습니다.${next}` };
  }
  return { active: false, sub: '접수 일정 준비 중', tip: '대회 접수 일정이 정해지면 안내드립니다.' };
}
