# Lessons Learned

## 2026-03-04 - API

**Mistake**: Sanitized API error messages to generic "Internal server error", hiding useful `err.message` from consumers
**Pattern**: Over-securing error responses when the error details are needed for debugging by API consumers
**Rule**: Keep `err.message` in API error responses — this project's API consumers need actionable error messages (e.g. "Website X not found", "No config for Y"). Only hide errors on admin/HTML pages, not API JSON responses.
**Applied**: Global error handler in `src/app.js`, all catch blocks in `src/routes/api.js`

---

## 2026-03-04 - Tooling

**Mistake**: `entrypoint.sh` COPY'd into Docker image caused `exec: no such file or directory` at runtime
**Pattern**: Shell scripts created on Windows or by tools may have invisible CRLF line endings. The `\r` in `#!/bin/sh\r` makes the kernel unable to find the interpreter. Also, stale Docker build cache can skip the COPY layer.
**Rule**: Always strip CRLF in Dockerfile after COPY for shell scripts: `RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh`. Rebuild with `--no-cache` when debugging entrypoint issues.
**Applied**: All shell scripts COPY'd into Docker images (`entrypoint.sh`, etc.)

---

## 2026-03-04 - Security

**Mistake**: Helmet CSP with strict directives blocked Bootstrap CSS/JS/fonts from cdn.jsdelivr.net, breaking admin panel login page. Rate limiter with `max: 5` and plain text `message` returned raw text instead of rendered login page when triggered.
**Pattern**: Over-restrictive security defaults that break functionality. CSP with CDN-dependent apps needs careful tuning or should be disabled if the app is internal. Rate limiter responses should match the app's UI (render EJS, not raw text).
**Rule**: (1) For admin panels that load assets from CDN, disable CSP or carefully whitelist all resource types. Test login after enabling helmet. (2) Rate limiter `handler` should render the proper page template, not return raw `message` string. (3) Use `max: 10` minimum for login to avoid blocking legitimate users.
**Applied**: `src/app.js` helmet config, `src/routes/admin.js` loginLimiter

---

## 2026-03-04 - Crawler

**Mistake**: `komik_detail` result field `status_komik` didn't match selector key `status`, so `checkRequired` checked `result['status']` = `'success'` (always truthy) instead of `result['status_komik']`. Required validation silently passed even when `status_komik` was empty.
**Pattern**: When result field names differ from selector key names (e.g. to avoid clashing with API-level fields like `status`), `checkRequired` will check the wrong field.
**Rule**: When result field name differs from selector key name, map the selector key → result field before calling `checkRequired`. Audit all crawl functions when adding new fields.
**Applied**: `src/services/crawler.js` `crawlKomikDetail()` — `mappedRequired` object maps `status` → `status_komik`

---

## 2026-03-04 - Image Proxy

**Mistake**: Used browser-side `page.evaluate(fetch(url))` to download images from CDN. CDN servers block cross-origin fetch (CORS), causing all images to fail silently. Then fell back to original URLs, hiding the failure from API consumers.
**Pattern**: Browser `fetch()` inside Puppeteer `page.evaluate()` is subject to CORS. CDN image servers often reject cross-origin requests. Falling back to original URLs silently hides failures.
**Rule**: (1) Use Node.js `http/https.get()` with `Referer` header to download images server-side — no CORS restrictions. Keep browser fetch only for `blob:` URLs. (2) Never silently fall back to original URLs — throw error so API consumer knows something failed. (3) Always verify DB state when debugging "I enabled X but it doesn't work" — the value may not have been saved.
**Applied**: `src/services/image-proxy.js` — Node.js download + retry + throw on failure

---

## 2026-03-05 - Forms

**Mistake**: Config form error handler hardcoded `actions: [], regexRules: [], selectorsRequired: {}` when re-rendering after validation error, wiping all field values.
**Pattern**: Error handlers that re-render forms must preserve user data. If form data can't be parsed (that's why the error happened), fall back to last saved state from DB.
**Rule**: On form validation error, reload complex fields (JSON textareas) from database instead of hardcoding empty values. Pass back simple fields from `req.body`.
**Applied**: `src/routes/admin.js` POST config save error handler

---

## 2026-07-24 - Feature Parity

**Mistake**: `crawlCustom()` (custom page types) never ran the image proxy/cache, so enabling "Image Proxy" on a website silently did nothing for custom page types. Also found `crawlKomikDetail` never resolved a relative cover URL to absolute, breaking the `node` and `proxy` cache methods.
**Pattern**: When adding a generic/custom variant of an existing feature, cross-cutting behaviour that lives in the built-in implementations (image proxy, relative→absolute URL resolution, regex replace) does not come along for free. The custom path silently loses it — no error, just missing behaviour.
**Rule**: When adding a new page type / generic handler, audit every built-in crawl function for cross-cutting steps and port each one. Write a test that runs the SAME assertions against both the built-in and the custom path (a baseline check on the built-in path is what exposed the second bug here).
**Applied**: `src/services/crawler.js` — `proxyCustomFieldImages()` wired into `crawlCustom`, `toAbsoluteUrl()` applied to the cover image in `crawlKomikDetail`

---

## 2026-10-03 - Resource Cleanup

**Mistake**: Chrome's temp profile was deleted on the browser's `disconnected` event with `fs.rm(dir, …, () => {})`. The CDP socket closes while Chrome is still writing `Local State`/`Preferences` on shutdown, so the rm lost the race (ENOTEMPTY) and the swallowed error hid it — every crawl leaked its `/tmp/crawlkomik-*` dir until the server died with `ENOSPC ... mkdtemp`.
**Pattern**: "Connection closed" ≠ "process exited". Cleanup that races a still-running child, plus an empty error callback, turns a one-line bug into a slow disk leak nobody notices until production breaks. Launch failures and restarts were further leak paths.
**Rule**: (1) Delete a child process's files only after its `exit` event, with retries for ENOTEMPTY/EBUSY. (2) Never swallow cleanup errors silently — log them. (3) Anything written to /tmp needs a sweep at startup for leftovers from crashes/restarts. (4) Test cleanup by counting leftovers after N real runs in ONE long-lived process — not just "it ran once".
**Applied**: `src/services/profile-dirs.js`, `src/services/browser.js` `getBrowser()`, startup/periodic sweep in `src/app.js`

---

## 2026-03-20 - Feature Scope

**Mistake**: When user asked for "custom config", implemented only custom JSON response fields. User actually wanted custom page types (new config types + API endpoints), not just custom fields within existing configs.
**Pattern**: "Custom config" can mean different scopes — custom fields within existing config vs entirely new config types. Don't assume the narrower scope.
**Rule**: When user says "custom config", clarify: (1) custom fields within existing page types, or (2) entirely new page types with their own API endpoints. Ask if ambiguous. Consider both dimensions of customization.
**Applied**: Implemented both — custom_fields for extra fields + custom_page_types for new config types with `/api/custom/:pageType`
