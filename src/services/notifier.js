/**
 * Optional webhook notification when a crawl session needs a manual CAPTCHA solve.
 *
 * Settings (managed from /admin/captcha):
 *   captcha_notify_url               webhook URL; empty = disabled
 *   captcha_notify_telegram_chat_id  chat id, only used for api.telegram.org URLs
 *
 * Payload formats:
 *   - Telegram (URL contains api.telegram.org): { chat_id, text }
 *   - Anything else (Slack/Discord/Mattermost-compatible): { text }
 */

const db = require('../models/database');

function buildMessage(session) {
  const waitSecs = Math.round((session.timeoutAt - Date.now()) / 1000);
  return [
    '🧩 CAPTCHA butuh manual solve',
    `Website : ${session.website} (${session.pageType})`,
    `Type    : ${session.captchaType}`,
    `URL     : ${session.url}`,
    `Timeout : ${waitSecs}s`,
    'Buka dashboard: /admin/captcha',
  ].join('\n');
}

/**
 * Fire-and-forget: never throws, never blocks the crawl.
 */
function notifyCaptchaWaiting(session) {
  const url = (db.getSetting('captcha_notify_url') || '').trim();
  if (!url) return;

  // Only http(s) — reject file:/gopher:/etc. (private IPs are allowed on purpose:
  // self-hosted Slack-compatible webhooks like Mattermost are commonly internal).
  try {
    const proto = new URL(url).protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      console.warn('[Captcha] Notify webhook ignored — only http/https URLs are allowed');
      return;
    }
  } catch {
    console.warn('[Captcha] Notify webhook ignored — invalid URL');
    return;
  }

  const text = buildMessage(session);
  let payload;
  if (url.includes('api.telegram.org')) {
    const chatId = (db.getSetting('captcha_notify_telegram_chat_id') || '').trim();
    if (!chatId) {
      console.warn('[Captcha] Telegram webhook set but captcha_notify_telegram_chat_id is empty — notification skipped');
      return;
    }
    payload = { chat_id: chatId, text };
  } else {
    payload = { text };
  }

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  }).then(res => {
    if (!res.ok) console.warn(`[Captcha] Notify webhook returned HTTP ${res.status}`);
  }).catch(err => {
    console.warn(`[Captcha] Notify webhook failed: ${err.message}`);
  });
}

module.exports = { notifyCaptchaWaiting };
