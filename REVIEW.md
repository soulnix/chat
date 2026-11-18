# SoulNix Chat — Code Review & Fix Report

Reviewed: complete codebase (app.js, chat.js, auth.js, crypto.js, status.js,
config.js, index.html, setup.html, style.css, supabase_setup.sql — ~2,600 lines).

Overall: the architecture is genuinely good. Client-side ECDH P-256 +
AES-256-GCM, PBKDF2-wrapped private keys, per-chat keys, two-row message
copies, per-owner RLS, `security definer` RPCs for receipts, XSS-safe DOM
building everywhere (`textContent`, no `innerHTML` with user data). Most
hobby chat apps get these wrong; you got them right. The issues below are
real bugs and gaps found on top of that, all fixed in this folder.

---

## CRITICAL (would break the app or expose accounts)

### 1. Large photo/video encryption crashed — `crypto.js`
`bufToB64()` used `String.fromCharCode(...new Uint8Array(buf))`. Spreading
megabytes of bytes into one function call exceeds the JavaScript engine's
call-stack limit. Verified by test: the old code **throws "Maximum call
stack size exceeded" on a 1 MB buffer**, so almost every photo and every
video under your own 15 MB / 50 MB caps would fail to encrypt and send.
**Fix:** chunked conversion (32 KB per call), output byte-identical,
handles 15 MB without issue.

### 2. `setup.html` with working credentials was deployable — `public/setup.html`
It contained `pawan` / `manu` and the passphrase `test12345` **in the
deployed folder**. The README said "delete it after use", but one forgotten
drag-and-drop = anyone who visits `/setup.html` owns both accounts. A
secret that must be manually deleted is not a secret.
**Fix:** moved to the project root (outside `public/`, so it can never ship),
added a red warning banner, updated the README to say to run it locally.

### 3. One dead media file broke the entire chat — `chat.js`
`fetchHistory()` did `decryptRow(await ensureOwnMediaFile(row))` with no
error handling. If the sender's encrypted file had already been deleted
(auto-delete after 10 min) while your copy was still unreadable, the
download threw and **the whole conversation failed to open**.
**Fix:** new `decryptRowSafe()` — per-row fallback that renders
"[media unavailable]" with the decrypted caption and keeps the chat open.
Also used for realtime incoming messages.

### 4. Corrupt localStorage bricked the app — `chat.js`
`JSON.parse(localStorage.getItem(...) || '[]')` throws on corrupt JSON, and
that call sat inside `fetchRecentChats()`, `rememberContact()` (runs when
opening any chat) and `clearConversation()`. One bad write = permanent
"Could not load recent chats" and no chat could be opened at all.
**Fix:** `readSavedContacts()` / `writeSavedContacts()` helpers that degrade
to an empty list instead of throwing.

---

## HIGH (wrong behavior / data exposure)

### 5. The receiver's auto-delete setting was ignored — `supabase_setup.sql`
`send_chat_message_copies` stamped the **sender's** 10-minute `delete_at`
onto the **receiver's** copy too. If you sent with auto-delete ON, unread
messages vanished from her inbox after 10 minutes even if she had turned
auto-delete OFF for that chat. Your own README even apologized for it
("A sender's already scheduled expiration can still remove an unread copy").
**Fix:** the RPC now looks up the receiver's `chat_preferences` (only a
boolean, never plaintext) and leaves her copy's `delete_at` NULL when she
has auto-delete off. Sender behavior unchanged. **You must re-run
`supabase_setup.sql` in the Supabase SQL Editor to pick this up.**

### 6. Sent messages were lost on failure — `app.js`
`$('#msg-input').value = ''` happened *before* the send; on any network
error the typed text was gone forever.
**Fix:** text is restored into the input when a send fails.

### 7. Send/attach during chat load crashed or misfired — `app.js`
Pressing send while a conversation was still loading hit a `null` crypto
key. Also double-tapping a chat loaded it twice (duplicate bubbles possible).
**Fix:** guards on `loadingChat` / conversation key, a send debounce, and a
double-tap guard in `enterChat()`.

