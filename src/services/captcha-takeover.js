/**
 * Manual CAPTCHA takeover: CDP screencast + input relay, reusable per worker.
 *
 * - waitForManualSolve(page, session, detection, opts): block the crawl while a
 *   human solves the challenge. Resolves when the challenge auto-clears (DOM poll),
 *   the admin clicks "Selesai", or the timeout elapses.
 * - attachViewer / dispatchInput / teardownCdp: used by the WebSocket layer to
 *   stream frames to the dashboard and relay mouse/keyboard back into the page.
 *
 * One CDP session per crawl session, created lazily on first viewer and torn down
 * when the wait ends. Screencast runs only while at least one admin is watching.
 */

const registry = require('./captcha-registry');
const { detectCaptcha, detectCaptchaViaCdp } = require('./captcha-detector');
const { notifyCaptchaWaiting } = require('./notifier');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- CDP session + screencast lifecycle ----

async function ensureCdp(session) {
  if (session.cdp) return session.cdp;
  // Once the wait has ended we must not recreate a CDP session — the crawl is
  // continuing on the live page and a new screencast would never be torn down.
  if (session._torndown) {
    throw new Error('CDP unavailable — captcha wait already ended');
  }
  // Guard against two viewers attaching the same session concurrently, which would
  // otherwise create (and leak) two CDP sessions.
  if (session._cdpPromise) return session._cdpPromise;
  const page = session.page;
  if (!page || typeof page.target !== 'function') {
    throw new Error('CDP unavailable — crawl session is no longer active');
  }
  session._cdpPromise = (async () => {
    const client = await page.target().createCDPSession();
    session.cdp = {
      client,
      frameCallbacks: new Set(),
      screencasting: false,
      lastMetadata: null,
      _starting: null,
      _frameHandler: null,
    };
    return session.cdp;
  })();
  try {
    return await session._cdpPromise;
  } finally {
    session._cdpPromise = null;
  }
}

async function startScreencast(cdp) {
  if (cdp.screencasting) return;
  if (cdp._starting) return cdp._starting;
  cdp._starting = (async () => {
    cdp._frameHandler = async (frame) => {
      cdp.lastMetadata = frame.metadata;
      for (const cb of cdp.frameCallbacks) {
        try { cb(frame.data, frame.metadata); } catch { /* viewer send failed */ }
      }
      try {
        await cdp.client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch { /* frame arrived after teardown */ }
    };
    cdp.client.on('Page.screencastFrame', cdp._frameHandler);
    await cdp.client.send('Page.enable');
    await cdp.client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 1024,
      everyNthFrame: 1,
    });
    cdp.screencasting = true;
  })();
  try {
    await cdp._starting;
  } finally {
    cdp._starting = null;
  }
}

async function stopScreencast(cdp) {
  if (!cdp.screencasting) return;
  cdp.screencasting = false;
  try { await cdp.client.send('Page.stopScreencast'); } catch { /* client gone */ }
  if (cdp._frameHandler) {
    try { cdp.client.off('Page.screencastFrame', cdp._frameHandler); } catch { /* noop */ }
    cdp._frameHandler = null;
  }
}

/**
 * Register a frame callback and start the screencast if needed.
 * Returns an async detach function.
 */
async function attachViewer(session, onFrame) {
  const cdp = await ensureCdp(session);
  cdp.frameCallbacks.add(onFrame);
  await startScreencast(cdp);
  return async () => {
    cdp.frameCallbacks.delete(onFrame);
    if (cdp.frameCallbacks.size === 0) await stopScreencast(cdp);
  };
}

/** Stop screencast and close the CDP session (called when the wait ends). */
async function teardownCdp(session) {
  // Mark first so any in-flight attach can't recreate the CDP after we tear down.
  session._torndown = true;
  const cdp = session.cdp;
  if (!cdp) return;
  await stopScreencast(cdp);
  cdp.frameCallbacks.clear();
  try { await cdp.client.detach(); } catch { /* already detached */ }
  session.cdp = null;
}

// ---- Input relay ----

const MOUSE_BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

// Non-printable keys we forward with virtual key codes
const SPECIAL_KEYS = {
  Enter: { keyCode: 13, code: 'Enter', text: '\r' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  Tab: { keyCode: 9, code: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape' },
  Delete: { keyCode: 46, code: 'Delete' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  Home: { keyCode: 36, code: 'Home' },
  End: { keyCode: 35, code: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown' },
};

async function dispatchKey(client, ev) {
  const key = ev.key;
  if (!key) return;

  if (key.length === 1) {
    // Printable character — keyDown with text produces the character
    const kc = ev.keyCode || key.toUpperCase().charCodeAt(0);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code: ev.code || '', text: key, unmodifiedText: key,
      windowsVirtualKeyCode: kc,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code: ev.code || '', windowsVirtualKeyCode: kc,
    });
    return;
  }

  const sp = SPECIAL_KEYS[key];
  if (!sp) return; // unknown non-printable key — ignore
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code: sp.code, windowsVirtualKeyCode: sp.keyCode,
    ...(sp.text ? { text: sp.text } : {}),
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: sp.code, windowsVirtualKeyCode: sp.keyCode,
  });
}

