// 카카오·네이버 OAuth 2.0 (인가 코드 방식). 키는 환경변수로만 받는다.
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const providers = {
  kakao: {
    label: '카카오',
    clientId: process.env.KAKAO_CLIENT_ID,
    clientSecret: process.env.KAKAO_CLIENT_SECRET, // 선택
    authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    profileUrl: 'https://kapi.kakao.com/v2/user/me',
    scope: 'profile_nickname',
    parse: (p) => ({
      id: String(p.id),
      name: p.kakao_account?.profile?.nickname || p.properties?.nickname || '',
    }),
  },
  naver: {
    label: '네이버',
    clientId: process.env.NAVER_CLIENT_ID,
    clientSecret: process.env.NAVER_CLIENT_SECRET,
    authorizeUrl: 'https://nid.naver.com/oauth2.0/authorize',
    tokenUrl: 'https://nid.naver.com/oauth2.0/token',
    profileUrl: 'https://openapi.naver.com/v1/nid/me',
    parse: (p) => ({ id: String(p.response?.id), name: p.response?.name || p.response?.nickname || '' }),
  },
};

const enabled = () => Object.keys(providers).filter((k) => providers[k].clientId);
const redirectUri = (name) => `${BASE_URL}/auth/${name}/callback`;

function authorizeUrl(name, state) {
  const p = providers[name];
  const q = new URLSearchParams({
    response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri(name), state,
  });
  if (p.scope) q.set('scope', p.scope);
  return `${p.authorizeUrl}?${q}`;
}

// 인가 코드를 토큰으로 교환하고 프로필 { id, name }을 돌려준다. 실패 시 throw.
async function fetchProfile(name, code, state) {
  const p = providers[name];
  const form = new URLSearchParams({
    grant_type: 'authorization_code', client_id: p.clientId, redirect_uri: redirectUri(name), code, state,
  });
  if (p.clientSecret) form.set('client_secret', p.clientSecret);
  const t = await fetch(p.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const token = await t.json();
  if (!t.ok || !token.access_token) throw new Error('token exchange failed');
  const r = await fetch(p.profileUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!r.ok) throw new Error('profile fetch failed');
  const profile = p.parse(await r.json());
  if (!profile.id || profile.id === 'undefined') throw new Error('no profile id');
  return profile;
}

module.exports = { BASE_URL, providers, enabled, authorizeUrl, fetchProfile };
