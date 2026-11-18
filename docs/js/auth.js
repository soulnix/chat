// auth.js — username + passphrase signup/login.
//
// There is no email or phone number anywhere. Under the hood,
// Supabase Auth still wants an email-shaped identifier, so we
// generate a synthetic one that is never shown and never used
// for anything but logging in. We use gmail.com because Supabase's
// email validator accepts it and (with "Confirm email" turned OFF
// in the Supabase dashboard) no email is ever actually sent.
//
// The REAL identity for encryption purposes is the ECDH keypair,
// whose private half is encrypted with a key derived from the
// passphrase (PBKDF2) before it's ever stored. The server only
// ever sees that encrypted blob.

const SoulAuth = (() => {
  let supabase = null;
  let session = null;      // { user, identityPrivateKey, identityPublicKeyJwk, profile }

  function init(client) {
    supabase = client;
  }

  function syntheticEmail(username) {
    return `${username.toLowerCase()}@gmail.com`;
  }

  async function usernameTaken(username) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return !!data;
  }

  async function signUp(username, passphrase) {
    username = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new Error('Username must be 3-20 characters: letters, numbers, underscore only.');
    }
    if (passphrase.length < 8) {
      throw new Error('Passphrase must be at least 8 characters. A short one can be guessed by brute force, because the encrypted key blob it protects is publicly readable.');
    }
    if (await usernameTaken(username)) {
      throw new Error('That username is already taken.');
    }

    // 1. Create the auth account (passphrase doubles as the Supabase password).
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: syntheticEmail(username),
      password: passphrase,
    });
    if (signUpError) throw signUpError;
    const userId = signUpData.user.id;

    // 2. Generate this user's real E2E identity keypair.
    const keyPair = await SoulCrypto.generateIdentityKeyPair();
    const publicKeyJwk = await SoulCrypto.exportPublicKey(keyPair.publicKey);
    const privateKeyJwk = await SoulCrypto.exportPrivateKey(keyPair.privateKey);

    // 3. Wrap the private key with a key derived from the passphrase.
    const { aesKey, saltB64 } = await SoulCrypto.deriveKeyFromPassphrase(passphrase, null);
    const { ciphertextB64, ivB64 } = await SoulCrypto.wrapPrivateKey(privateKeyJwk, aesKey);

    // 4. Store the profile row — only public key + encrypted blob leave the browser.
    const { error: profileError } = await supabase.from('profiles').insert({
      id: userId,
      username,
      public_key: publicKeyJwk,
      encrypted_private_key: ciphertextB64,
      private_key_iv: ivB64,
      kdf_salt: saltB64,
      retain_messages: false,
    });
    if (profileError) {
      // The auth account exists now but has no profile row, so logging in
      // would fail with a confusing error. Say what actually happened.
      throw new Error(`Account created, but the profile could not be saved (${profileError.message}). Try logging in — if that also fails, the username's auth entry may need manual cleanup in Supabase.`);
    }

    session = {
      user: signUpData.user,
      identityPrivateKey: keyPair.privateKey,
      identityPublicKeyJwk: publicKeyJwk,
      profile: { id: userId, username, retain_messages: false },
    };
    return session;
  }

  async function logIn(username, passphrase) {
    username = username.trim().toLowerCase();

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: syntheticEmail(username),
      password: passphrase,
    });
    if (authError) throw new Error('Wrong username or passphrase.');

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authData.user.id)
      .single();
    if (profileError) throw profileError;

    // Re-derive the passphrase key with the STORED salt, then unwrap the
    // private key. If the passphrase was wrong this throws (AES-GCM auth
    // tag mismatch) even though Supabase Auth already accepted the password
    // — this is an extra integrity check on the encryption side.
    const { aesKey } = await SoulCrypto.deriveKeyFromPassphrase(passphrase, profile.kdf_salt);
    const identityPrivateKey = await SoulCrypto.unwrapPrivateKey(
      profile.encrypted_private_key, profile.private_key_iv, aesKey
    );

    session = {
      user: authData.user,
      identityPrivateKey,
      identityPublicKeyJwk: profile.public_key,
      profile,
    };
    return session;
  }

  async function logOut() {
    await supabase.auth.signOut();
    session = null;
  }

  function current() {
    return session;
  }

  return { init, signUp, logIn, logOut, current, usernameTaken };
})();