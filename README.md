# SoulNix Chat — setup guide

A static, end-to-end encrypted 1:1 chat app with disappearing
messages, recent chats, and 24-hour status updates. No email/phone
signup. Deploys to GitHub Pages; backend is Supabase (free tier).
The recent-chat list is saved in each browser and also rebuilt from
available message records.

## What "end-to-end encrypted" means here

- Each account gets an ECDH keypair generated in the browser.
- Your private key is encrypted with a key derived from your
  passphrase (PBKDF2) before it's ever sent anywhere — the server
  only ever stores that encrypted blob, never your passphrase or
  raw private key.
- When you chat with someone, your browser combines your private
  key with their public key to get a shared encryption key
  (standard ECDH). Messages, shared media, and chat backgrounds are
  encrypted with that key before upload.
- Chat backgrounds are encrypted with that conversation key and
  shared with both people in the chat. Profile pictures are not
  end-to-end encrypted; they are visible to signed-in users.
- There is **no password reset**. If you forget your passphrase,
  that account's message history cannot be recovered — this is the
  trade-off for not using a real email address.
- Supabase auth sessions are isolated per browser tab, so test
  accounts opened in different tabs do not replace each other's login.

## Retention, explained honestly

Each message is stored as two copies — one for the sender, one for
the receiver. Auto-delete is configurable per chat. When enabled
for the sender, sent messages are scheduled to disappear after 10
minutes; incoming copies follow the receiver's own chat setting:
if the receiver turned auto-delete ON, an unread copy expires 10
minutes after it was sent, and that deadline is pushed to 10
minutes from the moment it is read. If the receiver turned
auto-delete OFF for that chat, their unread copies are kept (the
sender's copies still disappear on the sender's side). The
Settings screen controls the default for chats without an override.
A chat's three-dot menu can clear its message history for the
current account; the other participant's message copies are not
deleted, and clearing also removes the encrypted media files from
the current account's storage folder. Encrypted media files are
retained so the other account's copy can keep working when it
still references the same file.
The bottom bar splits the app into two tabs, like WhatsApp mobile:
**Chats** and **Status**. On the Chats tab you see only your
conversations, each showing the other person's name with their
presence underneath ("online" or "last online ..."), plus unread
badges. On the Status tab, tapping **My status** opens the composer —
a text status by default; if you attach a photo or video, whatever
you typed becomes its optional caption, and you can see who viewed
your updates. Updates are shared with all of your chat partners at
once and expire after 24 hours; the viewer plays each update for 15
seconds with tap navigation, and you can reply to a partner's status
right into your chat with them.

In chats, sent messages show WhatsApp-style ticks (✓ sent,
✓✓ delivered, blue ✓✓ read; tap for exact times), date separators
between days, a live "typing…" indicator, and a long-press menu on
any message with Reply, React (double-tap a bubble for ❤️), Copy,
Star, Forward, and Delete-for-me. Starred messages are collected on
their own screen, and chats can be searched. The composer has an
emoji picker, a camera button that takes photos directly, and a mic
that records voice notes when the text box is empty. Photos open in
a full-screen viewer, pasted links become tappable, and soft sounds
play for sent/received messages (mutable in Settings). Chats can be
pinned, muted, and archived; the app has a dark mode; and Settings
lets you set a display name and bio that replace your username
where shown. Avatars without a photo get a unique gradient color.
The app is also a PWA: open it in a mobile browser and "Add to Home
Screen" installs it like a native app with its own icon. (Browser
notifications were intentionally left out.)

