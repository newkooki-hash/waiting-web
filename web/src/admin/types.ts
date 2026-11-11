export interface QueueEntry {
  id: number;
  name: string;
  phone: string;
  partySize: number;
  shoes: number | null;
  status: 'WAITING' | 'ASSIGNED' | 'EXPIRED';
  arrivedAt: string | null;
  arrivalMethod: 'qr' | 'staff' | null;
  arrivalLeft: number | null;
  memo: string;
  manual: boolean;
  createdAt: string;
  assignedAt?: string;
  lanes: string;
  visits: number | null;
}

export interface Hours { h24: boolean; start: string; end: string }
export interface DayRule { biz: Hours & { closed: boolean } }
export interface Intake {
  openNow: boolean;
  hours: { business: string; intake: string; intake24: boolean; closeBefore: number; memo: string; openBefore: number; closed: boolean; label: string; note: string };
  waitBefore: number; // 대기접수 마감: 영업 종료 N분 전
  waitOpen: number; // 대기접수 시작: 영업 시작 M분 전
  schedule: DayRule[]; // 0=일 … 6=토, 7=공휴일
  exceptions: (DayRule & { date: string; note: string })[];
  holidays: { date: string; name: string }[];
  dayStart: string; // 직접 정한 영업일 기준 시각
  bizDay: string; // 지금 적용되는 영업일 기준 시각(dayStart와 같음)
  url: string;
}

declare global {
  /** /qrcode.js 가 올려 주는 전역 함수 */
  function qrcode(typeNumber: number, level: string): { addData(s: string): void; make(): void; createImgTag(cell: number, margin: number): string };
}
