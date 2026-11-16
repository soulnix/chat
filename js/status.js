// status.js — 24-hour disappearing status/story updates, WhatsApp-style.
// A status is posted once from the Status tab and delivered to every
// recent chat partner: each partner gets their own row, encrypted with
// the conversation key shared with them (ECDH) — there is no shared
// "group" key, so media is encrypted and uploaded once per partner.
// A row the owner can see is metadata only; decryption always happens
// on the viewer's row, which the same symmetric conversation key opens.

const SoulStatus = (() => {
  let supabase, me;

  function init(client, session) {
    supabase = client;
    me = session;
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

  // Post one status (text or media + optional caption) to every partner.
  async function postToPartners(partners, { text = '', bg = null, file = null, kind = 'text' }) {
    if (!partners.length) throw new Error('Start a chat before sharing a status.');
    for (const profile of partners) {
      const key = await SoulChat.getConversationKeyForProfile(profile);
      let storagePath = null;
      let caption;
      if (file) {
        const arrayBuffer = await file.arrayBuffer();
        const { ciphertext, ivB64 } = await SoulCrypto.encryptFile(key, arrayBuffer);
        storagePath = `${me.user.id}/status-${crypto.randomUUID()}.bin`;
        const up = await supabase.storage.from('encrypted-media').upload(storagePath, new Blob([ciphertext]));
        if (up.error) throw up.error;
        // Empty caption still gets a throwaway IV so the row shape matches.
        caption = text
          ? await SoulCrypto.encryptText(key, text)
          : { ciphertextB64: '', ivB64: SoulCrypto.bufToB64(SoulCrypto.randomBytes(12)) };
      } else {
        caption = await SoulCrypto.encryptText(key, text);
      }
      const { error } = await supabase.from('statuses').insert({
        owner_id: me.user.id,
        viewer_id: profile.id,
        kind,
        ciphertext: caption.ciphertextB64,
        iv: caption.ivB64,
        storage_path: storagePath,
        bg: storagePath ? null : bg,
      });
      if (error) {
        // Row insert failed — don't leave the uploaded file orphaned either.
        if (storagePath) await supabase.storage.from('encrypted-media').remove([storagePath]).catch(() => {});
        throw error;
      }
    }
    return partners.length;
  }

  function mapRow(row) {
    return {
      id: row.id, kind: row.kind, createdAt: row.created_at,
      expiresAt: row.expires_at, viewedAt: row.viewed_at, bg: row.bg || null,
    };
  }

  // Statuses received FROM a partner (their updates, for me to view).
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
      const item = mapRow(row);
      if (row.kind === 'text') {
        item.text = await SoulCrypto.decryptText(key, row.ciphertext, row.iv);
      } else {
        item.storagePath = row.storage_path;
        item.fileIv = row.iv;
        if (row.ciphertext) {
          try { item.caption = await SoulCrypto.decryptText(key, row.ciphertext, row.iv); }
          catch (_) { item.caption = ''; }
        } else {
          item.caption = '';
        }
      }
      out.push(item);
    }
    return out;
  }

  // My own posted statuses for one partner — metadata only. The Status
  // screen shows a count; tapping "My status" opens the composer, not
  // a viewer, so decryption isn't needed here.
  async function fetchOwnStatusesFor(profile) {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('statuses')
      .select('id, kind, created_at, expires_at, viewed_at, bg')
      .eq('owner_id', me.user.id)
      .eq('viewer_id', profile.id)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapRow);
  }

  async function markViewed(statusId) {
    const { error } = await supabase.from('statuses')
      .update({ viewed_at: new Date().toISOString() })
      .eq('id', statusId)
      .eq('viewer_id', me.user.id);
    if (error) throw error;
  }

  // The conversation key is passed in — media is decryptable only with
  // the key of the conversation this status row was posted to.
  async function downloadAndDecryptMedia(key, storagePath, fileIvB64) {
    const { data, error } = await supabase.storage.from('encrypted-media').download(storagePath);
    if (error) throw error;
    const ciphertextBuf = await data.arrayBuffer();
    return SoulCrypto.decryptFile(key, ciphertextBuf, fileIvB64);
  }

  return { init, postToPartners, fetchStatusesFor, fetchOwnStatusesFor, markViewed, downloadAndDecryptMedia, cleanupExpired };
})();