A media message whose encrypted file has already been removed from
storage (for example by the sender's auto-delete) shows a
"[media unavailable]" note with its decrypted caption instead of
breaking the whole chat load.

---

## Part 1 — Create your Supabase project

1. Go to **supabase.com**, sign up free, click **New Project**.
2. Pick a name, set a database password (save it), choose a region
   close to you (e.g. Mumbai/Singapore).
3. Wait ~2 minutes for provisioning.
4. Go to **Project Settings → API**. Copy:
   - **Project URL**
   - **anon public key**
5. Go to **SQL Editor**, paste the entire contents of
   `supabase_setup.sql` (included in this folder), click **Run**.
   This creates the tables, security rules, and the encrypted
   media storage bucket.
   If you already set up an earlier version, run the updated script
   again — it is safe to re-run. The current version adds the
   `message_reactions` table, the `starred` column and voice-note
   ('audio') support on `messages`, the `auto_delete_minutes`
   per-chat duration, and the `display_name`/`bio` profile columns.
   It also updates the `send_chat_message_copies` function and adds
   reactions to the realtime publication.
6. Go to **Authentication → Providers → Email** and turn **off**
   "Confirm email" (since the emails are synthetic/fake, there's
   nothing to confirm). This is under Authentication → Settings in
   some Supabase versions — look for "Enable email confirmations"
   and switch it off.

## Part 2 — Configure the app

1. Open `docs/js/config.js`.
2. Replace `SUPABASE_URL` and `SUPABASE_ANON_KEY` with the values
   from step 4 above. (The anon key is meant to be public — that's
   fine to leave in the code.)

## Part 3 — Deploy to GitHub Pages

The site files live in the **`docs/`** folder — GitHub Pages can
serve straight from it, and `setup.html` / `supabase_setup.sql`
stay at the project root, outside `docs/`, so they can never be
published. The empty `.nojekyll` file inside `docs/` tells GitHub
to serve the folder as-is (no Jekyll processing).

1. Create a **GitHub** account, then a **new public repository**
   (e.g. `soulnix-chat`). Note: GitHub Pages on the free plan
   requires a public repo — your code becomes visible. That is OK
   by design: the anon key is meant to be public, everything
   sensitive is encrypted client-side, and `setup.html` is not in
   `docs/`.
2. Upload the **whole project folder's contents** to the repo
   (Code → Add file → Upload files, drag everything: `docs/`,
   `README.md`, `supabase_setup.sql`; `setup.html` may be uploaded
   too since it sits outside `docs/` and is never served — or leave
   it out entirely, which is even better).
3. **Settings → Pages** → Source: *Deploy from a branch* →
   Branch: `main`, Folder: **`/docs`** → Save.
4. Wait 1–2 minutes. Your site is live at
   `https://<your-username>.github.io/<repo-name>/` — share this
   with your girlfriend. It never changes, so bookmark it.
5. On the same Settings → Pages screen, make sure **Enforce HTTPS**
   is ticked (usually automatic on `github.io`). The app's
   encryption only runs on HTTPS — Web Crypto and camera-safe APIs
   are disabled on plain HTTP.
6. To update later: upload the changed files again (same repo).
   GitHub Pages caches for up to 10 minutes, so give it a moment,
   then hard-refresh (Ctrl+Shift+R) on both phones.

## Part 4 — Try it

1. Open the site. Create an account for yourself (pick a username
   + a passphrase of **8+ characters** — shorter ones are rejected
   on signup because the encrypted key blob it protects is
   readable by anyone holding the public anon key, so a short
   passphrase could be brute-forced offline). Existing accounts
   with shorter passphrases keep working at login.
2. Have her open the same link and create her own account.
3. Either of you types the other's username and taps **Chat**.
4. In **Settings**, choose the default auto-delete behavior for new
   chats. You can override it for each conversation from the chat's
   three-dot menu.
5. Optional one-time test accounts: open `setup.html` locally in a
   browser (File → Open, NOT from the deployed URL). It creates the
   two demo accounts. It is kept outside `docs/` precisely so it
   never ships with the site.

## Limits to know about (free tier)

- ~1 GB total storage, ~2 GB bandwidth/month on Supabase free tier.
  Fine for two people; videos will eat into this faster than photos.
- Media caps in the app: images 15 MB, videos 50 MB (edit the
  numbers in `docs/js/app.js` if you want different limits).
- No message search, no multi-device sync of history beyond what
  each account retains, no group chats — this was built specifically
  for one 1:1 conversation.

## If something breaks

- **"Wrong username or passphrase"** on login that should work:
  double check Step 6 above (email confirmation must be off, or
  signup/login won't complete).
- **Realtime messages don't arrive live:** confirm the SQL script's
  final two lines ran (`alter publication supabase_realtime add
  table ...`) — rerun the script if unsure, it's safe to rerun.
- **Media won't upload:** check the file size caps above, and that
  the `encrypted-media` bucket was created (Supabase dashboard →
  Storage).
- **App shows a blank/broken page after an update:** the
  Content-Security-Policy (meta tag in `docs/index.html`) may be
  blocking something you just added. Open the browser console
  (F12) — CSP violations are printed there in red.
- **Site doesn't update right away:** GitHub Pages caches for up
  to 10 minutes; hard-refresh with Ctrl+Shift+R (or clear the tab).

## What changed in this version

- **26 new features** (all except browser notifications, by choice):
  WhatsApp-style ticks, typing indicator, unread badges, date
  separators, reply-to-message, emoji reactions, long-press message
  menu (copy/star/forward/delete), chat search, voice notes, photo
  viewer, emoji picker, camera capture, link chips, editable profile
  (display name + bio), gradient avatars, pin/mute/archive chats,
  dark mode, send/receive sounds, status viewers list, reply-to-status,
  per-chat auto-delete durations (10 min / 1 h / 24 h), starred
  messages, and PWA install support — plus the mobile viewport fix
  (100dvh) that stops the message field from hiding behind the
  browser's URL bar on real phones.
- Previous bug-fix release notes below.

- WhatsApp-style layout: a bottom bar with **Chats** and **Status**
  tabs; the header shows only your username (no app name); chat
  rows show presence ("online" / "last online ...") under the
  username instead of the old "@username - date" line.
- Status revamp: the Status tab has a "My status" row that opens a
  composer (text status by default; attaching a photo/video turns
  the text into an optional caption), updates are shared with all
  chat partners at once, and the viewer plays each update for
  15 seconds with progress bars and tap navigation.
- `crypto.js`: base64 conversion is chunked — encrypting a large
  photo or video no longer crashes with "Maximum call stack size
  exceeded" (this broke most media at the old 15/50 MB caps).
- One broken media file no longer fails the entire chat history
  load; it renders as "[media unavailable]" with its caption.
- A corrupt saved-chat list in localStorage no longer breaks the
  home screen or opening chats; it resets safely.
- A failed text send puts your typed message back in the input
  instead of losing it; sends are debounced; double-tapping a chat
  no longer loads it twice; toasts no longer cut each other off.
- Refreshing the page now pre-fills your username if your session
  is still valid (passphrase still required — by design).
- Chat screen pauses the home realtime channel (less duplicate
  work and duplicate receipt RPCs).
- Clearing a chat now also deletes that account's encrypted media
  files; replacing a chat background deletes the old one.
- Signup requires an 8+ character passphrase; login is unchanged.
- Security hardening: Content-Security-Policy as a meta tag
  (GitHub Pages can't set HTTP headers), a frame-buster against
  clickjacking, supabase-js pinned to an exact version with a
  subresource-integrity hash, `noindex` on the page, and inline JS
  handlers removed so the CSP holds. The site lives in `docs/`
  with a `.nojekyll` file, so `setup.html` can never be published.
- SQL: each account's auto-delete preference now applies to its own
  message copy; status rows can be updated only by their viewer,
  and a status can't target yourself.
