export interface Provider { id: string; label: string }

export interface Me {
  user: { name: string; provider: string; phone: string; fullMember: boolean } | null;
  activeToken: string | null;
  last: { party: number; shoes: number | null } | null;
  intake: { open: boolean; window: string; hours: { business: string; intake: string; intake24: boolean; memo: string; closed: boolean; label: string; note: string } };
  arrivalLimitMin: number; // 접수 후 카운터에서 도착 확인을 받아야 하는 시간(분)
  noshow: { count: number; warn: boolean; until: string | null; left: number; banDays: number } | null; // 반복 미도착: 경고·접수 제한 해제일
  consent: { missing: string[]; marketing: boolean } | null;
  providers: Provider[];
}

export interface PublicEntry {
  token: string;
  name: string;
  partySize: number;
  shoes: number | null;
  status: 'WAITING' | 'ASSIGNED' | 'FINISHED' | 'CANCELED' | 'EXPIRED';
  arrived: boolean;
  arrivalLeft: number | null; // 도착 인증까지 남은 초(대기 중이고 아직 도착 전일 때만)
  lanes: string;
  position: number | null;
}
