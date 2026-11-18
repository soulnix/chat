const SoulChat = (() => {
  let supabase, me, partner = null, conversationKey = null, channel = null, homeChannel = null, partnerAutoDelete = true;
  let partnerAutoDeleteMinutes = AUTO_DELETE_MINUTES;
  let sweepTimer = null;
  let typingChannel = null;
  let lastTypingSent = 0;
  const peerPublicKeyCache = new Map();

  function init(client, session) {
    supabase = client;
    me = session;
  }

  async function lookupProfileByUsername(username) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, public_key, retain_messages, avatar_url, last_seen_at, display_name, bio')
      .eq('username', username.trim().toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getConversationKeyForProfile(profile) {
    let publicKey = peerPublicKeyCache.get(profile.id);
    if (!publicKey) {
      publicKey = await SoulCrypto.importPublicKey(profile.public_key);
      peerPublicKeyCache.set(profile.id, publicKey);
    }
    return SoulCrypto.deriveConversationKey(me.identityPrivateKey, publicKey);
  }

  // ---- local "recent chats" storage ----
  // Previously a single corrupt JSON blob in localStorage threw on every
  // load and permanently broke both the home screen and opening any chat.
  // Now a corrupt/unreadable list degrades to empty instead of throwing.
  function readSavedContacts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(`soulnix-chats:${me.user.id}`) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(c => c && typeof c.id === 'string' && typeof c.updatedAt === 'string');
    } catch (_) {
      return [];
    }
  }

  function writeSavedContacts(contacts) {
    try {
      localStorage.setItem(`soulnix-chats:${me.user.id}`, JSON.stringify(contacts));
      return null;
    } catch (storageError) {
      return storageError.message;
    }
  }

  async function fetchRecentChats() {
    const latestByPartner = new Map();
    for (const contact of readSavedContacts()) {
      latestByPartner.set(contact.id, contact.updatedAt);
    }

    const nowIso = new Date().toISOString();
    const unreadByPartner = new Map();
    const { data: messages, error: messagesError } = await supabase.from('messages')
      .select('sender_id, receiver_id, created_at, read_at, delete_at')
      .eq('owner_id', me.user.id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (messagesError) throw messagesError;
    for (const message of messages || []) {
      const partnerId = message.sender_id === me.user.id ? message.receiver_id : message.sender_id;
      const prior = latestByPartner.get(partnerId);
      if (!prior || new Date(message.created_at) > new Date(prior)) latestByPartner.set(partnerId, message.created_at);
      // Unread = an incoming copy nobody opened yet (and not swept).
      if (message.sender_id !== me.user.id && !message.read_at && (!message.delete_at || message.delete_at > nowIso)) {
        unreadByPartner.set(partnerId, (unreadByPartner.get(partnerId) || 0) + 1);
      }
    }

    const partnerIds = [...latestByPartner.keys()];
    if (!partnerIds.length) return [];
    const { data: profiles, error: profilesError } = await supabase.from('profiles')
      .select('id, username, public_key, retain_messages, avatar_url, last_seen_at, display_name')
      .in('id', partnerIds);
    if (profilesError) throw profilesError;
    const { data: preferences, error: preferencesError } = await supabase.from('chat_preferences')
      .select('partner_id, partner_nickname')
      .eq('owner_id', me.user.id)
      .in('partner_id', partnerIds);
    if (preferencesError) throw preferencesError;
    const nicknameByPartner = new Map((preferences || []).map(item => [item.partner_id, item.partner_nickname]));
    return (profiles || [])
      .map(profile => ({
        ...profile,
        chatNickname: nicknameByPartner.get(profile.id) || '',
        lastMessageAt: latestByPartner.get(profile.id),
        unreadCount: unreadByPartner.get(profile.id) || 0,
      }))
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  }

  function rememberContact() {
    const savedContacts = readSavedContacts();
    const nextContact = { id: partner.id, updatedAt: new Date().toISOString() };
    const contacts = [nextContact, ...savedContacts.filter(contact => contact.id !== partner.id)];
    writeSavedContacts(contacts);
  }

  function subscribeHome() {
    if (homeChannel) supabase.removeChannel(homeChannel);
    homeChannel = supabase.channel(`home-messages-${me.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `owner_id=eq.${me.user.id}` }, async (payload) => {
        try {
          if (payload.new.receiver_id === me.user.id && payload.new.sender_id !== me.user.id) {
            await markMessagesDelivered([payload.new.group_id]);
          }
          const chats = await fetchRecentChats();
          document.dispatchEvent(new CustomEvent('soul:recent-chats-updated', { detail: chats }));
        } catch (error) {
          document.dispatchEvent(new CustomEvent('soul:error', { detail: error }));
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'statuses', filter: `viewer_id=eq.${me.user.id}` }, () => {
        document.dispatchEvent(new CustomEvent('soul:statuses-updated'));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          markPendingMessagesDelivered().catch(error => document.dispatchEvent(new CustomEvent('soul:error', { detail: error })));
        }
      });
  }

  async function openConversationWith(profile) {
    partner = profile;
    conversationKey = await getConversationKeyForProfile(profile);
    const autoDeletePref = await getAutoDelete();
    partnerAutoDelete = autoDeletePref.enabled;
    partnerAutoDeleteMinutes = autoDeletePref.minutes || AUTO_DELETE_MINUTES;
    rememberContact();

    await cleanupExpired();
    await markIncomingAsRead();

    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(() => {
      cleanupExpired().catch(error => document.dispatchEvent(new CustomEvent('soul:error', { detail: error })));
    }, 30000);

    subscribeRealtime();
    // Pause the home channel while inside a chat. It used to stay
    // subscribed, so every message triggered a full recent-chats refetch
    // AND a duplicate delivered-receipt RPC alongside the chat channel.
    if (homeChannel) { supabase.removeChannel(homeChannel); homeChannel = null; }
    return fetchHistory();
  }

  function closeConversation() {
    if (channel) { supabase.removeChannel(channel); channel = null; }
    if (homeChannel) { supabase.removeChannel(homeChannel); homeChannel = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    partner = null; conversationKey = null;
  }

  async function fetchHistory() {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('owner_id', me.user.id)
      .or(`sender_id.eq.${partner.id},receiver_id.eq.${partner.id}`)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // One unreadable row (e.g. the sender's copy of a media file already
    // auto-deleted from storage) must not fail the WHOLE chat load —
    // that used to leave the conversation permanently unopenable.
    const out = [];
    for (const row of data) out.push(await decryptRowSafe(row));
    return out;
  }

  async function clearConversation() {
    if (!partner) throw new Error('No chat is currently open.');

    // Delete this account's copies of the messages, collecting storage
    // paths first so the encrypted media files in OUR folder don't leak.
    const { data, error } = await supabase.from('messages')
      .delete()
      .eq('owner_id', me.user.id)
      .or(`sender_id.eq.${partner.id},receiver_id.eq.${partner.id}`)
      .select('id, storage_path');
    if (error) throw error;

    const ownPaths = (data || [])
      .map(row => row.storage_path)
      .filter(path => path && path.startsWith(`${me.user.id}/`));
    if (ownPaths.length) {
      // Best effort: rows are already gone, so a failed file delete only
      // leaves an orphan — never block the clear because of it.
      await supabase.storage.from('encrypted-media').remove(ownPaths).catch(() => {});
    }

    const contacts = readSavedContacts().filter(contact => contact.id !== partner.id);
    const recentChatsError = writeSavedContacts(contacts);
    return { deletedCount: (data || []).length, recentChatsError };
  }

  async function ensureOwnMediaFile(row) {
    if (row.kind === 'text' || !row.storage_path || row.storage_path.startsWith(`${me.user.id}/`)) return row;

    const { data, error: downloadError } = await supabase.storage.from('encrypted-media').download(row.storage_path);
    if (downloadError) throw downloadError;
    const ownPath = `${me.user.id}/${row.group_id}.bin`;
    const { error: uploadError } = await supabase.storage.from('encrypted-media').upload(ownPath, data, {
      upsert: true,
      contentType: 'application/octet-stream',
    });
    if (uploadError) throw uploadError;
    const { data: updated, error: updateError } = await supabase.from('messages')
      .update({ storage_path: ownPath })
      .eq('id', row.id)
      .select('*')
      .single();
    if (updateError) throw updateError;
    return updated;
  }

  // ---- message payloads ----
  // v2 messages are a JSON envelope so one ciphertext can carry the text
  // (or caption) PLUS a reply quote. Everything sent by older versions is
  // plain text and still decrypts the same way — JSON.parse simply fails
  // and the raw string is used as-is.
  function parsePayload(raw) {
    if (!raw) return { text: '', caption: '', reply: null };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 2) {
        return {
          text: typeof parsed.t === 'string' ? parsed.t : '',
          caption: typeof parsed.c === 'string' ? parsed.c : '',
          reply: parsed.r && typeof parsed.r.g === 'string' ? parsed.r : null,
        };
      }
    } catch (_) { /* plain text from an older version */ }
    return { text: raw, caption: raw, reply: null };
  }

  function buildPayload({ text = '', caption = '', reply = null }) {
    const envelope = { v: 2 };
    if (text) envelope.t = text;
    if (caption) envelope.c = caption;
    if (reply) envelope.r = reply;
    return JSON.stringify(envelope);
  }

  async function decryptRow(row, convKey) {
    const key = convKey || conversationKey;
    const base = {
      id: row.id, groupId: row.group_id, mine: row.sender_id === me.user.id,
      kind: row.kind, createdAt: row.created_at, deliveredAt: row.delivered_at, readAt: row.read_at,
      starred: !!row.starred,
    };
    if (row.kind === 'text') {
      const parsed = parsePayload(await SoulCrypto.decryptText(key, row.ciphertext, row.iv));
      base.text = parsed.text;
      base.reply = parsed.reply;
    } else {
      if (row.ciphertext) {
        const parsed = parsePayload(await SoulCrypto.decryptText(key, row.ciphertext, row.iv));
        base.caption = parsed.caption;
        base.reply = parsed.reply;
      } else {
        base.caption = '';
      }
      base.storagePath = row.storage_path;
      base.fileIv = row.file_iv;
    }
    return base;
  }

  // Decrypt one row, falling back to a placeholder instead of throwing.
  // Keeps the chat open when a single media file has already been removed
  // from storage (e.g. the sender's copy expired and was cleaned up).
  async function decryptRowSafe(row, convKey) {
    try {
      return await decryptRow(await ensureOwnMediaFile(row), convKey);
    } catch (_) {
      const base = {
        id: row.id, groupId: row.group_id, mine: row.sender_id === me.user.id,
        kind: row.kind, createdAt: row.created_at, deliveredAt: row.delivered_at, readAt: row.read_at,
        starred: !!row.starred, mediaUnavailable: true,
      };
      if (row.kind !== 'text' && row.ciphertext) {
        try { base.caption = parsePayload(await SoulCrypto.decryptText(convKey || conversationKey, row.ciphertext, row.iv)).caption; } catch (_) { /* leave caption empty */ }
      }
      return base;
    }
  }

  async function sendText(text, reply = null) {
    return deliverTo(partner, { kind: 'text', text, reply });
  }

  async function sendMedia(file, kind, caption = '', reply = null) {
    return deliverTo(partner, { kind, file, caption, reply });
  }

  // Share to any profile WITHOUT switching the open chat (forwarding).
  async function sendToProfile(profile, { text = '', file = null, kind = 'text', caption = '', reply = null }) {
    const key = await getConversationKeyForProfile(profile);
    return deliverTo(profile, { kind, text, file, caption, reply, keyOverride: key });
  }

  // One delivery path for the open partner and forwarded shares alike:
  // encrypt with that conversation's key, upload media into MY storage
  // folder, then let the RPC insert both rows.
  async function deliverTo(profile, { kind, text = '', caption = '', file = null, reply = null, keyOverride = null }) {
    if (!profile) throw new Error('No chat is currently open.');
    const convKey = keyOverride || conversationKey;
    if (!convKey) throw new Error('Chat is still loading — try again in a second.');
    const groupId = crypto.randomUUID();
    const payload = buildPayload({ text, caption, reply });

    let myStoragePath = null;
    let fileIvB64 = null;
    if (file) {
      const arrayBuffer = await file.arrayBuffer();
      const { ciphertext, ivB64 } = await SoulCrypto.encryptFile(convKey, arrayBuffer);
      fileIvB64 = ivB64;
      myStoragePath = `${me.user.id}/${groupId}.bin`;
      const up = await supabase.storage.from('encrypted-media').upload(myStoragePath, new Blob([ciphertext]), { upsert: false });
      if (up.error) throw up.error;
    }
    const enc = await SoulCrypto.encryptText(convKey, payload);
    const createdAt = await insertBothCopies({
      profile, groupId, kind,
      captionCiphertextB64: enc.ciphertextB64, captionIvB64: enc.ivB64,
      myStoragePath, fileIvB64,
    });
    return { groupId, createdAt };
  }

  async function insertBothCopies({ profile, groupId, kind, captionCiphertextB64, captionIvB64, myStoragePath, fileIvB64 }) {
    const { data: authData, error: authError } = await supabase.auth.getSession();
    if (authError) throw authError;
    const authenticatedUserId = authData.session?.user.id;
    if (authenticatedUserId !== me.user.id) {
      throw new Error('This tab is signed in as a different user. Refresh and sign in again before sending.');
    }
    if (profile.id === authenticatedUserId) {
      throw new Error('You cannot send a message to your own account. Check the selected chat.');
    }
    let minutes = AUTO_DELETE_MINUTES;
    let enabled = !me.profile.retain_messages;
    if (partner && profile.id === partner.id) {
      minutes = partnerAutoDeleteMinutes;
      enabled = partnerAutoDelete;
    }
    const deleteAt = enabled ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null;
    const { data: rpcCreatedAt, error } = await supabase.rpc('send_chat_message_copies', {
      p_group_id: groupId,
      p_receiver_id: profile.id,
      p_kind: kind,
      p_ciphertext: captionCiphertextB64,
      p_iv: captionIvB64,
      p_storage_path: myStoragePath || null,
      p_file_iv: fileIvB64 || null,
      p_delete_at: deleteAt,
    });
    if (error && (error.code === 'PGRST202' || error.code === '42883')) {
      throw new Error('Message database function is missing. Run the updated supabase_setup.sql in Supabase, then refresh.');
    }
    if (error) throw error;
    let createdAt = rpcCreatedAt;
    if (typeof createdAt !== 'string') {
      const { data: message, error: timestampError } = await supabase.from('messages')
        .select('created_at')
        .eq('owner_id', authenticatedUserId)
        .eq('group_id', groupId)
        .maybeSingle();
      if (timestampError) throw new Error(`Message was sent, but its timestamp could not be loaded: ${timestampError.message}`);
      if (!message) throw new Error('Message request succeeded, but the sent message could not be found. Refresh to verify delivery.');
      createdAt = message.created_at;
    }
    return createdAt;
  }

  async function downloadAndDecryptMedia(storagePath, fileIvB64) {
    const { data, error } = await supabase.storage.from('encrypted-media').download(storagePath);
    if (error) throw error;
    const ciphertextBuf = await data.arrayBuffer();
    return SoulCrypto.decryptFile(conversationKey, ciphertextBuf, fileIvB64);
  }

  async function markMessagesDelivered(groupIds) {
    const uniqueGroupIds = [...new Set(groupIds.filter(Boolean))];
    if (!uniqueGroupIds.length) return;
    const { error } = await supabase.rpc('mark_chat_messages_delivered', { p_group_ids: uniqueGroupIds });
    if (error) throw error;
  }

  async function markPendingMessagesDelivered() {
    const { data, error } = await supabase.from('messages')
      .select('group_id')
      .eq('owner_id', me.user.id)
      .eq('receiver_id', me.user.id)
      .is('delivered_at', null);
    if (error) throw error;
    await markMessagesDelivered((data || []).map(row => row.group_id));
  }

  async function markIncomingAsRead() {
    const { data: unread, error } = await supabase.from('messages')
      .select('id, group_id')
      .eq('owner_id', me.user.id)
      .eq('sender_id', partner.id)
      .is('read_at', null);
    if (error) throw error;
    if (!unread || !unread.length) return;

    const groupIds = unread.map(row => row.group_id);
    const { error: receiptError } = await supabase.rpc('mark_chat_messages_read', { p_group_ids: groupIds });
    if (receiptError) throw receiptError;
    const deleteAt = partnerAutoDelete ? new Date(Date.now() + partnerAutoDeleteMinutes * 60 * 1000).toISOString() : null;
    const { error: updateError } = await supabase.from('messages')
      .update({ delete_at: deleteAt })
      .in('id', unread.map(row => row.id));
    if (updateError) throw updateError;
  }

  async function cleanupExpired() {
    const { data: expired, error } = await supabase.from('messages').select('id, group_id, storage_path').eq('owner_id', me.user.id).lt('delete_at', new Date().toISOString());
    if (error) throw error;
    if (!expired || !expired.length) return;
    const ownPaths = expired.filter(row => row.storage_path && row.storage_path.startsWith(`${me.user.id}/`)).map(row => row.storage_path);
    if (ownPaths.length) {
      const { error: storageError } = await supabase.storage.from('encrypted-media').remove(ownPaths);
      if (storageError) throw storageError;
    }
    const { error: deleteError } = await supabase.from('messages').delete().in('id', expired.map(r => r.id));
    if (deleteError) throw deleteError;
    document.dispatchEvent(new CustomEvent('soul:messages-expired', { detail: expired.map(row => row.group_id) }));
  }

  function subscribeRealtime() {
    if (channel) supabase.removeChannel(channel);
    channel = supabase.channel(`messages-${me.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `owner_id=eq.${me.user.id}` }, async (payload) => {
        if (!partner || (payload.new.sender_id !== partner.id && payload.new.receiver_id !== partner.id)) return;
        try {
          const decrypted = await decryptRowSafe(payload.new);
          document.dispatchEvent(new CustomEvent('soul:new-message', { detail: decrypted }));
          if (payload.new.sender_id === partner.id) {
            await markMessagesDelivered([payload.new.group_id]);
            await markIncomingAsRead();
          }
        } catch (error) {
          document.dispatchEvent(new CustomEvent('soul:error', { detail: error }));
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `owner_id=eq.${me.user.id}` }, (payload) => {
        if (payload.new.sender_id !== me.user.id || payload.new.receiver_id !== partner?.id || !payload.new.group_id) return;
        document.dispatchEvent(new CustomEvent('soul:message-receipt-updated', {
          detail: {
            groupId: payload.new.group_id,
            deliveredAt: payload.new.delivered_at,
            readAt: payload.new.read_at,
          },
        }));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_backgrounds', filter: `partner_id=eq.${me.user.id}` }, async (payload) => {
        if (!partner || payload.new.owner_id !== partner.id) return;
        document.dispatchEvent(new CustomEvent('soul:background-updated', {
          detail: { storagePath: payload.new.storage_path, fileIv: payload.new.file_iv },
        }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (payload) => {
        const row = payload.new || payload.old;
        if (row && row.group_id) {
          document.dispatchEvent(new CustomEvent('soul:reaction-updated', { detail: { groupId: row.group_id } }));
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && partner) {
          markIncomingAsRead().catch(error => document.dispatchEvent(new CustomEvent('soul:error', { detail: error })));
        }
      });
  }

  async function setRetention(retain) {
    const { error } = await supabase.from('profiles').update({ retain_messages: retain }).eq('id', me.user.id);
    if (error) throw error;
    me.profile.retain_messages = retain;
  }

  async function getAutoDelete() {
    const { data, error } = await supabase.from('chat_preferences')
      .select('auto_delete, auto_delete_minutes')
      .eq('owner_id', me.user.id)
      .eq('partner_id', partner.id)
      .maybeSingle();
    if (error) throw error;
    return {
      enabled: data ? data.auto_delete : !me.profile.retain_messages,
      minutes: (data && data.auto_delete_minutes) || AUTO_DELETE_MINUTES,
    };
  }

  async function setAutoDelete(enabled, minutes = AUTO_DELETE_MINUTES) {
    const { error } = await supabase.from('chat_preferences').upsert({
      owner_id: me.user.id,
      partner_id: partner.id,
      auto_delete: enabled,
      auto_delete_minutes: minutes,
    }, { onConflict: 'owner_id,partner_id' });
    if (error) throw error;
    partnerAutoDelete = enabled;
    partnerAutoDeleteMinutes = minutes;
  }

  // ---- starred messages ----
  async function setStarred(rowId, starred) {
    const { error } = await supabase.from('messages')
      .update({ starred })
      .eq('id', rowId)
      .eq('owner_id', me.user.id);
    if (error) throw error;
  }

  // Starred messages across ALL chats. Each partner's rows decrypt with
  // that conversation's key, so the partner profile rides along.
  async function fetchStarredMessages() {
    const { data, error } = await supabase.from('messages')
      .select('*')
      .eq('owner_id', me.user.id)
      .eq('starred', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const byPartner = new Map();
    for (const row of data || []) {
      const otherId = row.sender_id === me.user.id ? row.receiver_id : row.sender_id;
      if (!byPartner.has(otherId)) byPartner.set(otherId, []);
      byPartner.get(otherId).push(row);
    }
    if (!byPartner.size) return [];
    const { data: profiles, error: profilesError } = await supabase.from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', [...byPartner.keys()]);
    if (profilesError) throw profilesError;
    const out = [];
    for (const profile of profiles || []) {
      const key = await getConversationKeyForProfile(profile);
      for (const row of byPartner.get(profile.id)) {
        try {
          out.push({ ...(await decryptRow(row, key)), partner: profile });
        } catch (_) { /* skip a row that can no longer be decrypted */ }
      }
    }
    return out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // Remove MY copy of one message (long-press → delete). The other
  // account's copy is untouched, exactly like clearing a whole chat.
  async function deleteMessage(groupId) {
    const { data, error } = await supabase.from('messages')
      .delete()
      .eq('owner_id', me.user.id)
      .eq('group_id', groupId)
      .select('id, storage_path');
    if (error) throw error;
    const ownPaths = (data || []).map(row => row.storage_path).filter(p => p && p.startsWith(`${me.user.id}/`));
    if (ownPaths.length) await supabase.storage.from('encrypted-media').remove(ownPaths).catch(() => {});
  }

  // ---- reactions ----
  // emoji === null removes my reaction (toggle-off).
  async function setReaction(groupId, emoji) {
    await supabase.from('message_reactions')
      .delete()
      .eq('group_id', groupId)
      .eq('reactor_id', me.user.id);
    if (!emoji) return null;
    const { error } = await supabase.from('message_reactions').insert({
      group_id: groupId,
      reactor_id: me.user.id,
      emoji,
    });
    if (error) throw error;
    return emoji;
  }

  async function fetchReactions(groupIds) {
    if (!groupIds.length) return new Map();
    const { data, error } = await supabase.from('message_reactions')
      .select('group_id, reactor_id, emoji')
      .in('group_id', groupIds);
    if (error) throw error;
    const map = new Map();
    for (const row of data || []) {
      if (!map.has(row.group_id)) map.set(row.group_id, []);
      map.get(row.group_id).push({ reactorId: row.reactor_id, emoji: row.emoji });
    }
    return map;
  }

  // ---- typing indicator (realtime broadcast, never touches the DB) ----
  function startTypingChannel() {
    if (typingChannel) return;
    typingChannel = supabase.channel('soul-typing', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload && payload.to === me.user.id && payload.from) {
          document.dispatchEvent(new CustomEvent('soul:partner-typing', { detail: { from: payload.from } }));
        }
      })
      .subscribe();
  }

  function sendTyping(toId) {
    if (!typingChannel || !toId) return;
    const now = Date.now();
    if (now - lastTypingSent < 2000) return; // throttle to one ping per 2 s
    lastTypingSent = now;
    typingChannel.send({ type: 'broadcast', event: 'typing', payload: { from: me.user.id, to: toId } });
  }

  async function uploadChatBackground(file) {
    const arrayBuffer = await file.arrayBuffer();
    const { ciphertext, ivB64 } = await SoulCrypto.encryptFile(conversationKey, arrayBuffer);
    const myPath = `${me.user.id}/bg_${crypto.randomUUID()}.bin`;
    const blob = new Blob([ciphertext]);
    const { error: uploadError } = await supabase.storage.from('encrypted-media').upload(myPath, blob, { upsert: false });
    if (uploadError) throw uploadError;

    // Only the newest background is ever used, so remove our previous
    // rows and their encrypted files instead of leaking them forever.
    try {
      const { data: oldRows } = await supabase.from('chat_backgrounds')
        .select('id, storage_path')
        .eq('owner_id', me.user.id)
        .eq('partner_id', partner.id);
      if (oldRows && oldRows.length) {
        const oldPaths = oldRows.map(row => row.storage_path).filter(Boolean);
        if (oldPaths.length) await supabase.storage.from('encrypted-media').remove(oldPaths);
        await supabase.from('chat_backgrounds').delete().in('id', oldRows.map(row => row.id));
      }
    } catch (_) { /* best effort — never block the new background */ }

    const { error } = await supabase.from('chat_backgrounds').insert({
      owner_id: me.user.id,
      partner_id: partner.id,
      storage_path: myPath,
      file_iv: ivB64,
    });
    if (error) {
      // Row insert failed — don't leave the uploaded file orphaned either.
      await supabase.storage.from('encrypted-media').remove([myPath]).catch(() => {});
      throw error;
    }
    return { storagePath: myPath, fileIv: ivB64 };
  }

  async function getChatBackground() {
    const { data, error } = await supabase.from('chat_backgrounds')
      .select('owner_id, storage_path, file_iv, created_at')
      .or(`and(owner_id.eq.${me.user.id},partner_id.eq.${partner.id}),and(owner_id.eq.${partner.id},partner_id.eq.${me.user.id})`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? { storagePath: data.storage_path, fileIv: data.file_iv } : null;
  }

  async function uploadAvatar(file) {
    const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const path = `${me.user.id}/avatar${extension ? `.${extension}` : ''}`;
    const { error: uploadError } = await supabase.storage.from('encrypted-media').upload(path, file, {
      upsert: true,
      contentType: file.type || 'application/octet-stream',
    });
    if (uploadError) throw uploadError;
    const { error } = await supabase.from('profiles').update({ avatar_url: path }).eq('id', me.user.id);
    if (error) throw error;
    me.profile.avatar_url = path;
  }

  async function updateOwnProfile({ display_name, bio }) {
    const { error } = await supabase.from('profiles')
      .update({ display_name, bio })
      .eq('id', me.user.id);
    if (error) throw error;
    me.profile.display_name = display_name;
    me.profile.bio = bio;
  }

  async function getNickname() {
    const { data, error } = await supabase.from('chat_preferences')
      .select('partner_nickname')
      .eq('owner_id', me.user.id)
      .eq('partner_id', partner.id)
      .maybeSingle();
    if (error) throw error;
    return data ? data.partner_nickname : '';
  }

  async function setNickname(nickname) {
    const { error } = await supabase.from('chat_preferences').upsert({
      owner_id: me.user.id,
      partner_id: partner.id,
      partner_nickname: nickname.trim() || null,
      auto_delete: partnerAutoDelete,
    }, { onConflict: 'owner_id,partner_id' });
    if (error) throw error;
    return nickname.trim();
  }

  return {
    init, lookupProfileByUsername, fetchRecentChats, subscribeHome, openConversationWith, closeConversation,
    fetchHistory, clearConversation, sendText, sendMedia, sendToProfile, downloadAndDecryptMedia, setRetention,
    uploadChatBackground, getChatBackground, uploadAvatar, updateOwnProfile, setNickname, getNickname,
    getAutoDelete, setAutoDelete, setStarred, fetchStarredMessages, deleteMessage,
    setReaction, fetchReactions, startTypingChannel, sendTyping,
    getConversationKeyForProfile,
    getConversationKey: () => conversationKey
  };
})();