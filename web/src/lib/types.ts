export interface Provider { id: string; label: string }

export interface Me {
  user: { name: string; provider: string; phone: string; fullMember: boolean } | null;
  activeToken: string | null;
  last: { party: number; shoes: number | null } | null;
  intake: { open: boolean; allowed: boolean; window: string };
  consent: { missing: string[]; marketing: boolean } | null;
  providers: Provider[];
}

export interface PublicEntry {
  token: string;
  name: string;
  partySize: number;
  shoes: number | null;
  status: 'WAITING' | 'CALLED' | 'ASSIGNED' | 'FINISHED' | 'CANCELED';
  lanes: string;
  position: number | null;
}
