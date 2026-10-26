/**
 * Minimal WebSocket relay between the admin dashboard and Puppeteer sessions
 * waiting on a CAPTCHA. Mounted on the existing HTTP server at
 * `/admin/captcha/ws`; the upgrade handshake is authenticated with the same
 * admin auth_token cookie as the rest of the panel.
 *
 * Client → server messages (JSON):
 *   { type: 'attach', id }          start watching a session (begins screencast)
 *   { type: 'detach', id }          stop watching
 *   { type: 'input', id, event }    relay a normalized mouse/keyboard event
 *   { type: 'solved', id }          admin marks the CAPTCHA solved
 *   { type: 'failed', id }          admin aborts the session
 *
 * Server → client messages (JSON):
 *   { type: 'sessions', sessions }  full session list (sent on connect + every change)
 *   { type: 'frame', id, data, metadata }  base64 JPEG screencast frame
 *   { type: 'error', id, message }
 */

const { WebSocketServer } = require('ws');
const { URL } = require('url');
const registry = require('./captcha-registry');
const takeover = require('./captcha-takeover');
const { verifyRequestAuth } = require('../middleware/auth');

const WS_PATH = '/admin/captcha/ws';

function initCaptchaWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    if (!verifyRequestAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const viewers = new Map(); // sessionId -> detach fn
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch { /* socket closing */ }
      }
    };

    // Re-verify the admin auth cookie periodically so that logging out from all
    // devices (session-secret reset) or token expiry tears down live sockets too.
    const authTimer = setInterval(() => {
      if (!verifyRequestAuth(req)) {
        try { ws.close(4401, 'auth expired'); } catch { /* noop */ }
      }
    }, 60 * 1000);

    // Initial snapshot + live updates
    send({ type: 'sessions', sessions: registry.publicList() });
    const onUpdate = () => send({ type: 'sessions', sessions: registry.publicList() });
    registry.events.on('update', onUpdate);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const session = msg.id ? registry.get(msg.id) : null;

      switch (msg.type) {
        case 'attach': {
          if (!session) return send({ type: 'error', id: msg.id, message: 'Session not found or already finished' });
          if (session.status !== 'waiting_captcha' && session.status !== 'solving') {
            return send({ type: 'error', id: msg.id, message: 'Session is not awaiting a solve' });
          }
          if (viewers.has(msg.id)) return;
          try {
            const detach = await takeover.attachViewer(session, (data, metadata) => {
              // Backpressure: if the socket is already backed up, drop this frame
              // instead of growing the send buffer unbounded for a slow client.
              if (ws.bufferedAmount > 2_000_000) return;
              send({
                type: 'frame',
                id: msg.id,
                data,
                metadata: { deviceWidth: metadata.deviceWidth, deviceHeight: metadata.deviceHeight },
              });
            });
            viewers.set(msg.id, detach);
            registry.addViewer(msg.id);   // accurate viewer count for the dashboard
            registry.setSolving(msg.id);  // only mark solving once control is really established
          } catch (err) {
            send({ type: 'error', id: msg.id, message: err.message });
          }
          break;
        }
        case 'detach': {
          const detach = viewers.get(msg.id);
          if (detach) {
            viewers.delete(msg.id);
            try { await detach(); } catch { /* noop */ }
            registry.removeViewer(msg.id);
            registry.setWaitingAgain(msg.id); // reverts to waiting only if no viewers remain
          }
          break;
        }
        case 'input': {
          if (session && viewers.has(msg.id)) {
            await takeover.dispatchInput(session, msg.event);
          }
          break;
        }
        case 'solved':
          registry.markSolvedByAdmin(msg.id);
          break;
        case 'failed':
          registry.markFailedByAdmin(msg.id);
          break;
        default:
          break;
      }
    });

    ws.on('close', async () => {
      clearInterval(authTimer);
      registry.events.off('update', onUpdate);
      // Release every session this socket was controlling so it doesn't get
      // stranded in 'solving' with no viewer.
      for (const [id, detach] of viewers) {
        try { await detach(); } catch { /* noop */ }
        registry.removeViewer(id);
        registry.setWaitingAgain(id);
      }
      viewers.clear();
    });

    ws.on('error', () => { /* ignore socket errors, close handler cleans up */ });
  });

  console.log(`[Captcha] WebSocket takeover endpoint ready at ${WS_PATH}`);
  return wss;
}

module.exports = { initCaptchaWs };
