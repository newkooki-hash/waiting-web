// SMS 발송. 솔라피 키가 있으면 실제 발송, 없으면 개발용으로 서버 콘솔에만 출력한다.
const crypto = require('node:crypto');

const { SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER } = process.env;
const configured = () => !!(SOLAPI_API_KEY && SOLAPI_API_SECRET && SOLAPI_SENDER);

async function sendSolapi(to, text) {
  const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', SOLAPI_API_SECRET).update(date + salt).digest('hex');
  const r = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({ message: { to, from: SOLAPI_SENDER.replace(/\D/g, ''), text } }),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(`solapi ${r.status} ${b.errorCode || ''} ${b.errorMessage || ''}`.trim());
  }
}

// 테스트에서 sms.driver를 바꿔 끼울 수 있다.
const sms = {
  configured,
  async driver(to, text) {
    if (configured()) return sendSolapi(to, text);
    if (process.env.NODE_ENV === 'production') throw new Error('SMS provider not configured');
    console.log(`[SMS 개발용] ${to}: ${text}`); // 실제 발송 없음
  },
  send(to, text) { return sms.driver(to, text); },
};

module.exports = sms;
