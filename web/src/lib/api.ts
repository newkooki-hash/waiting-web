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

/** 오늘 날짜 (YYYY-MM-DD, 브라우저 현지 시간) */
export const today = () => new Date().toLocaleDateString('sv');

export const shiftMonth = (m: string, n: number) => {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const DOW = ['일', '월', '화', '수', '목', '금', '토'];
