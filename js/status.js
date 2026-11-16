// status.js — 24-hour disappearing status/story updates, shared
// with the one other person you're paired with.

const SoulStatus = (() => {
  let supabase, me, partner, conversationKey;

  function init(client, session) {
    supabase = client;
    me = session;
  }

  function setPartner(profile, key) {
    partner = profile;
    conversationKey = key;
  }

  async function cleanupExpired() {
    const nowIso = new Date().toISOString();
    const { data: expired, error } = await supabase
      .from('statuses')
      .select('id, storage_path')
      .eq('owner_id', me.user.id)
      .lt('expires_at', nowIso);
    if (error) throw error;
    if (!expired || !expired.length) return;
    for (const row of expired) {
      if (row.storage_path) {
        const { error: storageError } = await supabase.storage.from('encrypted-media').remove([row.storage_path]);
        if (storageError) throw storageError;
      }
    }
    const { error: deleteError } = await supabase.from('statuses').delete().in('id', expired.map(row => row.id));
    if (deleteError) throw deleteError;
  }

  async function postText(text) {
    const enc = await SoulCrypto.encryptText(conversationKey, text);
    const { error } = await supabase.from('statuses').insert({
      owner_id: me.user.id, viewer_id: partner.id,
      kind: 'text', ciphertext: enc.ciphertextB64, iv: enc.ivB64,
    });
    if (error) throw error;
  }

  async function postMedia(file, kind) {
    const arrayBuffer = await file.arrayBuffer();
    const { ciphertext, ivB64 } = await SoulCrypto.encryptFile(conversationKey, arrayBuffer);
    const path = `${me.user.id}/status-${crypto.randomUUID()}.bin`;
    const up = await supabase.storage.from('encrypted-media').upload(path, new Blob([ciphertext]));
    if (up.error) throw up.error;
    const { error } = await supabase.from('statuses').insert({
      owner_id: me.user.id, viewer_id: partner.id,
      kind, ciphertext: '', iv: ivB64, storage_path: path,
    });
    if (error) {
      const { error: cleanupError } = await supabase.storage.from('encrypted-media').remove([path]);
      if (cleanupError) throw new Error(`${error.message}; uploaded status cleanup failed: ${cleanupError.message}`);
      throw error;
    }
  }

  async function fetchStatusesFor(profile, key) {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('statuses')
      .select('*')
      .eq('owner_id', profile.id)
      .eq('viewer_id', me.user.id)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const out = [];
    for (const row of data) {
      const item = { id: row.id, kind: row.kind, createdAt: row.created_at, expiresAt: row.expires_at, viewedAt: row.viewed_at };
      if (row.kind === 'text') {
        item.text = await SoulCrypto.decryptText(key, row.ciphertext, row.iv);
      } else {
        item.storagePath = row.storage_path;
        item.fileIv = row.iv;
      }
      out.push(item);
    }
    return out;
  }

  async function fetchPartnerStatuses() {
    if (!partner || !conversationKey) throw new Error('Choose a chat before loading statuses.');
    await cleanupExpired();
    return fetchStatusesFor(partner, conversationKey);
  }

  async function markViewed(statusId) {
    const { error } = await supabase.from('statuses')
      .update({ viewed_at: new Date().toISOString() })
      .eq('id', statusId)
      .eq('viewer_id', me.user.id);
    if (error) throw error;
  }

  async function downloadAndDecryptMedia(storagePath, fileIvB64) {
    const { data, error } = await supabase.storage.from('encrypted-media').download(storagePath);
    if (error) throw error;
    const ciphertextBuf = await data.arrayBuffer();
    return SoulCrypto.decryptFile(conversationKey, ciphertextBuf, fileIvB64);
  }

  return { init, setPartner, postText, postMedia, fetchPartnerStatuses, fetchStatusesFor, markViewed, downloadAndDecryptMedia, cleanupExpired };
})();
