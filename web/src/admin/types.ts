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
export interface Intake {
  openNow: boolean;
  biz: Hours;
  wait: { same: boolean; start: string; end: string };
  hours: { business: string; intake: string; intake24: boolean };
  dayStart: string; // 24시간 영업일 때 직접 정한 영업일 기준 시각
  bizDay: string; // 지금 적용되는 영업일 기준 시각
  url: string;
}

declare global {
  /** /qrcode.js 가 올려 주는 전역 함수 */
  function qrcode(typeNumber: number, level: string): { addData(s: string): void; make(): void; createImgTag(cell: number, margin: number): string };
}
