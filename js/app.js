(function () {
  // GitHub Pages cannot send anti-clickjacking headers (X-Frame-Options /
  // frame-ancestors), so refuse to run embedded in another page instead.
  if (window.top !== window.self) { window.top.location = window.location; }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: window.sessionStorage, storageKey: 'soulnix-auth-token' },
  });
  SoulAuth.init(supabase);

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
    $('#home-username').textContent = '@' + session.profile.username;
    $('#home-avatar').innerHTML = session.profile.avatar_url ? '<img src="" id="home-avatar-img">' : initials(session.profile.username);
    if(session.profile.avatar_url) {
      supabase.storage.from('encrypted-media').download(session.profile.avatar_url).then(({ data, error }) => {
        if (error) throw error;
        const image = $('#home-avatar-img');
        if (data && image) image.src = URL.createObjectURL(data);
      }).catch(err => toast('Could not load profile picture: ' + err.message));
    }
    showScreen('#screen-home');
    SoulChat.subscribeHome();
    startPresence();
    switchTab('chats');
  }

  async function renderRecentChats(chats) {
    const list = $('#recent-chats');
    const empty = $('#recent-chats-empty');
    list.textContent = 'Loading chats...';
    try {
      const recentChats = chats || await SoulChat.fetchRecentChats();
      list.innerHTML = '';
      empty.hidden = recentChats.length > 0;
      for (const profile of recentChats) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'recent-chat';
        item.setAttribute('aria-label', `Open chat with @${profile.username}`);

        const avatar = document.createElement('span');
        avatar.className = 'recent-avatar';
        avatar.textContent = initials(profile.username);
        if (profile.avatar_url) {
          const image = document.createElement('img');
          image.alt = '';
          avatar.textContent = '';
          avatar.appendChild(image);
          supabase.storage.from('encrypted-media').download(profile.avatar_url).then(({ data, error }) => {
            if (error) throw error;
            if (data) image.src = URL.createObjectURL(data);
          }).catch(err => toast('Could not load profile picture: ' + err.message));
        }

        const details = document.createElement('span');
        details.className = 'recent-chat-details';
        const name = document.createElement('span');
        name.className = 'recent-chat-name';
        name.textContent = profile.chatNickname || '@' + profile.username;
        // WhatsApp-style presence line under the username instead of the
        // old "@username - date" preview.
        const presence = document.createElement('span');
        presence.className = 'recent-chat-time recent-chat-presence';
        presence.textContent = presenceLabel(profile.last_seen_at);
        presence.classList.toggle('online', presence.textContent === 'online');
        details.append(name, presence);
        item.append(avatar, details);
        item.onclick = () => enterChat(profile);
        list.appendChild(item);
      }
      if (!recentChats.length) empty.hidden = false;
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
      myOwnGroups = ownGroups;
      $('#my-status-avatar').classList.toggle('has-status', ownCount > 0);

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
        row.onclick = () => openStatusViewer(profile.username, key, statuses);
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
    const items = myOwnGroups.flatMap(group => group.statuses.map(s => ({ ...s, key: group.key })));
    if (items.length) {
      openStatusViewer(SoulAuth.current().profile.username, items[0].key, items);
    } else {
      openStatusComposer();
    }
  };
  document.querySelector('.my-status-plus').onclick = (e) => {
    e.stopPropagation();
    openStatusComposer();
  };
  $('#btn-composer-back').onclick = () => switchTab('status');

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
    $('#chat-retention-note').textContent = currentChatAutoDelete ? 'Auto-delete after 10 min' : 'Messages kept';
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
      $('#home-avatar').innerHTML = '<img src="" id="home-avatar-img">';
      supabase.storage.from('encrypted-media').download(SoulAuth.current().profile.avatar_url).then(({ data, error }) => {
        if (error) throw error;
        const image = $('#home-avatar-img');
        if (data && image) image.src = URL.createObjectURL(data);
      }).catch(err => toast('Profile picture saved, but could not display it: ' + err.message));
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

      currentChatAutoDelete = await SoulChat.getAutoDelete();
      currentPartnerNickname = await SoulChat.getNickname();
      $('#chat-partner-name').textContent = currentPartnerNickname || '@' + profile.username;
      $('#chat-avatar').innerHTML = profile.avatar_url ? '<img src="" id="chat-avatar-img">' : initials(profile.username);
      
      if(profile.avatar_url) {
        supabase.storage.from('encrypted-media').download(profile.avatar_url).then(({ data, error }) => {
          if (error) throw error;
          const image = $('#chat-avatar-img');
          if(data && image) image.src = URL.createObjectURL(data);
        }).catch(err => toast('Could not load profile picture: ' + err.message));
      }

      const background = await SoulChat.getChatBackground();
      await applyChatBackground(background);

      $('#messages').innerHTML = '';
      for (const msg of history) appendBubble(msg);
      loadingChat = false;
      for (const msg of queuedChatMessages.splice(0)) appendBubble(msg);
      scrollMessagesToBottom();
      updateRetentionControls();
      showScreen('#screen-chat');
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

  function appendBubble(msg) {
    if (msg.groupId && renderedMessageGroups.has(msg.groupId)) return;
    if (msg.groupId) renderedMessageGroups.add(msg.groupId);
    const message = { ...msg };
    const pendingReceipt = msg.groupId && pendingMessageReceipts.get(msg.groupId);
    if (pendingReceipt) {
      Object.assign(message, pendingReceipt);
      pendingMessageReceipts.delete(msg.groupId);
    }
    const row = document.createElement('div'); row.className = 'bubble-row ' + (msg.mine ? 'mine' : 'theirs');
    if (msg.groupId) row.dataset.groupId = msg.groupId;
    const bubble = document.createElement('div'); bubble.className = 'bubble';

    if (msg.kind === 'text') {
      bubble.appendChild(document.createTextNode(msg.text ?? '[undecryptable message]'));
    } else if (msg.mediaUnavailable) {
      // The encrypted file for this message no longer exists in storage.
      // Show the decrypted caption (if any) instead of a dead image tag.
      const note = document.createElement('div');
      note.className = 'media-missing';
      note.textContent = msg.caption ? `[media unavailable] ${msg.caption}` : '[media unavailable]';
      bubble.appendChild(note);
    } else {
      const mediaTag = document.createElement(msg.kind === 'video' ? 'video' : 'img');
      if (msg.kind === 'video') mediaTag.controls = true;
      bubble.appendChild(mediaTag);
      if (msg.localUrl) {
        mediaTag.src = msg.localUrl;
      } else {
        SoulChat.downloadAndDecryptMedia(msg.storagePath, msg.fileIv).then((buf) => {
          mediaTag.src = URL.createObjectURL(new Blob([buf], { type: msg.kind === 'video' ? 'video/mp4' : 'image/jpeg' }));
        }).catch(() => { mediaTag.replaceWith(document.createTextNode('[media unavailable]')); });
      }
    }

    const meta = document.createElement('div'); meta.className = 'meta';
    const time = document.createElement('span');
    time.textContent = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.appendChild(time);
    if (msg.mine && msg.groupId) {
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
      messageRowsByGroup.set(msg.groupId, row);
      messageDataByGroup.set(msg.groupId, message);
    }
    bubble.appendChild(meta); row.appendChild(bubble); $('#messages').appendChild(row);
  }

  function updateReceiptButton(button, message) {
    const state = message.readAt ? 'seen' : message.deliveredAt ? 'delivered' : 'sent';
    const dotCount = message.readAt ? 3 : message.deliveredAt ? 2 : 1;
    button.textContent = '\u25CF'.repeat(dotCount);
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

  let sendingText = false;
  $('#btn-send').onclick = async () => {
    const text = $('#msg-input').value.trim();
    if (!text || sendingText) return;
    if (loadingChat || !SoulChat.getConversationKey()) {
      toast('Chat is still loading — try again in a second.');
      return;
    }
    sendingText = true;
    $('#msg-input').value = '';
    try {
      const sent = await SoulChat.sendText(text);
      appendBubble({ groupId: sent.groupId, mine: true, kind: 'text', text, createdAt: sent.createdAt });
      scrollMessagesToBottom();
    } catch (err) {
      // Put the text back so a failed send (e.g. offline) doesn't lose it.
      $('#msg-input').value = text;
      toast(err.message);
    } finally { sendingText = false; }
  };
  $('#msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-send').click(); });

  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    const maxSize = file.type.startsWith('video/') ? 50 * 1024 * 1024 : 15 * 1024 * 1024;
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { toast('Choose an image or video file.'); return; }
    if (file.size > maxSize) { toast(`File is too large (maximum ${maxSize / (1024 * 1024)} MB).`); return; }
    if (loadingChat || !SoulChat.getConversationKey()) { toast('Chat is still loading — try again in a second.'); return; }
    const kind = file.type.startsWith('video') ? 'video' : 'image';
    showSpinner(true);
    try {
      const sent = await SoulChat.sendMedia(file, kind);
      const localUrl = URL.createObjectURL(file);
      appendBubble({ groupId: sent.groupId, mine: true, kind, createdAt: sent.createdAt, localUrl });
      scrollMessagesToBottom();
    } catch (err) { toast('Upload failed: ' + err.message); } finally { showSpinner(false); }
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
      await SoulChat.setAutoDelete(enabled);
      currentChatAutoDelete = enabled;
      updateRetentionControls();
      toast(enabled ? 'Auto-delete enabled for this chat' : 'Auto-delete disabled for this chat');
      $('#chat-dropdown').classList.remove('active');
    } catch (err) {
      toast('Could not update auto-delete: ' + err.message);
    } finally { showSpinner(false); }
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
    $('#profile-nickname').textContent = currentPartnerNickname || currentPartnerProfile.username;
    $('#profile-username').textContent = '@' + currentPartnerProfile.username;
    $('#profile-avatar').innerHTML = currentPartnerProfile.avatar_url ? '<img src="" id="pv-avatar-img">' : initials(currentPartnerProfile.username);
    
    if(currentPartnerProfile.avatar_url) {
      supabase.storage.from('encrypted-media').download(currentPartnerProfile.avatar_url).then(({ data, error }) => {
        if (error) throw error;
        const image = $('#pv-avatar-img');
        if(data && image) image.src = URL.createObjectURL(data);
      }).catch(err => toast('Could not load profile picture: ' + err.message));
    }
    
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
  function openStatusViewer(username, key, statuses) {
    const token = ++statusViewerToken;
    let index = 0;
    let advanceTimer = null;
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
                const buf = await SoulStatus.downloadAndDecryptMedia(s.key || key, s.storagePath, s.fileIv);
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
    showCurrent();
  }

  // ===================== SETTINGS =====================
  function renderSettings() {
    updateRetentionControls();
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
})();
