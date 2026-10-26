/**
 * In-memory crawl session registry for the manual CAPTCHA takeover feature.
 *
 * Maps sessionId → session:
 *   status: 'running' | 'waiting_captcha' | 'solving' | 'done' | 'failed'
 *   - running          crawl in progress, no captcha
 *   - waiting_captcha  captcha detected, waiting for admin or auto-resolve
 *   - solving          admin attached and controlling the page
 *   - done / failed    finished (kept for a while so the dashboard shows history)
 *
 * Server-side-only fields (page, cdp, viewers) never leave this process;
 * publicSession() is what gets serialized to the dashboard over WebSocket.
 *
 * Emits 'update' on every state change so the WS layer can broadcast the list.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const sessions = new Map();
const events = new EventEmitter();
events.setMaxListeners(100); // one listener per connected dashboard client

const FINISHED_TTL_MS = 30 * 60 * 1000; // keep done/failed sessions 30 min
const STUCK_TTL_MS = 60 * 60 * 1000;    // reap non-terminal sessions orphaned > 1h
const MAX_SESSIONS = 200;

function emitUpdate(session) {
  events.emit('update', session ? publicSession(session) : null);
}

function publicSession(s) {
  return {
    id: s.id,
    website: s.website,
    pageType: s.pageType,
    url: s.url,
    status: s.status,
    captchaType: s.captchaType,
    captchaReason: s.captchaReason,
    createdAt: s.createdAt,
    waitingSince: s.waitingSince,
    finishedAt: s.finishedAt,
    finishReason: s.finishReason,
    timeoutAt: s.timeoutAt,
    viewers: s.viewers,
  };
}

/**
 * Register a new crawl session (called at fetchPage start). Returns the session.
 */
function register({ website, pageType, url, page }) {
  prune();
  const session = {
    id: crypto.randomUUID(),
    website: website || 'unknown',
    pageType: pageType || 'unknown',
    url,
    status: 'running',
    captchaType: null,
    captchaReason: null,
    createdAt: Date.now(),
    waitingSince: null,
    finishedAt: null,
    finishReason: null,
    timeoutAt: null,
    // server-side only
    page,
    cdp: null,
    viewers: 0, // number of admin dashboards currently attached
    manualResult: null, // 'solved' | 'failed' set by admin buttons
  };
  sessions.set(session.id, session);
  emitUpdate(session);
  return session;
}

function get(id) {
  return sessions.get(id);
}

function setWaiting(id, { captchaType, captchaReason, timeoutMs }) {
  const s = sessions.get(id);
  if (!s) return;
  s.status = 'waiting_captcha';
  s.captchaType = captchaType;
  s.captchaReason = captchaReason;
  s.waitingSince = Date.now();
  s.timeoutAt = Date.now() + timeoutMs;
  emitUpdate(s);
}

function setSolving(id) {
  const s = sessions.get(id);
  if (!s || (s.status !== 'waiting_captcha' && s.status !== 'solving')) return;
  s.status = 'solving';
  emitUpdate(s);
}

/** Back to waiting when the LAST admin viewer detaches without solving. */
function setWaitingAgain(id) {
  const s = sessions.get(id);
  if (!s || s.status !== 'solving') return;
  if (s.viewers > 0) return; // another admin is still controlling it
  s.status = 'waiting_captcha';
  emitUpdate(s);
}

/** Track attached dashboards so the UI can show contention and status is accurate. */
function addViewer(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.viewers += 1;
  emitUpdate(s);
}

function removeViewer(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.viewers = Math.max(0, s.viewers - 1);
  emitUpdate(s);
}

/** Captcha resolved (auto-detected or by admin) — crawl continues. */
function setRunning(id) {
  const s = sessions.get(id);
  if (!s || s.status === 'done' || s.status === 'failed') return;
  s.status = 'running';
  s.timeoutAt = null;
  emitUpdate(s);
}

/** Admin pressed "Selesai" — the wait loop picks this up and continues the crawl. */
function markSolvedByAdmin(id) {
  const s = sessions.get(id);
  if (!s || (s.status !== 'waiting_captcha' && s.status !== 'solving')) return false;
  s.manualResult = 'solved';
  return true;
}

/** Admin pressed "Gagal" — the wait loop aborts this crawl attempt. */
function markFailedByAdmin(id) {
  const s = sessions.get(id);
  if (!s || (s.status !== 'waiting_captcha' && s.status !== 'solving')) return false;
  s.manualResult = 'failed';
  return true;
}

/**
 * Mark session finished. Safe to call multiple times (first result wins).
 */
function finish(id, status, reason) {
  const s = sessions.get(id);
  if (!s || s.status === 'done' || s.status === 'failed') return;
  s.status = status === 'done' ? 'done' : 'failed';
  s.finishedAt = Date.now();
  s.finishReason = reason || null;
  s.timeoutAt = null;
  // Drop server-side references so the browser/page can be GC'd
  s.page = null;
  s.cdp = null;
  emitUpdate(s);
}

function list() {
  return Array.from(sessions.values());
}

function publicList() {
  // Active first (waiting/solving on top), then running, then finished newest-first
  const order = { waiting_captcha: 0, solving: 0, running: 1, done: 2, failed: 2 };
  return Array.from(sessions.values())
    .sort((a, b) => (order[a.status] - order[b.status]) || (b.createdAt - a.createdAt))
    .map(publicSession);
}

function waitingCount() {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.status === 'waiting_captcha' || s.status === 'solving') n++;
  }
  return n;
}

/** Remove finished sessions past TTL; enforce hard cap on total entries. */
function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if ((s.status === 'done' || s.status === 'failed') && now - s.finishedAt > FINISHED_TTL_MS) {
      sessions.delete(id);
    } else if (s.status !== 'done' && s.status !== 'failed' && now - s.createdAt > STUCK_TTL_MS) {
      // A non-terminal session this old is orphaned (its fetchPage threw before
      // finish() could run). Drop it so the registry doesn't grow unbounded.
      sessions.delete(id);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const finished = Array.from(sessions.values())
      .filter(s => s.status === 'done' || s.status === 'failed')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    for (const s of finished) {
      if (sessions.size <= MAX_SESSIONS) break;
      sessions.delete(s.id);
    }
  }
}

module.exports = {
  events,
  register,
  get,
  setWaiting,
  setSolving,
  setWaitingAgain,
  addViewer,
  removeViewer,
  setRunning,
  markSolvedByAdmin,
  markFailedByAdmin,
  finish,
  list,
  publicList,
  publicSession,
  waitingCount,
};
