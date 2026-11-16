const SoulChat = (() => {
  let supabase, me, partner = null, conversationKey = null, channel = null, homeChannel = null, partnerAutoDelete = true;
  let sweepTimer = null;
  const peerPublicKeyCache = new Map();

  function init(client, session) {
    supabase = client;
    me = session;
  }

  async function lookupProfileByUsername(username) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, public_key, retain_messages, avatar_url')
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

    const { data: messages, error: messagesError } = await supabase.from('messages')
      .select('sender_id, receiver_id, created_at')
      .eq('owner_id', me.user.id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (messagesError) throw messagesError;
    for (const message of messages || []) {
      const partnerId = message.sender_id === me.user.id ? message.receiver_id : message.sender_id;
      const prior = latestByPartner.get(partnerId);
      if (!prior || new Date(message.created_at) > new Date(prior)) latestByPartner.set(partnerId, message.created_at);
    }

    const partnerIds = [...latestByPartner.keys()];
    if (!partnerIds.length) return [];
    const { data: profiles, error: profilesError } = await supabase.from('profiles')
      .select('id, username, public_key, retain_messages, avatar_url, last_seen_at')
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
    partnerAutoDelete = await getAutoDelete();
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

  async function decryptRow(row) {
    const base = {
      id: row.id, groupId: row.group_id, mine: row.sender_id === me.user.id,
      kind: row.kind, createdAt: row.created_at, deliveredAt: row.delivered_at, readAt: row.read_at,
    };
    if (row.kind === 'text') {
      base.text = await SoulCrypto.decryptText(conversationKey, row.ciphertext, row.iv);
    } else {
      base.caption = row.ciphertext ? await SoulCrypto.decryptText(conversationKey, row.ciphertext, row.iv) : '';
      base.storagePath = row.storage_path;
      base.fileIv = row.file_iv;
    }
    return base;
  }

  // Decrypt one row, falling back to a placeholder instead of throwing.
  // Keeps the chat open when a single media file has already been removed
  // from storage (e.g. the sender's copy expired and was cleaned up).
  async function decryptRowSafe(row) {
    try {
      return await decryptRow(await ensureOwnMediaFile(row));
    } catch (_) {
      const base = {
        id: row.id, groupId: row.group_id, mine: row.sender_id === me.user.id,
        kind: row.kind, createdAt: row.created_at, deliveredAt: row.delivered_at, readAt: row.read_at,
        mediaUnavailable: true,
      };
      if (row.kind !== 'text' && row.ciphertext) {
        try { base.caption = await SoulCrypto.decryptText(conversationKey, row.ciphertext, row.iv); } catch (_) { /* leave caption empty */ }
      }
      return base;
    }
  }

  async function sendText(text) {
    const groupId = crypto.randomUUID();
    const enc = await SoulCrypto.encryptText(conversationKey, text);
    const createdAt = await insertBothCopies({ groupId, kind: 'text', captionCiphertextB64: enc.ciphertextB64, captionIvB64: enc.ivB64, myStoragePath: null, fileIvB64: null });
    return { groupId, createdAt };
  }

  async function sendMedia(file, kind, caption = '') {
    const groupId = crypto.randomUUID();
    const arrayBuffer = await file.arrayBuffer();
    const { ciphertext, ivB64: fileIvB64 } = await SoulCrypto.encryptFile(conversationKey, arrayBuffer);

    const myPath = `${me.user.id}/${groupId}.bin`;
    const blob = new Blob([ciphertext]);

    const up = await supabase.storage.from('encrypted-media').upload(myPath, blob, { upsert: false });
    if (up.error) throw up.error;

    const capEnc = caption ? await SoulCrypto.encryptText(conversationKey, caption) : { ciphertextB64: '', ivB64: SoulCrypto.bufToB64(SoulCrypto.randomBytes(12)) };
    const createdAt = await insertBothCopies({ groupId, kind, captionCiphertextB64: capEnc.ciphertextB64, captionIvB64: capEnc.ivB64, myStoragePath: myPath, fileIvB64 });
    return { groupId, createdAt };
  }

  async function insertBothCopies({ groupId, kind, captionCiphertextB64, captionIvB64, myStoragePath, fileIvB64 }) {
    const { data: authData, error: authError } = await supabase.auth.getSession();
    if (authError) throw authError;
    const authenticatedUserId = authData.session?.user.id;
    if (authenticatedUserId !== me.user.id) {
      throw new Error('This tab is signed in as a different user. Refresh and sign in again before sending.');
    }
    if (partner.id === authenticatedUserId) {
      throw new Error('You cannot send a message to your own account. Check the selected chat.');
    }
    const deleteAt = partnerAutoDelete ? new Date(Date.now() + AUTO_DELETE_MINUTES * 60 * 1000).toISOString() : null;
    const { data: rpcCreatedAt, error } = await supabase.rpc('send_chat_message_copies', {
      p_group_id: groupId,
      p_receiver_id: partner.id,
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
    const deleteAt = partnerAutoDelete ? new Date(Date.now() + AUTO_DELETE_MINUTES * 60 * 1000).toISOString() : null;
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
      .select('auto_delete')
      .eq('owner_id', me.user.id)
      .eq('partner_id', partner.id)
      .maybeSingle();
    if (error) throw error;
    return data ? data.auto_delete : !me.profile.retain_messages;
  }

  async function setAutoDelete(enabled) {
    const { error } = await supabase.from('chat_preferences').upsert({
      owner_id: me.user.id,
      partner_id: partner.id,
      auto_delete: enabled,
    }, { onConflict: 'owner_id,partner_id' });
    if (error) throw error;
    partnerAutoDelete = enabled;
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
    fetchHistory, clearConversation, sendText, sendMedia, downloadAndDecryptMedia, setRetention, 
    uploadChatBackground, getChatBackground, uploadAvatar, setNickname, getNickname,
    getAutoDelete, setAutoDelete,
    getConversationKeyForProfile,
    getConversationKey: () => conversationKey
  };
})();