### 8. Status videos were cut off at 5 seconds — `app.js`
The status viewer auto-advanced every 5 s regardless of content, killing
any video mid-play. **Fix:** video statuses now play to their end
(`onended` advances); text/image still advance after 5 s.

### 9. Storage leaks on a 1 GB free tier — `chat.js`
"Clear chat" deleted message rows but **never** the encrypted media files
in your storage folder; changing a chat background orphaned every previous
background file. **Fix:** both paths now remove the corresponding files
(best-effort, never blocking the UI action).

---

## MEDIUM (hardening & polish)

10. **No session restore** — the Supabase session was stored in
    sessionStorage but never checked on load, so every refresh forced a
    full re-login. Now the username is pre-filled from the still-valid
    session (passphrase still required to unwrap the key — that part of
    your design is correct and untouched).
11. **Supply-chain + transport hardening** — supabase-js was loaded from a
    floating `@2` URL with no integrity check; there were no security
    headers at all. Now: pinned `@2.119.0` with a verified
    subresource-integrity hash (hash computed from the actual file — the
    pinned build is byte-identical to the floating one), and `noindex`
    (a private app shouldn't be in search engines). Inline `onclick`
    handlers were moved to JS listeners so the CSP can forbid inline
    script. CSP is delivered as a meta tag in `index.html` plus a
    frame-buster, since GitHub Pages (unlike Netlify) cannot set HTTP
    response headers — verified by inspecting live github.io responses.
12. **Passphrase too short for its threat model** — signup allowed 6
    characters while the wrapped key blob is readable by anyone holding the
    anon key (profiles are public by design), so 6-char passphrases are
    brute-forceable offline. Signup now requires 8+. Login untouched, so
    existing accounts keep working. (PBKDF2 iterations are 250k — below
    current OWASP guidance of ~600k — but changing that would silently
    lock out existing accounts, so it is deliberately left alone.)
13. **Statuses RLS too loose** — the UPDATE policy let the *owner* update
    status rows too, and INSERT allowed posting a status to yourself.
    Tightened to viewer-only updates and `viewer_id <> owner_id`.
14. **Home realtime channel stayed live inside a chat** — every message
    triggered a duplicate recent-chats refetch and a duplicate
    delivered-receipt RPC. Now paused while in a chat, resumed on back.
15. **Toast overlap, redundant ternary, a11y** — rapid toasts cancelled
    each other; `i === index ? '0%' : '0%'` was dead code; the viewport's
    `maximum-scale=1` blocked pinch-zoom (accessibility fail). Fixed.
16. **Auth form** — inputs now have `required`; passphrase field switches
    `autocomplete` between `current-password` / `new-password` per tab.
17. **Clearer failure paths** — signup that creates the auth user but fails
    the profile insert now explains what happened instead of a raw DB error.

---

## Deliberately NOT changed (and why)

- **PBKDF2 iteration count** — raising it changes derived keys and would
  lock existing accounts out of their histories. If you ever want it, it
  needs a re-wrap-on-login migration.
- **Two-copy message design, storage RLS shape, synthetic `@gmail.com`
  identities** — sound as they are.
- **Username enumeration via signup** — inherent to a username-only app
  with 2 users; not worth extra complexity.

## To deploy these fixes

1. Supabase SQL Editor: re-run the updated `supabase_setup.sql` (safe to
   re-run) — picks up fix #5 and #13.
2. GitHub Pages: upload the project (site files are in `docs/`) and set
   Settings → Pages → Deploy from branch `main`, folder `/docs`.
   Note: GitHub Pages sends no HTTP security headers, so the CSP is a
   meta tag in `docs/index.html` and a frame-buster in `js/app.js`
   covers the header-only directives; `.nojekyll` is included.
3. Browsers: hard-refresh (Ctrl+Shift+R) both phones so old JS is dropped.
