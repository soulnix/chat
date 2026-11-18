// crypto.js — all end-to-end encryption logic lives here.
// Nothing in this file ever sends a plaintext key or passphrase
// to the server. Everything that touches the server is already
// ciphertext, a public key, or a salt (all safe to be public).

const SoulCrypto = (() => {

  // ---- helpers: bytes <-> base64 ----
  // NOTE: base64 conversion must be chunked. The previous version used
  // String.fromCharCode(...bytes) — spreading a 15 MB image / 50 MB video
  // exceeds the engine's maximum call-stack size and throws
  // "Maximum call stack size exceeded", which broke large media encryption.
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000; // 32768 bytes per call, safely below arg limits
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  function randomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  // ---- identity keypair (ECDH P-256) ----
  async function generateIdentityKeyPair() {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
  }

  async function exportPublicKey(publicKey) {
    return crypto.subtle.exportKey('jwk', publicKey);
  }
  async function importPublicKey(jwk) {
    return crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
  }
  async function exportPrivateKey(privateKey) {
    return crypto.subtle.exportKey('jwk', privateKey);
  }
  async function importPrivateKey(jwk) {
    return crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
    );
  }

  // ---- passphrase -> AES key (PBKDF2), used only to wrap the private key ----
  async function deriveKeyFromPassphrase(passphrase, saltB64) {
    const salt = saltB64 ? b64ToBuf(saltB64) : randomBytes(16);
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { aesKey, saltB64: saltB64 || bufToB64(salt) };
  }

  // ---- wrap / unwrap the identity private key with the passphrase key ----
  async function wrapPrivateKey(privateKeyJwk, passphraseAesKey) {
    const iv = randomBytes(12);
    const plaintext = new TextEncoder().encode(JSON.stringify(privateKeyJwk));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, passphraseAesKey, plaintext
    );
    return { ciphertextB64: bufToB64(ciphertext), ivB64: bufToB64(iv) };
  }

  async function unwrapPrivateKey(ciphertextB64, ivB64, passphraseAesKey) {
    const iv = new Uint8Array(b64ToBuf(ivB64));
    const ciphertext = b64ToBuf(ciphertextB64);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, passphraseAesKey, ciphertext
    ); // throws if passphrase is wrong — that's how login verification works
    const jwk = JSON.parse(new TextDecoder().decode(plaintext));
    return importPrivateKey(jwk);
  }

  // ---- per-conversation shared key (ECDH -> HKDF -> AES-256-GCM) ----
  // Same result on both sides because ECDH shared secrets are symmetric:
  // deriveBits(myPrivate, theirPublic) === deriveBits(theirPrivate, myPublic)
  async function deriveConversationKey(myPrivateKey, theirPublicKey) {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirPublicKey }, myPrivateKey, 256
    );
    const hkdfBase = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF', hash: 'SHA-256',
        salt: new TextEncoder().encode('soulnix-chat-v1'),
        info: new TextEncoder().encode('message-key')
      },
      hkdfBase,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ---- encrypt / decrypt text ----
  async function encryptText(conversationKey, plaintext) {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, conversationKey, new TextEncoder().encode(plaintext)
    );
    return { ciphertextB64: bufToB64(ciphertext), ivB64: bufToB64(iv) };
  }

  async function decryptText(conversationKey, ciphertextB64, ivB64) {
    const iv = new Uint8Array(b64ToBuf(ivB64));
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, conversationKey, b64ToBuf(ciphertextB64)
    );
    return new TextDecoder().decode(plaintext);
  }

  // ---- encrypt / decrypt files (images/videos), as raw bytes ----
  async function encryptFile(conversationKey, arrayBuffer) {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, conversationKey, arrayBuffer
    );
    return { ciphertext, ivB64: bufToB64(iv) }; // ciphertext stays as raw bytes for upload
  }

  async function decryptFile(conversationKey, ciphertextArrayBuffer, ivB64) {
    const iv = new Uint8Array(b64ToBuf(ivB64));
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, conversationKey, ciphertextArrayBuffer
    );
  }

  // ---- short fingerprint of a public key, so two people can verify
  //      they're really talking to each other if they want to ----
  async function fingerprint(publicKeyJwk) {
    const data = new TextEncoder().encode(JSON.stringify(publicKeyJwk));
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 16).match(/.{1,4}/g).join(' ').toUpperCase();
  }

  return {
    bufToB64, b64ToBuf, randomBytes,
    generateIdentityKeyPair, exportPublicKey, importPublicKey,
    exportPrivateKey, importPrivateKey,
    deriveKeyFromPassphrase, wrapPrivateKey, unwrapPrivateKey,
    deriveConversationKey,
    encryptText, decryptText, encryptFile, decryptFile,
    fingerprint
  };
})();
