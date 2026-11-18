(function () {
  // GitHub Pages cannot send anti-clickjacking headers (X-Frame-Options /
  // frame-ancestors), so refuse to run embedded in another page instead.
  if (window.top !== window.self) { window.top.location = window.location; }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: window.sessionStorage, storageKey: 'soulnix-auth-token' },
  });
  SoulAuth.init(supabase);
  SoulUI.init();

  // PWA: register the service worker so "Add to Home Screen" works.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }

  let currentPartnerProfile = null;
  let currentPartnerNickname = '';
  let currentChatAutoDelete = true;
  let chatBackgroundUrl = null;
  let loadingChat = false;
  const queuedChatMessages = [];
  const renderedMessageGroups = new Set();
  const messageRowsByGroup = new Map();
  const messageDataByGroup = new Map();
  const pendingMessageReceipts = new Map();
  let statusRenderId = 0;
  let statusViewerToken = 0;
  let activeTab = 'chats';
  let presenceTimer = null;
  let composerMedia = null;
  let composerBg = 'grape';
  const STATUS_DURATION_MS = 15000;
  const STATUS_BG = {
    grape: 'linear-gradient(135deg, #7B68EE, #4C4189)',
    teal: 'linear-gradient(135deg, #0FA3A3, #086969)',
    sunset: 'linear-gradient(135deg, #FF7E5F, #B3413B)',
    forest: 'linear-gradient(135deg, #38A169, #1D5E3F)',
    night: 'linear-gradient(135deg, #2D3748, #12161F)',
  };
  const REACTION_SET = ['❤️', '😂', '😮', '😢', '👍', '👎'];

  // ---- feature state ----
  let replyTo = null;                // quote being replied to: { g, s, k, status }
  let reactionsByGroup = new Map();  // groupId -> [{ reactorId, emoji }]
  let ownGroupsCache = [];           // my own status groups (for the My status viewer)
  const chatFlags = {};              // partnerId -> { pinned, muted, archived }
  let archivedShown = false;
  let currentChatMinutes = AUTO_DELETE_MINUTES;
  let typingResetTimer = null;
  let statusReplyContext = null;     // pending "reply to status" prefill
  let recording = false;
  let cameraFacing = 'environment';
  let lastBubbleDay = null;  // current day label shown in the chat, for date separators

  function loadChatFlags() {
    try {
      const raw = JSON.parse(localStorage.getItem(`soulnix-flags:${SoulAuth.current().user.id}`) || '{}');
      if (raw && typeof raw === 'object') Object.assign(chatFlags, raw);
    } catch (_) { /* flags are cosmetic */ }
  }
  function saveChatFlags() {
    try { localStorage.setItem(`soulnix-flags:${SoulAuth.current().user.id}`, JSON.stringify(chatFlags)); } catch (_) { /* ignore */ }
  }
  function flagFor(partnerId) { return chatFlags[partnerId] || (chatFlags[partnerId] = {}); }

  async function fetchBlob(path) {
    const { data } = await supabase.storage.from('encrypted-media').download(path);
    return data || null;
  }

  function durationLabel(minutes) {
    if (minutes >= 1440) return '24 hours';
    if (minutes >= 60) return `${minutes / 60} hour${minutes > 60 ? 's' : ''}`;
    return `${minutes} min`;
  }
  function snippetOf(message) {
    if (message.kind === 'text') return (message.text || '').slice(0, 80) || 'Message';
    if (message.kind === 'image') return message.caption || 'Photo';
    if (message.kind === 'video') return message.caption || 'Video';
    if (message.kind === 'audio') return 'Voice message';
    return 'Message';
  }

  const $ = (sel) => document.querySelector(sel);
  function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(id).classList.add('active'); }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function showSpinner(show) { $('#spinner').classList.toggle('show', show); }
  function initials(username) { return (username || '?').slice(0, 2).toUpperCase(); }

  // ---- presence ("last online") ----
  // A persisted heartbeat: the chat list reads profiles.last_seen_at, so
  // the partner's app must keep refreshing it while the tab is open.
  async function updatePresence() {
    const session = SoulAuth.current();
    if (!session) return;
    try {
      await supabase.from('profiles')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', session.user.id);
    } catch (_) { /* presence is best-effort */ }
  }
  function startPresence() {
    updatePresence();
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(() => {
      if (document.visibilityState === 'visible') updatePresence();
    }, 30000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && SoulAuth.current()) updatePresence();
  });

  function fmtRelative(iso) {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  function presenceLabel(lastSeenAt) {
    if (!lastSeenAt) return 'offline';
    const online = Date.now() - new Date(lastSeenAt).getTime() < 65000;
    return online ? 'online' : `last online ${fmtRelative(lastSeenAt)}`;
  }

  function loadAvatarInto(container, path, username) {
    container.innerHTML = path ? '<img alt="">' : initials(username);
    if (!path) return;
    supabase.storage.from('encrypted-media').download(path).then(({ data }) => {
      const image = container.querySelector('img');
      if (data && image) image.src = URL.createObjectURL(data);
    }).catch(() => { /* avatar is decorative here */ });
  }

  // ---- session restore ----
  // The Supabase session survives a page reload in sessionStorage, but the
  // app never looked at it, so every refresh dropped you back on the login
  // screen. We can't decrypt anything without the passphrase (by design),
  // but we CAN prefill the username and jump straight to the passphrase.
  (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      const { data: profile } = await supabase.from('profiles')
        .select('username').eq('id', session.user.id).maybeSingle();
      if (profile) {
        $('#auth-username').value = profile.username;
        $('#auth-passphrase').focus();
        toast('Welcome back — enter your passphrase to unlock.');
      }
    } catch (_) { /* restore is best-effort; the login form still works */ }
  })();

  // ===================== AUTH =====================
  let authMode = 'login';
  $('#tab-login').onclick = () => { authMode = 'login'; $('#tab-login').classList.add('active'); $('#tab-signup').classList.remove('active'); $('#auth-submit').textContent = 'Log in'; $('#auth-passphrase').setAttribute('autocomplete', 'current-password'); };
  $('#tab-signup').onclick = () => { authMode = 'signup'; $('#tab-signup').classList.add('active'); $('#tab-login').classList.remove('active'); $('#auth-submit').textContent = 'Create account'; $('#auth-passphrase').setAttribute('autocomplete', 'new-password'); };

  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#auth-error').textContent = ''; showSpinner(true);
    try {
      const session = authMode === 'signup' ? await SoulAuth.signUp($('#auth-username').value, $('#auth-passphrase').value) : await SoulAuth.logIn($('#auth-username').value, $('#auth-passphrase').value);
      SoulChat.init(supabase, session); SoulStatus.init(supabase, session);
      enterHome(session);
    } catch (err) { $('#auth-error').textContent = err.message; } finally { showSpinner(false); }
  };

  // ===================== HOME =====================
  function enterHome(session) {
    loadChatFlags();
    SoulUI.applyAvatar($('#home-avatar'), session.profile, fetchBlob);
    $('#home-username').textContent = '@' + session.profile.username;
    showScreen('#screen-home');
    SoulChat.subscribeHome();
    SoulChat.startTypingChannel();
    startPresence();
    switchTab('chats');
  }

  function updateUnreadBadge(chats) {
    const total = (chats || []).reduce(
      (sum, chat) => sum + (flagFor(chat.id).muted ? 0 : (chat.unreadCount || 0)), 0
    );
    const badge = $('#tab-chats-badge');
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = total === 0;
  }

  function buildChatRow(profile) {
    const flags = flagFor(profile.id);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-chat';
    item.setAttribute('aria-label', `Open chat with @${profile.username}`);

    const avatar = document.createElement('span');
    avatar.className = 'recent-avatar';
    SoulUI.applyAvatar(avatar, profile, fetchBlob);

    const details = document.createElement('span');
    details.className = 'recent-chat-details';
    const name = document.createElement('span');
    name.className = 'recent-chat-name';
    name.textContent = (flags.pinned ? '📌 ' : '') + (profile.display_name || profile.chatNickname || '@' + profile.username);
    // WhatsApp-style presence line under the username instead of the
    // old "@username - date" preview.
    const presence = document.createElement('span');
    presence.className = 'recent-chat-time recent-chat-presence';
    presence.textContent = presenceLabel(profile.last_seen_at);
    presence.classList.toggle('online', presence.textContent === 'online');
    details.append(name, presence);

    const right = document.createElement('span');
    right.className = 'recent-chat-right';
    if (flags.muted) {
      const muted = document.createElement('span');
      muted.className = 'row-mute-icon';
      muted.textContent = '🔇';
      right.appendChild(muted);
    }
    if (profile.unreadCount && !flags.muted) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = profile.unreadCount > 99 ? '99+' : String(profile.unreadCount);
      right.appendChild(badge);
    }

    item.append(avatar, details, right);
    item.onclick = () => enterChat(profile);
    SoulUI.onLongPress(item, () => openChatRowSheet(profile));
    return item;
  }

  function openChatRowSheet(profile) {
    const flags = flagFor(profile.id);
    SoulUI.openSheet({
      title: '@' + profile.username,
      items: [
        { icon: '📌', label: flags.pinned ? 'Unpin chat' : 'Pin to top', onclick: () => { flags.pinned = !flags.pinned; saveChatFlags(); renderRecentChats(); } },
        { icon: '🔔', label: flags.muted ? 'Unmute notifications' : 'Mute notifications', onclick: () => { flags.muted = !flags.muted; saveChatFlags(); renderRecentChats(); } },
        { icon: '📦', label: flags.archived ? 'Unarchive chat' : 'Archive chat', onclick: () => { flags.archived = !flags.archived; saveChatFlags(); renderRecentChats(); } },
      ],
    });
  }

  async function renderRecentChats(chats) {
    const list = $('#recent-chats');
    const archivedList = $('#archived-chats');
    const empty = $('#recent-chats-empty');
    const toggle = $('#archived-toggle');
    list.textContent = 'Loading chats...';
    archivedList.innerHTML = '';
    try {
      const all = chats || await SoulChat.fetchRecentChats();
      const pinned = [];
      const rest = [];
      const archived = [];
      for (const chat of all) {
        const flags = flagFor(chat.id);
        if (flags.archived) archived.push(chat);
        else if (flags.pinned) pinned.push(chat);
        else rest.push(chat);
      }
      const byTime = (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
      pinned.sort(byTime);
      rest.sort(byTime);
      archived.sort(byTime);
      const visible = [...pinned, ...rest];
      updateUnreadBadge(all);
      list.innerHTML = '';
      empty.hidden = visible.length > 0;
      for (const profile of visible) list.appendChild(buildChatRow(profile));
      toggle.hidden = archived.length === 0;
      $('#archived-count').textContent = String(archived.length);
      archivedList.hidden = !archivedShown;
      for (const profile of archived) archivedList.appendChild(buildChatRow(profile));
      if (!visible.length && !archived.length) empty.hidden = false;
    } catch (err) {
      list.textContent = 'Could not load recent chats.';
      empty.hidden = true;
      toast('Could not load recent chats: ' + err.message);
    }
  }

  // ===================== TABS (Chats / Status) =====================
  function switchTab(tab) {
    activeTab = tab;
    $('#tab-chats').classList.toggle('active', tab === 'chats');
    $('#tab-status').classList.toggle('active', tab === 'status');
    $('#tab-status').classList.remove('has-new');
    if (tab === 'chats') {
      showScreen('#screen-home');
      renderRecentChats();
    } else {
      showScreen('#screen-status');
      renderStatusScreen();
    }
  }
  $('#tab-chats').onclick = () => switchTab('chats');
  $('#tab-status').onclick = () => switchTab('status');

  // ===================== STATUS (WhatsApp-style) =====================
  // "My status" opens the composer. Below it, one row per chat partner
  // who posted an update; tapping a row opens the 15-second viewer.
  async function renderStatusScreen() {
    const renderId = ++statusRenderId;
    const updates = $('#status-updates');
    updates.innerHTML = '';
    const myProfile = SoulAuth.current().profile;
    loadAvatarInto($('#my-status-avatar'), myProfile.avatar_url, myProfile.username);

    try {
      await SoulStatus.cleanupExpired();
      const chats = await SoulChat.fetchRecentChats();
      let ownCount = 0;
      let ownLatest = null;
      const ownGroups = [];
      const groups = [];
      for (const profile of chats) {
        const key = await SoulChat.getConversationKeyForProfile(profile);
        const own = await SoulStatus.fetchOwnStatusesFor(profile, key);
        if (own.length) {
          ownGroups.push({ key, statuses: own });
          ownCount += own.length;
          if (!ownLatest || new Date(own[own.length - 1].createdAt) > new Date(ownLatest)) {
            ownLatest = own[own.length - 1].createdAt;
          }
        }
        const theirs = await SoulStatus.fetchStatusesFor(profile, key);
        if (theirs.length) groups.push({ profile, key, statuses: theirs });
      }
      if (renderId !== statusRenderId) return;
      ownGroupsCache = ownGroups;

      const subtitle = $('#my-status-subtitle');
      subtitle.textContent = ownCount
        ? `${ownCount} update${ownCount > 1 ? 's' : ''} · ${fmtRelative(ownLatest)}`
        : 'Tap to add a status update';

      const heading = $('#status-updates-heading');
      const empty = $('#status-updates-empty');
      heading.hidden = !groups.length;
      empty.hidden = !!groups.length;

      for (const { profile, key, statuses } of groups) {
        const unseen = statuses.some(status => !status.viewedAt);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'status-update-row';
        row.setAttribute('aria-label', `View @${profile.username}'s status`);
        const ring = document.createElement('span');
        ring.className = `status-ring ${unseen ? '' : 'seen'}`;
        loadAvatarInto(ring, profile.avatar_url, profile.username);
        const details = document.createElement('span');
        details.className = 'status-row-details';
        const name = document.createElement('span');
        name.className = 'status-row-title';
        name.textContent = '@' + profile.username;
        const when = document.createElement('span');
        when.className = 'status-row-subtitle';
        when.textContent = `${statuses.length} update${statuses.length > 1 ? 's' : ''} · ${fmtRelative(statuses[statuses.length - 1].createdAt)}`;
        details.append(name, when);
        row.append(ring, details);
        row.onclick = () => openStatusViewer(profile.username, key, statuses, { profile });
        updates.appendChild(row);
      }
    } catch (err) {
      toast('Could not load statuses: ' + err.message);
    }
  }

  // ---- composer: text status by default; attaching media turns the
  // typed text into its optional caption. ----
  const composerPreview = $('#status-preview');
  const composerText = $('#status-composer-text');
  const composerCaption = $('#status-composer-caption');
  const composerMediaHolder = $('#status-media-holder');

  function buildSwatches() {
    const wrap = $('#status-swatches');
    wrap.innerHTML = '';
    for (const [name, css] of Object.entries(STATUS_BG)) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = `swatch ${name === composerBg ? 'active' : ''}`;
      swatch.dataset.bg = name;
      swatch.setAttribute('aria-label', `Background: ${name}`);
      swatch.style.background = css;
      wrap.appendChild(swatch);
    }
  }

  function setComposerMode(media) {
    composerMedia = media;
    composerPreview.classList.toggle('textmode', !media);
    composerText.hidden = !!media;
    composerCaption.hidden = !media;
    $('#status-swatches').hidden = !!media;
    composerMediaHolder.innerHTML = '';
    composerMediaHolder.hidden = !media;
    composerPreview.style.background = media ? '' : (STATUS_BG[composerBg] || STATUS_BG.grape);
    if (media) {
      const tag = document.createElement(media.kind === 'video' ? 'video' : 'img');
      if (media.kind === 'video') { tag.controls = true; tag.muted = true; }
      tag.src = media.url;
      composerMediaHolder.appendChild(tag);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.id = 'btn-status-remove-media';
      remove.setAttribute('aria-label', 'Remove photo or video');
      remove.textContent = '\u2715';
      remove.onclick = () => {
        URL.revokeObjectURL(media.url);
        composerText.value = composerCaption.value;
        composerCaption.value = '';
        setComposerMode(null);
        buildSwatches();
      };
      composerMediaHolder.appendChild(remove);
    }
  }

  function openStatusComposer() {
    composerText.value = '';
    composerCaption.value = '';
    composerBg = 'grape';
    buildSwatches();
    setComposerMode(null);
    showScreen('#screen-status-composer');
  }
  // My status row: view my own updates when I have any, otherwise open
  // the composer. The "+" always opens the composer (upload option).
  $('#my-status-row').onclick = () => {
    const items = ownGroupsCache.flatMap(group => group.statuses.map(s => ({ ...s, key: group.key })));
    if (items.length) {
      openStatusViewer(SoulAuth.current().profile.username, items[0].key, items, { own: true });
    } else {
      openStatusComposer();
    }
  };
  document.querySelector('.my-status-plus').onclick = (event) => {
    event.stopPropagation();
    openStatusComposer();
  };
  $('#btn-composer-back').onclick = () => switchTab('status');

  $('#archived-toggle').onclick = () => {
    archivedShown = !archivedShown;
    $('#archived-chats').hidden = !archivedShown;
  };

  $('#status-swatches').onclick = (event) => {
    const swatch = event.target.closest('.swatch');
    if (!swatch) return;
    composerBg = swatch.dataset.bg;
    buildSwatches();
    composerPreview.style.background = STATUS_BG[composerBg] || STATUS_BG.grape;
  };

  $('#btn-status-attach').onclick = () => $('#status-file-input').click();
  $('#status-file-input').onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      toast('Choose an image or video file.');
      return;
    }
    const maxSize = file.type.startsWith('video/') ? 50 * 1024 * 1024 : 15 * 1024 * 1024;
    if (file.size > maxSize) {
      toast(`File is too large (maximum ${maxSize / (1024 * 1024)} MB).`);
      return;
    }
    // Whatever text was typed for a text status becomes the caption.
    const media = {
      file,
      kind: file.type.startsWith('video/') ? 'video' : 'image',
      url: URL.createObjectURL(file),
    };
    composerCaption.value = composerText.value;
    composerText.value = '';
    setComposerMode(media);
  };

  $('#btn-status-post').onclick = async () => {
    const caption = composerCaption.value.trim();
    const text = composerText.value.trim();
    const payload = composerMedia
      ? { file: composerMedia.file, kind: composerMedia.kind, text: caption }
      : { text, bg: composerBg };
    if (!composerMedia && !text) { toast('Write a status first.'); return; }
    showSpinner(true);
    try {
      const partners = await SoulChat.fetchRecentChats();
      const count = await SoulStatus.postToPartners(partners, payload);
      toast(`Status shared with ${count} chat partner${count > 1 ? 's' : ''} for 24 hours.`);
      switchTab('status');
    } catch (err) {
      toast('Could not post status: ' + err.message);
    } finally { showSpinner(false); }
  };

  function updateRetentionControls() {
    const menuToggle = $('#menu-retention');
    menuToggle.textContent = `Auto-delete in this chat: ${currentChatAutoDelete ? 'On' : 'Off'}`;
    menuToggle.setAttribute('aria-checked', String(currentChatAutoDelete));
    $('#chat-retention-note').textContent = currentChatAutoDelete ? `Auto-delete after ${durationLabel(currentChatMinutes)}` : 'Messages kept';
    const settingsToggle = $('#toggle-retention');
    const defaultAutoDelete = !SoulAuth.current().profile.retain_messages;
    settingsToggle.classList.toggle('on', defaultAutoDelete);
    settingsToggle.setAttribute('aria-checked', String(defaultAutoDelete));
  }

  $('#btn-settings').onclick = () => {
    renderSettings();
    showScreen('#screen-settings');
  };

  $('#home-avatar').onclick = () => $('#avatar-input').click();
  $('#avatar-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Choose an image file.'); return; }
    showSpinner(true);
    try {
      await SoulChat.uploadAvatar(file);
      SoulUI.applyAvatar($('#home-avatar'), SoulAuth.current().profile, fetchBlob);
      toast('Profile picture updated!');
    }
    catch (err) { toast('Upload failed: ' + err.message); } finally { showSpinner(false); }
  };

  async function doLogout() {
    SoulChat.closeConversation();
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    await SoulAuth.logOut();
    showScreen('#screen-auth');
  }
  $('#btn-logout').onclick = doLogout;
  $('#btn-logout-2').onclick = doLogout;
  $('#btn-settings-2').onclick = () => { renderSettings(); showScreen('#screen-settings'); };
  $('#btn-back-home-2').onclick = () => switchTab(activeTab);
  $('#btn-find').onclick = findAndOpenChat;

  async function findAndOpenChat() {
    const username = $('#find-username').value.trim(); $('#find-error').textContent = '';
    if (!username) return;
    if (username.toLowerCase() === SoulAuth.current().profile.username) { $('#find-error').textContent = "That's you."; return; }
    showSpinner(true);
    try {
      const profile = await SoulChat.lookupProfileByUsername(username);
      if (!profile) { $('#find-error').textContent = 'User not found.'; return; }
      await enterChat(profile);
    } catch (err) { $('#find-error').textContent = err.message; } finally { showSpinner(false); }
  }

  // ===================== CHAT =====================
  $('#btn-back-home').onclick = () => {
    SoulChat.closeConversation();
    SoulChat.subscribeHome();
    switchTab('chats');
  };

  document.addEventListener('soul:recent-chats-updated', (e) => {
    if ($('#screen-home').classList.contains('active')) renderRecentChats(e.detail);
  });
  document.addEventListener('soul:statuses-updated', () => {
    if ($('#screen-status').classList.contains('active')) renderStatusScreen();
    else $('#tab-status').classList.add('has-new');
  });
  $('#chat-avatar').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openProfileViewer();
    }
  });
  document.addEventListener('soul:new-message', (e) => {
    if (loadingChat) { queuedChatMessages.push(e.detail); return; }
    appendBubble(e.detail);
    scrollMessagesToBottom();
    SoulUI.playReceived();
    SoulChat.fetchReactions([e.detail.groupId]).then((map) => {
      reactionsByGroup.set(e.detail.groupId, map.get(e.detail.groupId) || []);
      renderReactionsInto($('#messages').querySelector(`.reactions-row[data-group-id="${e.detail.groupId}"]`), e.detail.groupId);
    }).catch(() => { /* reactions are cosmetic */ });
  });
  document.addEventListener('soul:partner-typing', (e) => {
    if (!currentPartnerProfile || e.detail.from !== currentPartnerProfile.id) return;
    const note = $('#chat-retention-note');
    if (!note) return;
    note.textContent = 'typing…';
    note.classList.add('typing');
    clearTimeout(typingResetTimer);
    typingResetTimer = setTimeout(() => {
      note.classList.remove('typing');
      updateRetentionControls();
    }, 3000);
  });
  document.addEventListener('soul:reaction-updated', async (e) => {
    const groupId = e.detail.groupId;
    if (!renderedMessageGroups.has(groupId)) return;
    try {
      reactionsByGroup.set(groupId, (await SoulChat.fetchReactions([groupId])).get(groupId) || []);
      renderReactionsInto($('#messages').querySelector(`.reactions-row[data-group-id="${groupId}"]`), groupId);
    } catch (_) { /* best effort */ }
  });
  document.addEventListener('soul:message-receipt-updated', (e) => updateMessageReceipt(e.detail));
  document.addEventListener('soul:messages-expired', (e) => {
    for (const groupId of e.detail) {
      const row = $('#messages').querySelector(`[data-group-id="${groupId}"]`);
      if (row) row.remove();
      renderedMessageGroups.delete(groupId);
      messageRowsByGroup.delete(groupId);
      messageDataByGroup.delete(groupId);
    }
  });
  document.addEventListener('soul:background-updated', (e) => {
    applyChatBackground(e.detail).catch(err => toast('Could not update chat background: ' + err.message));
  });
  document.addEventListener('soul:error', (e) => toast('Chat update failed: ' + e.detail.message));

  async function enterChat(profile) {
    if (loadingChat) return; // ignore double-taps while a chat is already loading
    currentPartnerProfile = profile;
    loadingChat = true;
    queuedChatMessages.length = 0;
    renderedMessageGroups.clear();
    messageRowsByGroup.clear();
    messageDataByGroup.clear();
    pendingMessageReceipts.clear();
    showSpinner(true);
    try {
      const history = await SoulChat.openConversationWith(profile);

      const autoDeletePref = await SoulChat.getAutoDelete();
      currentChatAutoDelete = autoDeletePref.enabled;
      currentChatMinutes = autoDeletePref.minutes || AUTO_DELETE_MINUTES;
      currentPartnerNickname = await SoulChat.getNickname();
      $('#chat-partner-name').textContent = profile.display_name || currentPartnerNickname || '@' + profile.username;
      SoulUI.applyAvatar($('#chat-avatar'), profile, fetchBlob);

      const background = await SoulChat.getChatBackground();
      await applyChatBackground(background);

      $('#messages').innerHTML = '';
      lastBubbleDay = null;
      cancelReply();
      reactionsByGroup = new Map(await SoulChat.fetchReactions(history.map(m => m.groupId).filter(Boolean)));
      for (const msg of history) appendBubble(msg);
      loadingChat = false;
      for (const msg of queuedChatMessages.splice(0)) appendBubble(msg);
      scrollMessagesToBottom();
      updateRetentionControls();
      updateComposerButtons();
      showScreen('#screen-chat');
      // Returning from "reply to status": prefill the composer.
      if (statusReplyContext && currentPartnerProfile && statusReplyContext.profile.id === currentPartnerProfile.id) {
        $('#msg-input').value = 'Re: ' + statusReplyContext.snippet;
        updateComposerButtons();
        statusReplyContext = null;
      }
    } catch (err) {
      loadingChat = false;
      queuedChatMessages.length = 0;
      toast(err.message);
    } finally { showSpinner(false); }
  }

  async function applyChatBackground(background) {
    const element = $('#chat-screen-bg');
    if (chatBackgroundUrl) {
      URL.revokeObjectURL(chatBackgroundUrl);
      chatBackgroundUrl = null;
    }
    element.style.backgroundImage = '';
    if (!background) return;
    const bytes = await SoulChat.downloadAndDecryptMedia(background.storagePath, background.fileIv);
    chatBackgroundUrl = URL.createObjectURL(new Blob([bytes]));
    element.style.backgroundImage = `url("${chatBackgroundUrl}")`;
  }

  function scrollMessagesToBottom() { const box = $('#messages'); box.scrollTop = box.scrollHeight; }

  function dayLabel(value) {
    const today = new Date();
    const date = new Date(value);
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(today) - startOf(date)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function appendBubble(msg) {
    if (msg.groupId && renderedMessageGroups.has(msg.groupId)) return;
    if (msg.groupId) renderedMessageGroups.add(msg.groupId);
    const message = { ...msg };
    const pendingReceipt = msg.groupId && pendingMessageReceipts.get(msg.groupId);
    if (pendingReceipt) {
      Object.assign(message, pendingReceipt);
      pendingMessageReceipts.delete(msg.groupId);
    }
    const messages = $('#messages');

    // Date separators ("Today" / "Yesterday" / a date) between day changes.
    const day = dayLabel(message.createdAt);
    if (day !== lastBubbleDay) {
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.textContent = day;
      messages.appendChild(sep);
      lastBubbleDay = day;
    }

    const row = document.createElement('div'); row.className = 'bubble-row ' + (message.mine ? 'mine' : 'theirs');
    if (message.groupId) row.dataset.groupId = message.groupId;
    const bubble = document.createElement('div'); bubble.className = 'bubble';

    if (message.reply) {
      const quote = document.createElement('div');
      quote.className = 'reply-quote';
      const icon = message.reply.k === 'image' ? '📷 ' : message.reply.k === 'video' ? '🎬 ' : message.reply.k === 'audio' ? '🎙️ ' : '';
      const snippet = document.createElement('div');
      snippet.className = 'reply-quote-text';
      snippet.textContent = icon + (message.reply.s || '');
      quote.appendChild(snippet);
      bubble.appendChild(quote);
    }

    if (message.kind === 'text') {
      SoulUI.linkifyText(bubble, message.text ?? '[undecryptable message]');
    } else if (message.mediaUnavailable) {
      // The encrypted file for this message no longer exists in storage.
      // Show the decrypted caption (if any) instead of a dead image tag.
      const note = document.createElement('div');
      note.className = 'media-missing';
      note.textContent = message.caption ? `[media unavailable] ${message.caption}` : '[media unavailable]';
      bubble.appendChild(note);
    } else if (message.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.className = 'audio-note';
      bubble.appendChild(audio);
      if (message.localUrl) {
        audio.src = message.localUrl;
      } else {
        SoulChat.downloadAndDecryptMedia(message.storagePath, message.fileIv).then((buf) => {
          audio.src = URL.createObjectURL(new Blob([buf], { type: 'audio/webm' }));
        }).catch(() => { audio.replaceWith(document.createTextNode('[voice message unavailable]')); });
      }
    } else {
      const mediaTag = document.createElement(message.kind === 'video' ? 'video' : 'img');
      if (message.kind === 'video') mediaTag.controls = true;
      bubble.appendChild(mediaTag);
      if (message.localUrl) {
        mediaTag.src = message.localUrl;
        mediaTag.onclick = () => SoulUI.openMediaViewer(message.kind, message.localUrl);
      } else {
        SoulChat.downloadAndDecryptMedia(message.storagePath, message.fileIv).then((buf) => {
          const type = message.kind === 'video' ? 'video/mp4' : 'image/jpeg';
          const url = URL.createObjectURL(new Blob([buf], { type }));
          mediaTag.src = url;
          mediaTag.onclick = () => SoulUI.openMediaViewer(message.kind, url);
        }).catch(() => { mediaTag.replaceWith(document.createTextNode('[media unavailable]')); });
      }
    }

    if (message.starred) {
      const star = document.createElement('span');
      star.className = 'star-chip';
      star.textContent = '⭐';
      bubble.appendChild(star);
    }

    if (message.groupId) {
      const reactionRow = document.createElement('div');
      reactionRow.className = 'reactions-row';
      reactionRow.dataset.groupId = message.groupId;
      bubble.appendChild(reactionRow);
      renderReactionsInto(reactionRow, message.groupId);
    }

    const meta = document.createElement('div'); meta.className = 'meta';
    const time = document.createElement('span');
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.appendChild(time);
    if (message.mine && message.groupId) {
      const receipt = document.createElement('button');
      receipt.type = 'button';
      receipt.className = 'receipt-button';
      receipt.title = 'Message info';
      receipt.onclick = (event) => {
        event.stopPropagation();
        openMessageInfo(message);
      };
      meta.appendChild(receipt);
      updateReceiptButton(receipt, message);
    }
    bubble.appendChild(meta); row.appendChild(bubble); messages.appendChild(row);

    if (message.groupId) {
      messageRowsByGroup.set(message.groupId, row);
      messageDataByGroup.set(message.groupId, message);
      // Long-press (or right-click) opens the message actions.
      SoulUI.onLongPress(row, () => openMessageSheet(message.groupId));
      SoulUI.onDoubleTap(row, () => applyReaction(message.groupId, '❤️'));
    }
  }

  function renderReactionsInto(container, groupId) {
    if (!container) return;
    container.innerHTML = '';
    const list = reactionsByGroup.get(groupId) || [];
    if (!list.length) { container.hidden = true; return; }
    container.hidden = false;
    const counts = new Map();
    for (const reaction of list) counts.set(reaction.emoji, (counts.get(reaction.emoji) || 0) + 1);
    const mine = list.find(r => r.reactorId === SoulAuth.current().user.id);
    for (const [emoji, count] of counts) {
      const chip = document.createElement('span');
      chip.className = 'reaction-chip' + (mine && mine.emoji === emoji ? ' mine' : '');
      chip.textContent = emoji + (count > 1 ? ` ${count}` : '');
      container.appendChild(chip);
    }
  }

  function removeMessageRow(groupId) {
    const row = messageRowsByGroup.get(groupId);
    if (row) row.remove();
    renderedMessageGroups.delete(groupId);
    messageRowsByGroup.delete(groupId);
    messageDataByGroup.delete(groupId);
  }

  // WhatsApp-style ticks: one ✓ sent, two ✓✓ delivered, blue ✓✓ read.
  function updateReceiptButton(button, message) {
    const state = message.readAt ? 'seen' : message.deliveredAt ? 'delivered' : 'sent';
    button.textContent = message.deliveredAt ? '\u2713\u2713' : '\u2713';
    button.classList.toggle('read', !!message.readAt);
    button.setAttribute('aria-label', `Message info. ${state}.`);
  }

  function updateMessageReceipt(receipt) {
    const message = messageDataByGroup.get(receipt.groupId);
    if (!message) {
      pendingMessageReceipts.set(receipt.groupId, receipt);
      return;
    }
    message.deliveredAt = receipt.deliveredAt;
    message.readAt = receipt.readAt;
    const row = messageRowsByGroup.get(receipt.groupId);
    const button = row && row.querySelector('.receipt-button');
    if (button) updateReceiptButton(button, message);
    if (activeInfoMessageGroup === receipt.groupId) renderMessageInfo(message);
  }

  let activeInfoMessageGroup = null;
  function exactTime(value) {
    return value
      ? new Date(value).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : 'Not yet';
  }

  function renderMessageInfo(message) {
    const content = $('#message-info-content');
    content.innerHTML = '';
    const details = [
      ['Sent', exactTime(message.createdAt)],
      ['Received', message.deliveredAt ? exactTime(message.deliveredAt) : 'Not received yet'],
      ['Seen', message.readAt ? exactTime(message.readAt) : 'Not seen yet'],
    ];
    for (const [label, value] of details) {
      const row = document.createElement('div');
      row.className = 'message-info-row';
      const labelElement = document.createElement('span');
      labelElement.textContent = label;
      const valueElement = document.createElement('span');
      valueElement.className = 'message-info-time';
      valueElement.textContent = value;
      row.append(labelElement, valueElement);
      content.appendChild(row);
    }
  }

  function openMessageInfo(message) {
    activeInfoMessageGroup = message.groupId;
    renderMessageInfo(message);
    $('#message-info-viewer').classList.add('active');
  }

  function closeMessageInfo() {
    activeInfoMessageGroup = null;
    $('#message-info-viewer').classList.remove('active');
  }
  $('#btn-close-message-info').onclick = closeMessageInfo;
  $('#message-info-viewer').onclick = (event) => {
    if (event.target === $('#message-info-viewer')) closeMessageInfo();
  };

  // ===================== MESSAGE ACTIONS (long-press) =====================
  function openMessageSheet(groupId) {
    const message = messageDataByGroup.get(groupId);
    if (!message) return;
    const items = [
      { icon: '↩️', label: 'Reply', onclick: () => startReply(message) },
      { icon: '😊', label: 'React', onclick: () => openReactionSheet(groupId) },
    ];
    if (message.kind === 'text' && message.text) {
      items.push({
        icon: '📋', label: 'Copy text',
        onclick: () => navigator.clipboard?.writeText(message.text)
          .then(() => toast('Copied.')).catch(() => toast('Could not copy.')),
      });
    }
    items.push({
      icon: '⭐', label: message.starred ? 'Unstar message' : 'Star message',
      onclick: async () => {
        try {
          await SoulChat.setStarred(message.id, !message.starred);
          message.starred = !message.starred;
          const bubble = messageRowsByGroup.get(groupId)?.querySelector('.bubble');
          let chip = bubble?.querySelector('.star-chip');
          if (message.starred && bubble && !chip) {
            chip = document.createElement('span');
            chip.className = 'star-chip';
            chip.textContent = '⭐';
            bubble.appendChild(chip);
          }
          if (!message.starred && chip) chip.remove();
        } catch (err) { toast('Could not update star: ' + err.message); }
      },
    });
    items.push({ icon: '📤', label: 'Forward', onclick: () => openForwardSheet(message) });
    if (message.mine) items.push({ icon: 'ℹ️', label: 'Message info', onclick: () => openMessageInfo(message) });
    items.push({
      icon: '🗑️', label: 'Delete for me', danger: true,
      onclick: async () => {
        try { await SoulChat.deleteMessage(groupId); removeMessageRow(groupId); }
        catch (err) { toast('Could not delete: ' + err.message); }
      },
    });
    SoulUI.openSheet({ title: 'Message', items });
  }

  // ---- reply ----
  function startReply(message) {
    replyTo = { g: message.groupId, s: snippetOf(message), k: message.kind, status: false };
    showReplyBar();
  }
  function showReplyBar() {
    const icon = replyTo.k === 'image' ? '📷' : replyTo.k === 'video' ? '🎬' : replyTo.k === 'audio' ? '🎙️' : '↩️';
    $('#reply-bar-icon').textContent = icon;
    $('#reply-bar-text').textContent = replyTo.s;
    $('#reply-bar').hidden = false;
    $('#msg-input').focus();
  }
  function cancelReply() {
    replyTo = null;
    $('#reply-bar').hidden = true;
  }
  $('#btn-reply-cancel').onclick = cancelReply;

  // ---- reactions ----
  function openReactionSheet(groupId) {
    const row = document.createElement('div');
    row.className = 'reaction-picker';
    for (const emoji of REACTION_SET) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reaction-choice';
      button.textContent = emoji;
      button.onclick = () => { SoulUI.closeSheet(); applyReaction(groupId, emoji); };
      row.appendChild(button);
    }
    SoulUI.openSheet({ title: 'React', node: row });
  }
  async function applyReaction(groupId, emoji) {
    try {
      const mine = SoulAuth.current().user.id;
      const existing = (reactionsByGroup.get(groupId) || []).find(r => r.reactorId === mine);
      const result = await SoulChat.setReaction(groupId, existing && existing.emoji === emoji ? null : emoji);
      const list = (reactionsByGroup.get(groupId) || []).filter(r => r.reactorId !== mine);
      if (result) list.push({ reactorId: mine, emoji: result });
      reactionsByGroup.set(groupId, list);
      renderReactionsInto($('#messages').querySelector(`.reactions-row[data-group-id="${groupId}"]`), groupId);
    } catch (err) { toast('Could not react: ' + err.message); }
  }

  // ---- forward ----
  function openForwardSheet(message) {
    const wrap = document.createElement('div');
    wrap.className = 'forward-list';
    const note = document.createElement('p');
    note.className = 'hint-text';
    note.textContent = 'Send a copy to one of your chats:';
    wrap.appendChild(note);
    SoulChat.fetchRecentChats().then((chats) => {
      note.textContent = chats.length ? 'Send a copy to one of your chats:' : 'No chats to forward to yet.';
      for (const chat of chats) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sheet-item';
        button.textContent = '@' + chat.username;
        button.onclick = async () => {
          SoulUI.closeSheet();
          showSpinner(true);
          try {
            if (message.kind === 'text') {
              await SoulChat.sendToProfile(chat, { text: message.text || '' });
            } else if (message.storagePath && !message.mediaUnavailable) {
              const buf = await SoulChat.downloadAndDecryptMedia(message.storagePath, message.fileIv);
              const ext = message.kind === 'video' ? 'mp4' : message.kind === 'audio' ? 'webm' : 'jpg';
              const type = message.kind === 'video' ? 'video/mp4' : message.kind === 'audio' ? 'audio/webm' : 'image/jpeg';
              const file = new File([buf], `forward.${ext}`, { type });
              await SoulChat.sendToProfile(chat, { file, kind: message.kind, caption: message.caption || '' });
            } else {
              toast('This media is no longer available to forward.');
              return;
            }
            toast(`Forwarded to @${chat.username}.`);
          } catch (err) {
            toast('Could not forward: ' + err.message);
          } finally { showSpinner(false); }
        };
        wrap.appendChild(button);
      }
    }).catch((err) => { note.textContent = 'Could not load chats: ' + err.message; });
    SoulUI.openSheet({ title: 'Forward message', node: wrap });
  }

  // ---- starred messages screen ----
  async function openStarredScreen() {
    showScreen('#screen-starred');
    const list = $('#starred-list');
    list.textContent = 'Loading starred messages...';
    try {
      const items = await SoulChat.fetchStarredMessages();
      list.innerHTML = '';
      if (!items.length) {
        list.textContent = 'No starred messages yet. Long-press a message and choose Star.';
        return;
      }
      for (const message of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'starred-row';
        const name = document.createElement('span');
        name.className = 'starred-name';
        name.textContent = '@' + message.partner.username;
        const text = document.createElement('span');
        text.className = 'starred-text';
        const icon = message.kind === 'image' ? '📷 ' : message.kind === 'video' ? '🎬 ' : message.kind === 'audio' ? '🎙️ ' : '';
        text.textContent = icon + (message.kind === 'text' ? message.text : message.caption || '');
        const time = document.createElement('span');
        time.className = 'starred-time';
        time.textContent = new Date(message.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        row.append(name, text, time);
        row.onclick = () => { SoulChat.closeConversation(); enterChat(message.partner); };
        list.appendChild(row);
      }
    } catch (err) {
      list.textContent = 'Could not load starred messages: ' + err.message;
    }
  }
  $('#btn-starred-back').onclick = () => showScreen('#screen-chat');

  // ---- search in chat ----
  function renderSearchResults(query) {
    const box = $('#search-results');
    box.innerHTML = '';
    if (!query) { box.hidden = true; return; }
    const q = query.toLowerCase();
    const matches = [];
    for (const [groupId, message] of messageDataByGroup) {
      const hay = (message.kind === 'text' ? message.text : message.caption || '').toLowerCase();
      if (hay && hay.includes(q)) matches.push({ groupId, message });
    }
    box.hidden = false;
    if (!matches.length) {
      box.textContent = 'No messages found.';
      return;
    }
    for (const { groupId, message } of matches.slice(0, 30)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      const snippet = message.kind === 'text' ? message.text : message.caption || `[${message.kind}]`;
      button.textContent = `${new Date(message.createdAt).toLocaleString([], { month: 'short', day: 'numeric' })} · ${snippet.slice(0, 60)}`;
      button.onclick = () => {
        box.hidden = true;
        const row = messageRowsByGroup.get(groupId);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('flash');
          setTimeout(() => row.classList.remove('flash'), 1600);
        }
      };
      box.appendChild(button);
    }
  }
  $('#menu-search').onclick = () => {
    $('#chat-dropdown').classList.remove('active');
    const bar = $('#search-bar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#search-input').focus();
  };
  $('#btn-search-close').onclick = () => {
    $('#search-bar').hidden = true;
    $('#search-results').hidden = true;
  };
  $('#search-input').addEventListener('input', () => renderSearchResults($('#search-input').value.trim()));

  // ---- viewers of my statuses ----
  function openViewersSheet(viewers) {
    const wrap = document.createElement('div');
    wrap.className = 'viewers-list';
    if (!viewers.length) {
      const emptyNote = document.createElement('p');
      emptyNote.className = 'hint-text';
      emptyNote.textContent = 'No views yet.';
      wrap.appendChild(emptyNote);
    }
    for (const viewer of viewers) {
      const row = document.createElement('div');
      row.className = 'viewer-row';
      const name = document.createElement('span');
      name.textContent = '@' + viewer.profile.username;
      const when = document.createElement('span');
      when.className = 'viewer-time';
      when.textContent = fmtRelative(viewer.lastViewedAt);
      row.append(name, when);
      wrap.appendChild(row);
    }
    SoulUI.openSheet({ title: 'Viewed by', node: wrap });
  }

  let sendingText = false;
  function takeReplyQuote() {
    if (!replyTo || replyTo.status) return null;
    const quote = { g: replyTo.g, s: replyTo.s, k: replyTo.k };
    cancelReply();
    return quote;
  }
  function restoreReplyQuote(quote) {
    if (!quote) return;
    replyTo = { ...quote, status: false };
    showReplyBar();
  }

  $('#btn-send').onclick = async () => {
    const text = $('#msg-input').value.trim();
    if (!text || sendingText) return;
    if (loadingChat || !SoulChat.getConversationKey()) {
      toast('Chat is still loading — try again in a second.');
      return;
    }
    sendingText = true;
    $('#msg-input').value = '';
    const quote = takeReplyQuote();
    try {
      const sent = await SoulChat.sendText(text, quote);
      SoulUI.playSent();
      appendBubble({ groupId: sent.groupId, mine: true, kind: 'text', text, createdAt: sent.createdAt, reply: quote });
      scrollMessagesToBottom();
      updateComposerButtons();
    } catch (err) {
      // Put the text back so a failed send (e.g. offline) doesn't lose it.
      $('#msg-input').value = text;
      restoreReplyQuote(quote);
      toast(err.message);
    } finally { sendingText = false; }
  };
  $('#msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-send').click(); });
  $('#msg-input').addEventListener('input', () => {
    updateComposerButtons();
    if (currentPartnerProfile) SoulChat.sendTyping(currentPartnerProfile.id);
  });

  // WhatsApp-style composer: mic when empty, send arrow when typing.
  function updateComposerButtons() {
    const hasText = $('#msg-input').value.trim().length > 0;
    $('#btn-send').hidden = !hasText;
    $('#btn-mic').hidden = hasText;
  }

  $('#btn-emoji').onclick = () => {
    const panel = $('#emoji-panel');
    if (!panel.childElementCount) {
      panel.appendChild(SoulUI.buildEmojiPanel((emoji) => {
        const input = $('#msg-input');
        input.value += emoji;
        updateComposerButtons();
      }));
    }
    panel.hidden = !panel.hidden;
  };

  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    const maxSize = isVideo ? 50 * 1024 * 1024 : 15 * 1024 * 1024;
    if (!file.type.startsWith('image/') && !isVideo && !isAudio) { toast('Choose an image, video, or audio file.'); return; }
    if (file.size > maxSize) { toast(`File is too large (maximum ${maxSize / (1024 * 1024)} MB).`); return; }
    if (loadingChat || !SoulChat.getConversationKey()) { toast('Chat is still loading — try again in a second.'); return; }
    const kind = isVideo ? 'video' : isAudio ? 'audio' : 'image';
    const quote = takeReplyQuote();
    showSpinner(true);
    try {
      const sent = await SoulChat.sendMedia(file, kind, '', quote);
      SoulUI.playSent();
      const localUrl = URL.createObjectURL(file);
      appendBubble({ groupId: sent.groupId, mine: true, kind, createdAt: sent.createdAt, localUrl, reply: quote });
      scrollMessagesToBottom();
    } catch (err) {
      restoreReplyQuote(quote);
      toast('Upload failed: ' + err.message);
    } finally { showSpinner(false); }
  };

  // ---- voice notes ----
  $('#btn-mic').onclick = async () => {
    if (recording) return;
    if (loadingChat || !SoulChat.getConversationKey()) { toast('Chat is still loading — try again in a second.'); return; }
    const started = await SoulUI.startRecording(
      (seconds) => { $('#record-timer').textContent = SoulUI.fmtClock(seconds); },
      (err) => toast('Could not record audio: ' + err.message),
    );
    if (!started) return;
    recording = true;
    $('#record-timer').textContent = '0:00';
    $('#record-bar').hidden = false;
    $('#composer-main').hidden = true;
  };
  $('#btn-record-cancel').onclick = () => {
    SoulUI.cancelRecording();
    recording = false;
    $('#record-bar').hidden = true;
    $('#composer-main').hidden = false;
  };
  $('#btn-record-send').onclick = async () => {
    const result = await SoulUI.stopRecording();
    recording = false;
    $('#record-bar').hidden = true;
    $('#composer-main').hidden = false;
    if (!result) return;
    if (result.seconds < 1 || result.blob.size < 1000) { toast('Recording was too short.'); return; }
    const file = new File([result.blob], 'voice-note.webm', { type: result.blob.type || 'audio/webm' });
    const quote = takeReplyQuote();
    showSpinner(true);
    try {
      const sent = await SoulChat.sendMedia(file, 'audio', '', quote);
      SoulUI.playSent();
      appendBubble({
        groupId: sent.groupId, mine: true, kind: 'audio', createdAt: sent.createdAt,
        localUrl: URL.createObjectURL(result.blob), reply: quote,
      });
      scrollMessagesToBottom();
    } catch (err) {
      restoreReplyQuote(quote);
      toast('Could not send voice note: ' + err.message);
    } finally { showSpinner(false); }
  };

  // ---- camera ----
  $('#btn-camera').onclick = async () => {
    try {
      await SoulUI.openCamera($('#camera-preview'), cameraFacing);
      $('#camera-modal').classList.add('active');
    } catch (err) { toast('Could not open the camera: ' + err.message); }
  };
  $('#btn-camera-flip').onclick = async () => {
    cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
    try { await SoulUI.openCamera($('#camera-preview'), cameraFacing); }
    catch (_) { cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment'; }
  };
  $('#btn-camera-close').onclick = () => {
    SoulUI.closeCamera($('#camera-preview'));
    $('#camera-modal').classList.remove('active');
  };
  $('#btn-camera-capture').onclick = async () => {
    try {
      const blob = await SoulUI.captureFrame($('#camera-preview'));
      SoulUI.closeCamera($('#camera-preview'));
      $('#camera-modal').classList.remove('active');
      const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
      const quote = takeReplyQuote();
      showSpinner(true);
      try {
        const sent = await SoulChat.sendMedia(file, 'image', '', quote);
        SoulUI.playSent();
        appendBubble({ groupId: sent.groupId, mine: true, kind: 'image', createdAt: sent.createdAt, localUrl: URL.createObjectURL(blob), reply: quote });
        scrollMessagesToBottom();
      } catch (err) {
        restoreReplyQuote(quote);
        toast('Upload failed: ' + err.message);
      } finally { showSpinner(false); }
    } catch (err) { toast(err.message); }
  };

  // ===================== MENU & MODALS =====================
  $('#btn-chat-menu').onclick = () => {
    const menu = $('#chat-dropdown');
    const expanded = menu.classList.toggle('active');
    $('#btn-chat-menu').setAttribute('aria-expanded', String(expanded));
  };
  document.addEventListener('click', (event) => {
    if (!$('#chat-dropdown').contains(event.target) && !$('#btn-chat-menu').contains(event.target)) {
      $('#chat-dropdown').classList.remove('active');
      $('#btn-chat-menu').setAttribute('aria-expanded', 'false');
    }
  });
  
  $('#menu-retention').onclick = async () => {
    const enabled = !currentChatAutoDelete;
    showSpinner(true);
    try {
      await SoulChat.setAutoDelete(enabled, currentChatMinutes);
      currentChatAutoDelete = enabled;
      updateRetentionControls();
      toast(enabled ? `Auto-delete on — every ${durationLabel(currentChatMinutes)}` : 'Auto-delete disabled for this chat');
      $('#chat-dropdown').classList.remove('active');
    } catch (err) {
      toast('Could not update auto-delete: ' + err.message);
    } finally { showSpinner(false); }
  };

  // Cycle the per-chat duration: 10 min -> 1 hour -> 24 hours -> 10 min...
  // Choosing a duration also switches auto-delete ON for this chat.
  $('#menu-duration').onclick = async () => {
    const index = AUTO_DELETE_OPTIONS.indexOf(currentChatMinutes);
    const next = AUTO_DELETE_OPTIONS[(index + 1 + AUTO_DELETE_OPTIONS.length) % AUTO_DELETE_OPTIONS.length];
    showSpinner(true);
    try {
      await SoulChat.setAutoDelete(true, next);
      currentChatAutoDelete = true;
      currentChatMinutes = next;
      updateRetentionControls();
      toast(`Auto-delete set to ${durationLabel(next)}`);
    } catch (err) {
      toast('Could not update auto-delete: ' + err.message);
    } finally { showSpinner(false); }
  };

  $('#menu-starred').onclick = () => {
    $('#chat-dropdown').classList.remove('active');
    openStarredScreen();
  };

  $('#menu-bg').onclick = () => { $('#bg-input').click(); $('#chat-dropdown').classList.remove('active'); };
  $('#menu-avatar').onclick = () => { $('#avatar-input').click(); $('#chat-dropdown').classList.remove('active'); };
  $('#menu-clear-chat').onclick = async () => {
    if (!window.confirm('Clear this chat from your account? The other participant will still have their messages.')) return;
    showSpinner(true);
    try {
      const result = await SoulChat.clearConversation();
      $('#messages').innerHTML = '';
      renderedMessageGroups.clear();
      messageRowsByGroup.clear();
      messageDataByGroup.clear();
      pendingMessageReceipts.clear();
      $('#chat-dropdown').classList.remove('active');
      $('#btn-chat-menu').setAttribute('aria-expanded', 'false');
      toast(result.recentChatsError
        ? 'Chat cleared, but recent chats could not be updated: ' + result.recentChatsError
        : 'Chat cleared for you.');
    } catch (err) {
      toast('Could not clear chat: ' + err.message);
    } finally { showSpinner(false); }
  };
  $('#bg-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    showSpinner(true);
    try {
      const uploaded = await SoulChat.uploadChatBackground(file);
      toast('Chat background updated for both!');
      await applyChatBackground(uploaded);
    } catch (err) { toast('Failed: ' + err.message); } finally { showSpinner(false); }
  };

  // ===================== PROFILE VIEWER =====================
  window.openProfileViewer = async () => {
    if (!currentPartnerProfile) return;
    try {
      const refreshedProfile = await SoulChat.lookupProfileByUsername(currentPartnerProfile.username);
      if (refreshedProfile) currentPartnerProfile = refreshedProfile;
    } catch (err) {
      toast('Could not refresh profile: ' + err.message);
    }
    $('#profile-nickname').textContent = currentPartnerProfile.display_name || currentPartnerNickname || currentPartnerProfile.username;
    $('#profile-username').textContent = '@' + currentPartnerProfile.username;
    const bioElement = $('#profile-bio');
    bioElement.textContent = currentPartnerProfile.bio || '';
    bioElement.hidden = !currentPartnerProfile.bio;
    SoulUI.applyAvatar($('#profile-avatar'), currentPartnerProfile, fetchBlob);
    
    const viewer = $('#profile-viewer');
    viewer.classList.add('active');
    const grid = $('#profile-media-grid'); grid.innerHTML = '<p class="media-empty">Loading shared media...</p>';
    try {
      const msgs = await SoulChat.fetchHistory();
      grid.innerHTML = '';
      const mediaMsgs = msgs.filter(m => m.kind !== 'text' && m.storagePath);
      if(!mediaMsgs.length) grid.innerHTML = '<p class="media-empty">No media shared yet.</p>';
      mediaMsgs.forEach(m => {
      const media = document.createElement(m.kind === 'video' ? 'video' : 'img');
      if (m.kind === 'video') media.controls = true;
      media.alt = m.kind === 'video' ? 'Shared video' : 'Shared image';
      grid.appendChild(media);
        SoulChat.downloadAndDecryptMedia(m.storagePath, m.fileIv).then(buf => {
        media.src = URL.createObjectURL(new Blob([buf], { type: m.kind === 'video' ? 'video/mp4' : 'image/jpeg' }));
      }).catch(() => media.replaceWith(document.createTextNode('Media unavailable')));
      });
    } catch (err) {
      grid.innerHTML = '<p class="media-empty">Could not load shared media.</p>';
      toast('Could not load shared media: ' + err.message);
    }
  };
  window.closeProfileViewer = () => document.getElementById('profile-viewer').classList.remove('active');

  // Open/close the profile viewer from JS instead of inline onclick
  // attributes — required for the Content-Security-Policy in _headers.
  $('#chat-avatar').addEventListener('click', () => window.openProfileViewer());
  $('#chat-partner-name-box').addEventListener('click', () => window.openProfileViewer());
  $('#btn-close-profile').addEventListener('click', () => window.closeProfileViewer());

  $('#btn-edit-nickname').onclick = async () => {
    const newName = prompt("Enter a custom nickname for this person:", currentPartnerNickname);
    if (newName !== null) {
      try {
        currentPartnerNickname = await SoulChat.setNickname(newName);
        $('#chat-partner-name').textContent = currentPartnerNickname || '@' + currentPartnerProfile.username;
        $('#profile-nickname').textContent = currentPartnerNickname || currentPartnerProfile.username;
      } catch (err) { toast('Could not save nickname: ' + err.message); }
      openProfileViewer();
    }
  };

  // ===================== STATUS VIEWER =====================
  // Instagram/WhatsApp style: full-screen, one progress segment per
  // update, tap left/right to move. Every update shows for 15 seconds;
  // videos are also cut off at 15 seconds (a shorter video's own
  // "ended" event advances first).
  function openStatusViewer(username, key, statuses, options = {}) {
    const token = ++statusViewerToken;
    let index = 0;
    let advanceTimer = null;
    let currentSnippet = '';
    const viewer = $('#status-viewer');
    const progress = $('#status-progress');
    const content = $('#status-content');
    $('#status-title').textContent = '@' + username;
    progress.innerHTML = statuses.map(() => '<div class="seg"><div class="fill"></div></div>').join('');
    viewer.classList.add('active');

    function stopTimer() { clearTimeout(advanceTimer); advanceTimer = null; }
    function setFills() {
      progress.querySelectorAll('.seg').forEach((seg, i) => {
        const fill = seg.querySelector('.fill');
        fill.style.transition = 'none';
        fill.style.width = i < index ? '100%' : '0%';
      });
    }
    function runFill() {
      const fill = progress.querySelectorAll('.seg')[index]?.querySelector('.fill');
      if (!fill) return;
      fill.style.transition = `width ${STATUS_DURATION_MS}ms linear`;
      requestAnimationFrame(() => { fill.style.width = '100%'; });
    }
    function advance(step) {
      const nextIndex = index + step;
      if (nextIndex >= statuses.length) { closeViewer(); return; }
      if (nextIndex < 0) return;
      index = nextIndex;
      showCurrent();
    }
    function scheduleNext() {
      runFill();
      advanceTimer = setTimeout(() => advance(1), STATUS_DURATION_MS);
    }
    async function showCurrent() {
      stopTimer();
      content.innerHTML = '';
      content.style.background = '';
      const s = statuses[index];
      setFills();
      $('#status-time').textContent = fmtRelative(s.createdAt);
      currentSnippet = s.kind === 'text' ? (s.text || '') : (s.caption || (s.kind === 'video' ? 'a video' : 'a photo'));
      try { await SoulStatus.markViewed(s.id); } catch (_) { /* viewing still proceeds */ }
      if (s.kind === 'text') {
        content.style.background = STATUS_BG[s.bg] || STATUS_BG.grape;
        const text = document.createElement('div');
        text.className = 'story-text';
        text.textContent = s.text ?? '';
        content.appendChild(text);
        scheduleNext();
        return;
      }
      const tag = document.createElement(s.kind === 'video' ? 'video' : 'img');
      if (s.kind === 'video') {
        tag.autoplay = true;
        tag.playsInline = true;
        tag.onended = () => advance(1);
      }
      content.appendChild(tag);
      try {
        const buf = await SoulStatus.downloadAndDecryptMedia(key, s.storagePath, s.fileIv);
        tag.src = URL.createObjectURL(new Blob([buf], { type: s.kind === 'video' ? 'video/mp4' : 'image/jpeg' }));
        if (s.kind === 'video') {
          tag.play().catch(() => { tag.muted = true; tag.play().catch(() => {}); });
        }
      } catch (err) {
        content.textContent = '[update unavailable]';
        toast('Could not load status: ' + err.message);
        scheduleNext();
        return;
      }
      if (s.caption) {
        const caption = document.createElement('div');
        caption.className = 'story-caption';
        caption.textContent = s.caption;
        content.appendChild(caption);
      }
      scheduleNext();
    }
    function closeViewer() {
      if (token !== statusViewerToken) return;
      stopTimer();
      viewer.classList.remove('active');
      content.innerHTML = '';
      content.style.background = '';
      renderStatusScreen();
    }
    $('#status-close').onclick = closeViewer;
    $('#status-next').onclick = () => advance(1);
    $('#status-prev').onclick = () => advance(-1);

    // Own statuses show a viewers list; partner statuses get Reply.
    const replyButton = $('#status-reply');
    const viewersButton = $('#status-viewers');
    if (options.own) {
      replyButton.hidden = true;
      viewersButton.hidden = false;
      SoulStatus.fetchOwnViewers().then((viewers) => {
        const total = viewers.reduce((sum, v) => sum + v.count, 0);
        viewersButton.textContent = `👁 ${total} view${total === 1 ? '' : 's'}`;
        viewersButton.onclick = () => openViewersSheet(viewers);
      }).catch(() => { viewersButton.hidden = true; });
    } else {
      viewersButton.hidden = true;
      replyButton.hidden = !options.profile;
      replyButton.onclick = () => {
        statusReplyContext = { profile: options.profile, snippet: currentSnippet };
        closeViewer();
        enterChat(options.profile);
      };
    }
    showCurrent();
  }

  // ===================== SETTINGS =====================
  function renderSettings() {
    updateRetentionControls();
    const session = SoulAuth.current();
    $('#profile-display-name').value = session.profile.display_name || '';
    $('#profile-bio-input').value = session.profile.bio || '';
    const isDark = document.documentElement.dataset.theme === 'dark';
    $('#toggle-theme').classList.toggle('on', isDark);
    $('#toggle-theme').setAttribute('aria-checked', String(isDark));
    const soundOn = SoulUI.soundEnabled();
    $('#toggle-sound').classList.toggle('on', soundOn);
    $('#toggle-sound').setAttribute('aria-checked', String(soundOn));
    const toggle = $('#toggle-retention');
    toggle.onclick = async () => {
      const autoDelete = !toggle.classList.contains('on'); showSpinner(true);
      try {
        await SoulChat.setRetention(!autoDelete);
        updateRetentionControls();
        toast(autoDelete ? 'Auto-delete enabled.' : 'Auto-delete disabled.');
      }
      catch (err) { toast('Update failed: ' + err.message); } finally { showSpinner(false); }
    };
  }

  $('#toggle-theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('soulnix-theme', next); } catch (_) { /* ignore */ }
    const isDark = next === 'dark';
    $('#toggle-theme').classList.toggle('on', isDark);
    $('#toggle-theme').setAttribute('aria-checked', String(isDark));
  };
  $('#toggle-sound').onclick = () => {
    SoulUI.setSoundEnabled(!SoulUI.soundEnabled());
    const on = SoulUI.soundEnabled();
    $('#toggle-sound').classList.toggle('on', on);
    $('#toggle-sound').setAttribute('aria-checked', String(on));
    if (on) SoulUI.playSent();
  };
  $('#btn-profile-save').onclick = async () => {
    const displayName = $('#profile-display-name').value.trim().slice(0, 40);
    const bio = $('#profile-bio-input').value.trim().slice(0, 160);
    showSpinner(true);
    try {
      await SoulChat.updateOwnProfile({ display_name: displayName || null, bio: bio || null });
      toast('Profile updated.');
    } catch (err) { toast('Could not save profile: ' + err.message); } finally { showSpinner(false); }
  };
})();
