/* CrawlKomik admin — small progressive enhancements shared by every page.
   Everything here is optional: forms and links keep working without JavaScript. */
(function () {
  'use strict';

  // ---------- Toasts ----------
  function toastContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toastContainer';
      c.className = 'toast-container position-fixed bottom-0 end-0 p-3';
      document.body.appendChild(c);
    }
    return c;
  }

  const TOAST_ICON = { success: 'check-circle-fill', danger: 'exclamation-octagon-fill', warning: 'exclamation-triangle-fill', info: 'info-circle-fill' };

  function toast(text, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type} border-0`;
    el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
    const closeClass = type === 'warning' || type === 'info' ? 'btn-close' : 'btn-close btn-close-white';
    el.innerHTML = '<div class="d-flex"><div class="toast-body"><i class="bi me-2"></i><span></span></div>' +
      `<button type="button" class="${closeClass} me-2 m-auto" data-bs-dismiss="toast" aria-label="Tutup"></button></div>`;
    el.querySelector('.bi').classList.add('bi-' + (TOAST_ICON[type] || TOAST_ICON.info));
    el.querySelector('span').textContent = text;
    toastContainer().appendChild(el);
    showToast(el, type);
  }

  function showToast(el, type) {
    if (!window.bootstrap) { el.classList.add('show'); return; }
    const t = new bootstrap.Toast(el, { autohide: type !== 'danger', delay: 5000 });
    el.addEventListener('hidden.bs.toast', () => el.remove());
    t.show();
  }

  window.ck = { toast };

  // Server-rendered flash messages (see partials/flash.ejs)
  document.querySelectorAll('.toast[data-autoshow]').forEach((el) => showToast(el, el.dataset.type));

  // Drop ?ok= / ?err= from the address bar so a refresh doesn't repeat the message
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('ok') || url.searchParams.has('err')) {
      url.searchParams.delete('ok');
      url.searchParams.delete('err');
      history.replaceState(null, '', url.pathname + (url.searchParams.toString() ? '?' + url.searchParams : '') + url.hash);
    }
  } catch (e) { /* old browser */ }

  // ---------- Theme toggle (initial theme is applied inline in <head>) ----------
  function setTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    try { localStorage.setItem('ck-theme', theme); } catch (e) { /* private mode */ }
    document.querySelectorAll('[data-theme-icon]').forEach((i) => {
      i.className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';
    });
    document.querySelectorAll('[data-theme-label]').forEach((s) => {
      s.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    });
  }
  setTheme(document.documentElement.getAttribute('data-bs-theme') || 'dark');
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-theme-toggle]')) {
      setTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark');
    }
  });

  // ---------- Confirmations: <form data-confirm="…"> / <button data-confirm="…"> ----------
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const submitter = e.submitter;
    const msg = (submitter && submitter.dataset.confirm) || form.dataset.confirm;
    if (msg && !window.confirm(msg)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ---------- Copy to clipboard: data-copy="text" or data-copy-target="#selector" ----------
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    // Plain-HTTP admin panels have no Clipboard API — fall back to a hidden textarea
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (err) { reject(err); }
      ta.remove();
    });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy], [data-copy-target]');
    if (!btn) return;
    e.preventDefault();
    let text = btn.dataset.copy;
    if (btn.dataset.copyTarget) {
      const src = document.querySelector(btn.dataset.copyTarget);
      text = src ? (src.value !== undefined ? src.value : src.textContent) : '';
    }
    copyText(text || '').then(() => toast('Disalin ke clipboard')).catch(() => toast('Gagal menyalin — salin manual', 'warning'));
  });

  // ---------- Show/hide password: <button data-toggle-password="#id"> ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-password]');
    if (!btn) return;
    const input = document.querySelector(btn.dataset.togglePassword);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    const icon = btn.querySelector('.bi');
    if (icon) icon.className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
  });

  // ---------- UTC timestamps → viewer's local time: <time data-utc="2026-01-01 10:00:00"> ----------
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function relative(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'baru saja';
    if (s < 3600) return Math.floor(s / 60) + ' menit lalu';
    if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
    return Math.floor(s / 86400) + ' hari lalu';
  }
  document.querySelectorAll('[data-utc]').forEach((el) => {
    const raw = el.getAttribute('data-utc');
    if (!raw) return;
    const d = new Date(/^\d+$/.test(raw) ? Number(raw) : raw.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z'));
    if (isNaN(d)) return;
    el.textContent = el.hasAttribute('data-relative') ? relative(d.getTime()) : fmt.format(d);
    el.title = d.toLocaleString() + ' (' + relative(d.getTime()) + ')';
  });

  // ---------- JSON fields: <textarea data-json="object|array"> ----------
  function checkJson(field) {
    const kind = field.dataset.json;
    const status = document.querySelector(`[data-json-status-for="${field.id}"]`);
    const text = field.value.trim();
    let error = null;
    if (text) {
      try {
        const v = JSON.parse(text);
        if (kind === 'array' && !Array.isArray(v)) error = 'harus berupa array [ … ]';
        if (kind === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) error = 'harus berupa object { … }';
      } catch (err) {
        error = err.message;
      }
    }
    field.classList.toggle('is-invalid', !!error);
    if (status) {
      status.className = 'json-status badge ' + (error ? 'text-bg-danger' : 'text-bg-success');
      status.textContent = error ? 'JSON tidak valid' : 'JSON valid';
      status.title = error || '';
    }
    let fb = field.parentElement.querySelector('.invalid-feedback[data-json-error]');
    if (!fb) {
      fb = document.createElement('div');
      fb.className = 'invalid-feedback';
      fb.setAttribute('data-json-error', '');
      field.insertAdjacentElement('afterend', fb);
    }
    fb.textContent = error ? 'JSON tidak valid: ' + error : '';
    return !error;
  }
  document.querySelectorAll('textarea[data-json]').forEach((field) => {
    checkJson(field);
    field.addEventListener('input', () => checkJson(field));
    field.addEventListener('change', () => checkJson(field)); // value set by a visual editor
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-json-format]');
    if (!btn) return;
    const field = document.getElementById(btn.dataset.jsonFormat);
    if (!field) return;
    try {
      field.value = JSON.stringify(JSON.parse(field.value || (field.dataset.json === 'array' ? '[]' : '{}')), null, 2);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) {
      toast('Tidak bisa dirapikan: JSON tidak valid', 'warning');
    }
  });
  // Block submitting a form with broken JSON — the server would reject it anyway
  document.addEventListener('submit', (e) => {
    const bad = Array.from(e.target.querySelectorAll('textarea[data-json]')).find((f) => !checkJson(f));
    if (bad) {
      e.preventDefault();
      bad.focus();
      toast('Perbaiki JSON yang tidak valid dulu', 'danger');
    }
  });

  // ---------- Unsaved-changes guard: <form data-dirty-guard> ----------
  document.querySelectorAll('form[data-dirty-guard]').forEach((form) => {
    const mark = () => form.classList.add('is-dirty');
    form.addEventListener('input', mark);
    form.addEventListener('change', mark);
  });
  // Registered after the JSON check above, so a blocked submit keeps the form dirty
  document.addEventListener('submit', (e) => {
    if (!e.defaultPrevented && e.target.matches('form[data-dirty-guard]')) e.target.classList.remove('is-dirty');
  });
  window.addEventListener('beforeunload', (e) => {
    if (document.querySelector('form[data-dirty-guard].is-dirty')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- Auto-submit filters: <select data-autosubmit> ----------
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-autosubmit]') && e.target.form) e.target.form.submit();
  });

  // ---------- Close the mobile sidebar after picking a link ----------
  document.querySelectorAll('#sidebar a.nav-link').forEach((a) => {
    a.addEventListener('click', () => {
      const oc = window.bootstrap && bootstrap.Offcanvas.getInstance(document.getElementById('sidebar'));
      if (oc) oc.hide();
    });
  });
})();
