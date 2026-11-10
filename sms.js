// SMS 발송. NHN Cloud 또는 솔라피 키가 있으면 실제 발송, 없으면 개발용으로 서버 콘솔에만 출력한다.
// 둘 다 설정돼 있으면 SMS_PROVIDER(nhn|solapi)로 고르고, 없으면 NHN Cloud를 우선한다.
const crypto = require('node:crypto');

const { SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER, NHN_SMS_APPKEY, NHN_SMS_SECRET, NHN_SMS_SENDER, SMS_PROVIDER } = process.env;
const nhnOk = () => !!(NHN_SMS_APPKEY && NHN_SMS_SECRET && NHN_SMS_SENDER);
const solapiOk = () => !!(SOLAPI_API_KEY && SOLAPI_API_SECRET && SOLAPI_SENDER);
const provider = () => {
  if (SMS_PROVIDER === 'solapi') return solapiOk() ? 'solapi' : null;
  if (SMS_PROVIDER === 'nhn') return nhnOk() ? 'nhn' : null;
  return nhnOk() ? 'nhn' : solapiOk() ? 'solapi' : null;
};
const configured = () => !!provider();

// NHN Cloud Notification > SMS (인증번호는 광고가 아니므로 /sender/sms)
async function sendNhn(to, text) {
  const r = await fetch(`https://api-sms.cloud.toast.com/sms/v3.0/appKeys/${NHN_SMS_APPKEY}/sender/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'X-Secret-Key': NHN_SMS_SECRET },
    body: JSON.stringify({ body: text, sendNo: NHN_SMS_SENDER.replace(/\D/g, ''), recipientList: [{ recipientNo: to.replace(/\D/g, '') }] }),
  });
  const b = await r.json().catch(() => ({}));
  const h = b.header || {};
  if (!r.ok || h.isSuccessful === false) throw new Error(`nhn ${r.status} ${h.resultCode ?? ''} ${h.resultMessage || ''}`.trim());
}

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
    const p = provider();
    if (p === 'nhn') return sendNhn(to, text);
    if (p === 'solapi') return sendSolapi(to, text);
    if (process.env.NODE_ENV === 'production') throw new Error('SMS provider not configured');
    console.log(`[SMS 개발용] ${to}: ${text}`); // 실제 발송 없음
  },
  send(to, text) { return sms.driver(to, text); },
};

module.exports = sms;
