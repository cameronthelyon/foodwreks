// Delivery providers. Each exposes send() and throws an error with
// `permanent = true` when retrying cannot help (bad address, opted out).

export class DeliveryError extends Error {
  constructor(message, { permanent = false, status } = {}) {
    super(message);
    this.permanent = permanent;
    this.status = status;
  }
}

const permanentStatus = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

export function makeEmailProvider(cfg, fetchImpl = globalThis.fetch, log = console) {
  if (cfg.provider === 'none') return null;
  if (cfg.provider === 'postmark') {
    if (!cfg.postmarkToken) throw new Error('POSTMARK_TOKEN is required for EMAIL_PROVIDER=postmark');
    return {
      name: 'postmark',
      async send({ to, subject, text, html, replyTo, tag }) {
        const res = await fetchImpl('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': cfg.postmarkToken,
          },
          body: JSON.stringify({
            From: cfg.from,
            To: to,
            Subject: subject,
            TextBody: text,
            HtmlBody: html || undefined,
            ReplyTo: replyTo || undefined,
            Tag: tag || undefined,
            MessageStream: 'outbound',
          }),
        });
        const body = await readJson(res);
        if (!res.ok || (body.ErrorCode && body.ErrorCode !== 0)) {
          throw new DeliveryError(`Postmark ${res.status}: ${body.Message || body.raw || 'error'}`, {
            permanent: permanentStatus(res.status),
            status: res.status,
          });
        }
        return { id: body.MessageID };
      },
    };
  }
  if (cfg.provider === 'resend') {
    if (!cfg.resendKey) throw new Error('RESEND_API_KEY is required for EMAIL_PROVIDER=resend');
    return {
      name: 'resend',
      async send({ to, subject, text, html, replyTo, tag }) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: cfg.from,
            to: [to],
            subject,
            text,
            html: html || undefined,
            reply_to: replyTo || undefined,
            tags: tag ? [{ name: 'kind', value: tag }] : undefined,
          }),
        });
        const body = await readJson(res);
        if (!res.ok) {
          throw new DeliveryError(`Resend ${res.status}: ${body.message || body.raw || 'error'}`, {
            permanent: permanentStatus(res.status),
            status: res.status,
          });
        }
        return { id: body.id };
      },
    };
  }
  // Development: print instead of sending.
  return {
    name: 'console',
    async send({ to, subject, text }) {
      log.info?.(`[email] to=${to} subject=${JSON.stringify(subject)}\n${text}\n`);
      return { id: 'console' };
    },
  };
}

export function makeSmsProvider(cfg, fetchImpl = globalThis.fetch, log = console) {
  if (cfg.provider === 'twilio') {
    if (!cfg.twilioSid || !cfg.twilioToken || !(cfg.twilioFrom || cfg.twilioMessagingService)) {
      throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID) are required');
    }
    const auth = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString('base64');
    return {
      name: 'twilio',
      async send({ to, body }) {
        const form = new URLSearchParams({ To: to, Body: body });
        if (cfg.twilioMessagingService) form.set('MessagingServiceSid', cfg.twilioMessagingService);
        else form.set('From', cfg.twilioFrom);
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.twilioSid)}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const data = await readJson(res);
        if (!res.ok) {
          // 21211 invalid number, 21610 recipient replied STOP, 21614 not a mobile number
          const permanent = permanentStatus(res.status) || [21211, 21610, 21614].includes(data.code);
          throw new DeliveryError(`Twilio ${res.status} ${data.code ?? ''}: ${data.message || data.raw || 'error'}`, {
            permanent,
            status: res.status,
          });
        }
        return { id: data.sid };
      },
    };
  }
  if (cfg.provider === 'console') {
    return {
      name: 'console',
      async send({ to, body }) {
        log.info?.(`[sms] to=${to} ${body}`);
        return { id: 'console' };
      },
    };
  }
  return null;
}
