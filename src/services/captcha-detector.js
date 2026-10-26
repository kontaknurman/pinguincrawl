/**
 * CAPTCHA / challenge page detection for crawl pages.
 *
 * Lightpanda cannot get past these (no rendering engine, and it identifies itself as
 * Lightpanda), so fetchPage() uses this to fail with a clear error instead of returning
 * the challenge page's content, or timing out on a selector that will never appear.
 *
 * detectCaptcha(page) returns { detected, type, reason }:
 *   type: 'cloudflare' | 'turnstile' | 'recaptcha' | 'hcaptcha' | 'ddos-guard' | 'text-challenge' | null
 *
 * Detection is heuristic:
 *   - Cloudflare/DDoS-Guard interstitials and standalone Turnstile are always blocking.
 *   - reCAPTCHA/hCaptcha widgets only count as blocking when the page looks like a
 *     challenge interstitial (verification phrases present or almost no other content),
 *     so normal pages with an embedded login captcha are not flagged.
 */

// Strong, unambiguous interstitial phrases — safe to flag a page on their own.
// These essentially never appear in normal manga/comic content.
const STRONG_PHRASES = [
  'verify you are human',
  'verifying you are human',
  'checking your browser',
  'checking if the site connection is secure',
  'needs to review the security of your connection',
  'enable javascript and cookies to continue',
  'complete the security check',
  'please complete the captcha',
  'ddos protection by',
  // Indonesian variants
  'verifikasi bahwa anda manusia',
  'buktikan bahwa anda manusia',
];

// Weak phrases — common CAPTCHA *widget labels* that also occur in ordinary prose
// (e.g. manga dialogue or titles like "I'm not a robot"). These only corroborate a
// visible captcha widget; they NEVER flag a page on their own, otherwise a normal
// page containing the words would hang the crawl until timeout.
const WEAK_PHRASES = [
  'i am human',
  'confirm you are human',
  'are you a robot',
  'i\'m not a robot',
  'saya bukan robot',
];

// Kept for backwards-compat / external reference
const CHALLENGE_PHRASES = [...STRONG_PHRASES, ...WEAK_PHRASES];

const CHALLENGE_TITLES = [
  'just a moment',
  'attention required',
  'access denied',
  'security check',
  'ddos-guard',
  'captcha',
];

/**
 * Run detection inside the page. Safe against navigation races
 * ("Execution context was destroyed") — returns { detected: false, error: true }
 * so callers can retry on the next poll instead of crashing.
 */
async function detectCaptcha(page) {
  try {
    return await page.evaluate((strongPhrases, weakPhrases, titles) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const anyVisible = (selector) =>
        Array.from(document.querySelectorAll(selector)).some(isVisible);

      const title = (document.title || '').toLowerCase();
      const bodyText = ((document.body && document.body.innerText) || '').toLowerCase();

      // --- Cloudflare interstitial (challenge page markers) ---
      const cfMarkers =
        title.includes('just a moment') ||
        title.includes('attention required') ||
        !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running') ||
        typeof window._cf_chl_opt !== 'undefined';
      if (cfMarkers) {
        return { detected: true, type: 'cloudflare', reason: 'Cloudflare challenge page markers' };
      }

      // --- DDoS-Guard interstitial ---
      if (title.includes('ddos-guard') || !!document.querySelector('#ddg-iframe, .ddg-captcha')) {
        return { detected: true, type: 'ddos-guard', reason: 'DDoS-Guard challenge markers' };
      }

      // --- Challenge phrases in page text or known challenge titles ---
      const strongHit = strongPhrases.find(p => bodyText.includes(p));
      const weakHit = weakPhrases.find(p => bodyText.includes(p));
      const titleHit = titles.find(t => title.includes(t));
      const bodyLen = bodyText.trim().length;

      // A genuine blocking captcha is a sizable visible box (a v2 checkbox / Turnstile /
      // hCaptcha widget is ~300x65+). Requiring a minimum size excludes the invisible
      // reCAPTCHA-v3 badge and 1x1 anchor iframes that many sites load site-wide —
      // otherwise an image-heavy chapter page (short innerText) would be false-flagged.
      const hasSizableWidget = (selector) => {
        for (const el of document.querySelectorAll(selector)) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 200 && r.height >= 50) return true;
        }
        return false;
      };
      const hasTurnstile = hasSizableWidget('iframe[src*="challenges.cloudflare.com"], .cf-turnstile') ||
        !!document.querySelector('input[name="cf-turnstile-response"]');
      // Target the interactive api2 widget, not the v3 badge (.grecaptcha-badge)
      const hasRecaptcha = hasSizableWidget('iframe[src*="/recaptcha/api2/"], iframe[src*="/recaptcha/enterprise/"], .g-recaptcha:not(.grecaptcha-badge)');
      const hasHcaptcha = hasSizableWidget('iframe[src*="hcaptcha.com"], .h-captcha');

      // Interstitial heuristic: a strong verification phrase, a challenge title, a weak
      // widget label, or a near-empty page. Weak labels only count here to corroborate
      // an actual visible widget (below) — never as a standalone trigger.
      // "Near-empty" also requires few images, so an image-heavy chapter reader page
      // (little innerText, many <img>) isn't mistaken for a bare captcha interstitial.
      const imgCount = document.querySelectorAll('img').length;
      const shortBody = bodyLen < 400 && imgCount < 5;
      const looksLikeInterstitial = !!strongHit || !!titleHit || !!weakHit || shortBody;

      if (hasTurnstile && looksLikeInterstitial) {
        return { detected: true, type: 'turnstile', reason: strongHit || weakHit || titleHit || 'Turnstile widget on near-empty page' };
      }
      if (hasRecaptcha && looksLikeInterstitial) {
        return { detected: true, type: 'recaptcha', reason: strongHit || weakHit || titleHit || 'reCAPTCHA widget on near-empty page' };
      }
      if (hasHcaptcha && looksLikeInterstitial) {
        return { detected: true, type: 'hcaptcha', reason: strongHit || weakHit || titleHit || 'hCaptcha widget on near-empty page' };
      }

      // Pure text challenge (custom WAF pages without a known widget) — STRONG phrases
      // only, AND the page must not look like a full content page. Real interstitials
      // are tiny; this stops a long article that merely mentions a phrase from hanging.
      if (strongHit && (bodyLen < 2000 || titleHit)) {
        return { detected: true, type: 'text-challenge', reason: `Page text contains "${strongHit}"` };
      }

      return { detected: false, type: null, reason: null };
    }, STRONG_PHRASES, WEAK_PHRASES, CHALLENGE_TITLES);
  } catch (err) {
    // Navigation destroyed the context mid-check (a page redirecting itself).
    // Report "not detected + error" — the crawl carries on.
    return { detected: false, type: null, reason: null, error: err.message };
  }
}

module.exports = { detectCaptcha, STRONG_PHRASES, WEAK_PHRASES, CHALLENGE_PHRASES, CHALLENGE_TITLES };