/**
 * Relay a normalized input event (coords 0..1 relative to the frame) into the page.
 * Never throws — a bad event must not crash the WS connection or the crawl.
 */
async function dispatchInput(session, ev) {
  const cdp = session.cdp;
  if (!cdp || !cdp.client || !ev || !ev.type) return;
  const client = cdp.client;
  const md = cdp.lastMetadata;
  const vw = (md && md.deviceWidth) || 1920;
  const vh = (md && md.deviceHeight) || 1080;
  const toX = (nx) => Math.max(0, Math.min(vw, (Number(nx) || 0) * vw));
  const toY = (ny) => Math.max(0, Math.min(vh, (Number(ny) || 0) * vh));

  try {
    switch (ev.type) {
      case 'move':
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX(ev.x), y: toY(ev.y) });
        break;
      case 'down': {
        const button = MOUSE_BUTTONS[ev.button] || 'left';
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: toX(ev.x), y: toY(ev.y), button, buttons: BUTTON_MASK[button], clickCount: 1,
        });
        break;
      }
      case 'up': {
        const button = MOUSE_BUTTONS[ev.button] || 'left';
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: toX(ev.x), y: toY(ev.y), button, buttons: 0, clickCount: 1,
        });
        break;
      }
      case 'click': {
        // Composite click (the dashboard normally sends real down/up, which carry the
        // admin's own timing). Approach the target over a few steps and hold the button
        // for a human-plausible dwell — an instant, teleporting click is a bot signal
        // to interaction-scoring widgets like Turnstile.
        const button = MOUSE_BUTTONS[ev.button] || 'left';
        const x = toX(ev.x), y = toY(ev.y);
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x - (steps - i) * 6 + (i % 2 ? 1 : -1),
            y: y - (steps - i) * 4,
          });
          await delay(20 + Math.floor(Math.random() * 25));
        }
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button], clickCount: 1 });
        await delay(60 + Math.floor(Math.random() * 90));
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
        break;
      }
      case 'wheel':
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: toX(ev.x), y: toY(ev.y), deltaX: Number(ev.deltaX) || 0, deltaY: Number(ev.deltaY) || 0,
        });
        break;
      case 'key':
        await dispatchKey(client, ev);
        break;
      default:
        break;
    }
  } catch (err) {
    // Context destroyed mid-input (challenge reloaded) or client gone — ignore
  }
}

// ---- Wait loop ----

/**
 * Block until the CAPTCHA is solved, aborted, or times out.
 * Returns { solved: boolean, method: 'auto'|'admin'|'timeout', reason?: string }.
 */
async function waitForManualSolve(page, session, detection, { timeoutMs = 180000, pollInterval = 1500 } = {}) {
  registry.setWaiting(session.id, {
    captchaType: detection.type,
    captchaReason: detection.reason,
    timeoutMs,
  });

  // Fire-and-forget notification (uses the just-set timeoutAt)
  notifyCaptchaWaiting(registry.publicSession(session));

  console.log(`[Captcha] ${session.website}/${session.pageType} waiting for manual solve (${detection.type}: ${detection.reason})`);

  // Poll through CDP so we never run script in the challenge page's main world —
  // a challenge script can observe (and fingerprint) a page that queries itself on a
  // fixed interval. Falls back to page.evaluate() only if CDP is unavailable.
  let pollClient = null;
  try { pollClient = await page.target().createCDPSession(); } catch { /* fall back below */ }
  const probe = () => (pollClient ? detectCaptchaViaCdp(pollClient) : detectCaptcha(page));

  try {
  const start = Date.now();
  while (true) {
    // 1. Admin decision takes priority
    if (session.manualResult === 'solved') {
      registry.setRunning(session.id);
      console.log(`[Captcha] ${session.website}/${session.pageType} marked solved by admin`);
      return { solved: true, method: 'admin' };
    }
    if (session.manualResult === 'failed') {
      console.log(`[Captcha] ${session.website}/${session.pageType} marked failed by admin`);
      return { solved: false, method: 'admin', reason: 'Admin marked session failed' };
    }

    // 2. Timeout
    if (Date.now() - start > timeoutMs) {
      console.warn(`[Captcha] ${session.website}/${session.pageType} timed out after ${Math.round(timeoutMs / 1000)}s`);
      return { solved: false, method: 'timeout', reason: `No solve within ${Math.round(timeoutMs / 1000)}s` };
    }

    await delay(pollInterval);

    // 3. Auto-detect resolution (challenge cleared without an explicit admin click)
    const check = await probe();
    if (!check.detected && !check.error) {
      // Confirm after a short delay to avoid a transient clear during reload
      await delay(800);
      const confirm = await probe();
      if (!confirm.detected && !confirm.error) {
        registry.setRunning(session.id);
        console.log(`[Captcha] ${session.website}/${session.pageType} auto-resolved`);
        return { solved: true, method: 'auto' };
      }
    }
  }
  } finally {
    if (pollClient) { try { await pollClient.detach(); } catch { /* already gone */ } }
  }
}

module.exports = {
  waitForManualSolve,
  attachViewer,
  dispatchInput,
  teardownCdp,
};
