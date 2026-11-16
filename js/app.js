(function () {
  // GitHub Pages cannot send anti-clickjacking headers (X-Frame-Options /
  // frame-ancestors), so refuse to run embedded in another page instead.
  if (window.top !== window.self) { window.top.location = window.location; }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: window.sessionStorage, storageKey: 'soulnix-auth-token' },
  });
  SoulAuth.init(supabase);

  let currentPartnerProfile = null;
  let partnerConversationKey = null;
  let currentPartnerNickname = '';
  let currentChatAutoDelete = true;
  let chatBackgroundUrl = null;
  let loadingChat = false;
  const queuedChatMessages = [];
  let statusAutoAdvanceTimer = null;
  const renderedMessageGroups = new Set();
  const messageRowsByGroup = new Map();
  const messageDataByGroup = new Map();
  const pendingMessageReceipts = new Map();
  let statusProfilesById = new Map();
  let statusTrayRenderId = 0;

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
    renderRecentChats();
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
        const activity = document.createElement('span');
        activity.className = 'recent-chat-time';
        activity.textContent = `@${profile.username} - ${new Date(profile.lastMessageAt).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })}`;
        details.append(name, activity);
        item.append(avatar, details);
        item.onclick = () => enterChat(profile);
        list.appendChild(item);
      }
      if (!recentChats.length) empty.hidden = false;
      renderStatusTray(recentChats).catch(err => toast('Could not load statuses: ' + err.message));
    } catch (err) {
      list.textContent = 'Could not load recent chats.';
      empty.hidden = true;
      toast('Could not load recent chats: ' + err.message);
    }
  }

  async function renderStatusTray(profiles) {
    const renderId = ++statusTrayRenderId;
    const recipient = $('#status-recipient');
    const items = $('#partner-status-row');
    statusProfilesById = new Map(profiles.map(profile => [profile.id, profile]));
    recipient.innerHTML = '<option value="">Choose a recent chat partner</option>';
    items.innerHTML = '';
    for (const profile of profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `@${profile.username}`;
      recipient.appendChild(option);
    }

    $('#btn-post-text-status').disabled = profiles.length === 0;
    $('#btn-upload-status').disabled = profiles.length === 0;
    if (!profiles.length) {
      items.textContent = 'Start a chat before sharing a status.';
      return;
    }

    await SoulStatus.cleanupExpired();
    const statusItems = [];
    for (const profile of profiles) {
      const key = await SoulChat.getConversationKeyForProfile(profile);
      const statuses = await SoulStatus.fetchStatusesFor(profile, key);
      if (statuses.length) statusItems.push({ profile, key, statuses });
    }
    if (renderId !== statusTrayRenderId) return;
    if (!statusItems.length) {
      items.textContent = 'No new status updates from your chat partners.';
      return;
    }
    for (const { profile, key, statuses } of statusItems) {
      const unseen = statuses.some(status => !status.viewedAt);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'status-item';
      button.setAttribute('aria-label', `View @${profile.username}'s status`);
      const ring = document.createElement('span');
      ring.className = `status-ring ${unseen ? '' : 'seen'}`;
      ring.textContent = initials(profile.username);
      const name = document.createElement('span');
      name.className = 'status-item-name';
      name.textContent = `@${profile.username}`;
      button.append(ring, name);
      button.onclick = () => {
        SoulStatus.setPartner(profile, key);
        openStatusViewer(statuses, profile.username);
      };
      items.appendChild(button);
    }
  }

  function selectedStatusProfile() {
    const profile = statusProfilesById.get($('#status-recipient').value);
    if (!profile) throw new Error('Choose a recent chat partner first.');
    return profile;
  }

  async function prepareStatusTarget() {
    const profile = selectedStatusProfile();
    const key = await SoulChat.getConversationKeyForProfile(profile);
    SoulStatus.setPartner(profile, key);
    return profile;
  }

  async function refreshStatusTray() {
    renderStatusTray(await SoulChat.fetchRecentChats())
      .catch(err => toast('Could not refresh statuses: ' + err.message));
  }

  $('#btn-post-text-status').onclick = async () => {
    const text = $('#status-text').value.trim();
    if (!text) { toast('Write a status first.'); return; }
    showSpinner(true);
    try {
      const profile = await prepareStatusTarget();
      await SoulStatus.postText(text);
      $('#status-text').value = '';
      toast(`Status shared with @${profile.username} for 24 hours.`);
      await refreshStatusTray();
    } catch (err) {
      toast('Could not post status: ' + err.message);
    } finally { showSpinner(false); }
  };

  $('#btn-upload-status').onclick = () => $('#status-file-input').click();
  $('#status-file-input').onchange = async (event) => {
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
    showSpinner(true);
    try {
      const profile = await prepareStatusTarget();
      await SoulStatus.postMedia(file, file.type.startsWith('video/') ? 'video' : 'image');
      toast(`Status shared with @${profile.username} for 24 hours.`);
      await refreshStatusTray();
    } catch (err) {
      toast('Could not upload status: ' + err.message);
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

  $('#btn-logout').onclick = async () => { SoulChat.closeConversation(); await SoulAuth.logOut(); showScreen('#screen-auth'); };
  $('#btn-back-home-2').onclick = () => showScreen('#screen-home');
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
    showScreen('#screen-home');
    SoulChat.subscribeHome();
    renderRecentChats();
  };

  document.addEventListener('soul:recent-chats-updated', (e) => renderRecentChats(e.detail));
  document.addEventListener('soul:statuses-updated', () => refreshStatusTray());
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
      partnerConversationKey = SoulChat.getConversationKey();
      SoulStatus.setPartner(profile, partnerConversationKey);

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

  // ===================== STATUS (story) =====================
  function openStatusViewer(statuses, username) {
    let index = 0;
    const viewer = $('#status-viewer'); const progress = $('#status-progress'); const content = $('#status-content');
    $('#status-title').textContent = `@${username}'s status`;
    progress.innerHTML = statuses.map(() => '<div class="seg"><div class="fill"></div></div>').join('');
    viewer.classList.add('active');

    function animateFill(durationMs) {
      const fill = progress.querySelectorAll('.seg')[index]?.querySelector('.fill');
      if (!fill) return;
      fill.style.transition = `width ${durationMs}ms linear`;
      requestAnimationFrame(() => { fill.style.width = '100%'; });
    }
    function resetFills() {
      progress.querySelectorAll('.seg').forEach((seg, i) => {
        const fill = seg.querySelector('.fill');
        fill.style.transition = 'none';
        fill.style.width = i < index ? '100%' : '0%';
      });
    }

    async function showCurrent() {
      clearTimeout(statusAutoAdvanceTimer);
      content.innerHTML = '';
      const s = statuses[index];
      resetFills();
      try {
        await SoulStatus.markViewed(s.id);
      } catch (err) {
        toast('Could not mark status as seen: ' + err.message);
      }
      if (s.kind === 'text') {
        content.textContent = s.text;
        animateFill(5000);
        statusAutoAdvanceTimer = setTimeout(next, 5000);
      } else {
        const tag = document.createElement(s.kind === 'video' ? 'video' : 'img');
        if (s.kind === 'video') {
          // Let the video play to its end — the old 5-second timer cut
          // every clip off mid-playback. Images and text still advance
          // automatically after 5 seconds.
          tag.controls = true;
          tag.autoplay = true;
          tag.onended = next;
        }
        content.appendChild(tag);
        try {
          const buf = await SoulStatus.downloadAndDecryptMedia(s.storagePath, s.fileIv);
          tag.src = URL.createObjectURL(new Blob([buf], { type: s.kind === 'video' ? 'video/mp4' : 'image/jpeg' }));
          if (s.kind === 'image') {
            animateFill(5000);
            statusAutoAdvanceTimer = setTimeout(next, 5000);
          }
        } catch (err) {
          content.textContent = '[update unavailable]';
          toast('Could not load status: ' + err.message);
          animateFill(5000);
          statusAutoAdvanceTimer = setTimeout(next, 5000);
        }
      }
    }
    function next() { index++; if (index >= statuses.length) { closeViewer(); return; } showCurrent(); }
    function closeViewer() {
      clearTimeout(statusAutoAdvanceTimer);
      viewer.classList.remove('active');
      content.innerHTML = '';
      refreshStatusTray();
    }
    $('#status-close').onclick = closeViewer; showCurrent();
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