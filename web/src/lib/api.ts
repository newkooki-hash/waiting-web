export interface ApiResult<T = any> {
  ok: boolean;
  status: number;
  body: T;
}

export async function post<T = any>(url: string, body: unknown = {}): Promise<ApiResult<T>> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

export async function getJson<T = any>(url: string): Promise<ApiResult<T>> {
  const r = await fetch(url);
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

let bizStartMin = 0; // 영업일이 바뀌는 시각(분). 관리자 화면이 시작할 때 서버 설정을 받아 둔다
export const setBusinessStart = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); bizStartMin = (h || 0) * 60 + (m || 0); };
/** 오늘 영업일 (YYYY-MM-DD). 영업일 기준 시각 이전이면 전날 */
export const today = () => new Date(Date.now() - bizStartMin * 60000).toLocaleDateString('sv');

export const shiftMonth = (m: string, n: number) => {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const DOW = ['일', '월', '화', '수', '목', '금', '토'];
