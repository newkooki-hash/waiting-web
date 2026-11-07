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

export interface Intake {
  open: boolean;
  openNow: boolean;
  schedule: { enabled: boolean; start: string; end: string };
  url: string;
}

declare global {
  /** /qrcode.js 가 올려 주는 전역 함수 */
  function qrcode(typeNumber: number, level: string): { addData(s: string): void; make(): void; createImgTag(cell: number, margin: number): string };
}
