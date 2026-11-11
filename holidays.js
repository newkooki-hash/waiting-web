// 한국 법정 공휴일 자동 계산(외부 호출·키 없음). 음력 공휴일은 Intl 중국력으로 구한다.
// 임시공휴일·선거일은 미리 알 수 없어 EXTRA에 알려진 것만 두고, 나머지는 관리자가 예외 날짜로 등록한다.
const EXTRA = { '2026-06-03': '전국동시지방선거', '2028-04-12': '국회의원 선거' };
const FIXED = [['01-01', '신정', false], ['03-01', '삼일절', true], ['05-05', '어린이날', true], ['06-06', '현충일', false],
  ['08-15', '광복절', true], ['10-03', '개천절', true], ['10-09', '한글날', true], ['12-25', '성탄절', true]]; // 셋째 값: 대체공휴일 대상

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (s, n) => iso(Date.parse(s + 'T00:00:00Z') + n * 86400000);
const dow = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const lunarFmt = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
const lunar = (s) => { // {m, d, leap}
  const p = Object.fromEntries(lunarFmt.formatToParts(new Date(s + 'T12:00:00Z')).map((x) => [x.type, x.value]));
  return { m: parseInt(p.month, 10), d: parseInt(p.day, 10), leap: /\D/.test(p.month) };
};

const cache = new Map();
/** 연도의 공휴일 {날짜: 이름} (대체공휴일 포함) */
function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);
  const h = new Map(); // date → {name, sub}
  const add = (date, name, sub) => { const x = h.get(date); h.set(date, x ? { name: x.name + '·' + name, sub: x.sub && sub } : { name, sub }); };
  for (const [md, name, sub] of FIXED) add(`${year}-${md}`, name, sub);
  // 음력: 설날(전날·당일·다음날), 부처님오신날(4/8), 추석(전날·당일·다음날)
  const lunarDays = { seol: [], buddha: null, chu: [] };
  for (let s = `${year}-01-01`; s <= `${year}-12-31`; s = addDays(s, 1)) {
    const l = lunar(s);
    if (l.leap) continue;
    if (l.m === 1 && l.d === 1) lunarDays.seol.push(s);
    else if (l.m === 4 && l.d === 8) lunarDays.buddha = s;
    else if (l.m === 8 && l.d === 15) lunarDays.chu.push(s);
  }
  const blocks = []; // 연휴 묶음(일요일·다른 공휴일과 겹치면 대체공휴일 1일)
  for (const s of lunarDays.seol) blocks.push([['설날 연휴', addDays(s, -1)], ['설날', s], ['설날 연휴', addDays(s, 1)]]);
  for (const s of lunarDays.chu) blocks.push([['추석 연휴', addDays(s, -1)], ['추석', s], ['추석 연휴', addDays(s, 1)]]);
  for (const b of blocks) for (const [name, date] of b) add(date, name, false);
  if (lunarDays.buddha) add(lunarDays.buddha, '부처님오신날', true);
  for (const [date, name] of Object.entries(EXTRA)) if (date.startsWith(year + '-')) add(date, name, false);

  // 대체공휴일: 설·추석 연휴는 일요일이나 다른 공휴일과 겹칠 때, 나머지 대상은 토·일이나 다른 공휴일과 겹칠 때
  const subs = [];
  const nextFree = (from) => { let d = addDays(from, 1); while (h.has(d) || dow(d) === 0 || dow(d) === 6) d = addDays(d, 1); return d; };
  const overlapsOther = (date) => h.get(date).name.includes('·');
  for (const b of blocks) {
    if (b.some(([, d]) => dow(d) === 0 || overlapsOther(d))) subs.push([b[2][1], b[1][0] + ' 대체공휴일']);
  }
  for (const [date, v] of [...h.entries()].sort()) {
    if (v.sub && (dow(date) === 0 || dow(date) === 6 || overlapsOther(date))) subs.push([date, v.name.split('·')[0] + ' 대체공휴일']);
  }
  for (const [from, name] of subs.sort()) { const d = nextFree(from); h.set(d, { name, sub: false }); }
  const out = Object.fromEntries([...h.entries()].sort().map(([d, v]) => [d, v.name]));
  cache.set(year, out);
  return out;
}

/** 날짜(YYYY-MM-DD)가 공휴일이면 이름, 아니면 null */
const holidayName = (date) => holidaysOf(Number(date.slice(0, 4)))[date] || null;
/** from 이후(포함) 공휴일 목록 [{date, name}] */
function upcomingHolidays(from, days = 400) {
  const to = addDays(from, days), out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++)
    for (const [date, name] of Object.entries(holidaysOf(y))) if (date >= from && date <= to) out.push({ date, name });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { holidayName, upcomingHolidays };
