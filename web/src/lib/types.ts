export interface Provider { id: string; label: string }

export interface Me {
  user: { name: string; provider: string; phone: string; fullMember: boolean } | null;
  activeToken: string | null;
  last: { party: number; shoes: number | null } | null;
  intake: { open: boolean; window: string };
  arrivalLimitMin: number; // 접수 후 카운터에서 도착 확인을 받아야 하는 시간(분)
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
