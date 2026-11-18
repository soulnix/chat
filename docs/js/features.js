// features.js — UI building blocks for the newer chat features.
// Pure DOM helpers, CSP-safe: no inline handlers, no external assets.
// Sounds are synthesized with WebAudio (no files to load or cache).

const SoulUI = (() => {

  // ---- sounds: tiny WebAudio blips ----
  let audioCtx = null;
  let soundOn = true;
  function initSound() {
    try { soundOn = localStorage.getItem('soulnix-sound') !== '0'; } catch (_) { soundOn = true; }
  }
  function soundEnabled() { return soundOn; }
  function setSoundEnabled(on) {
    soundOn = !!on;
    try { localStorage.setItem('soulnix-sound', on ? '1' : '0'); } catch (_) { /* ignore */ }
  }
  function blip(freq, duration, delay = 0, type = 'sine', gain = 0.05) {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const vol = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      vol.gain.setValueAtTime(gain, audioCtx.currentTime + delay);
      vol.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + duration);
      osc.connect(vol).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + duration);
    } catch (_) { /* audio is best-effort */ }
  }
  function playSent() { blip(880, 0.09); }
  function playReceived() { blip(660, 0.09); blip(523, 0.12, 0.1); }

  // ---- gradient avatars (Telegram-style) ----
  function avatarGradient(username) {
    let hash = 0;
    const name = username || '?';
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    const h1 = hash % 360;
    const h2 = (h1 + 46) % 360;
    return `linear-gradient(135deg, hsl(${h1}, 62%, 58%), hsl(${h2}, 62%, 44%))`;
  }
  // fetchBlob(path) -> Promise<Blob>, provided by the app (storage download).
  function applyAvatar(el, profile, fetchBlob) {
    el.style.background = '';
    el.textContent = (profile.username || '?').slice(0, 2).toUpperCase();
    if (!profile.avatar_url) {
      el.style.background = avatarGradient(profile.username);
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    fetchBlob(profile.avatar_url).then((blob) => {
      if (!blob || !el.isConnected) return;
      el.textContent = '';
      el.appendChild(img);
      img.src = URL.createObjectURL(blob);
    }).catch(() => {
      el.style.background = avatarGradient(profile.username);
    });
  }

  // ---- bottom sheet (message actions, reactions, pickers, lists) ----
  function sheetOpen() { return document.getElementById('sheet-overlay').classList.contains('active'); }
  function closeSheet() { document.getElementById('sheet-overlay').classList.remove('active'); }
  function openSheet({ title = '', node = null, items = null }) {
    const overlay = document.getElementById('sheet-overlay');
    const card = document.getElementById('sheet-card');
    card.innerHTML = '';
    if (title) {
      const heading = document.createElement('div');
      heading.className = 'sheet-title';
      heading.textContent = title;
      card.appendChild(heading);
    }
    if (node) card.appendChild(node);
    if (items) {
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sheet-item ${item.danger ? 'danger' : ''}`;
        button.textContent = (item.icon ? item.icon + '  ' : '') + item.label;
        button.onclick = () => { closeSheet(); if (item.onclick) item.onclick(); };
        card.appendChild(button);
      }
    }
    overlay.classList.add('active');
  }
  function initSheet() {
    document.getElementById('sheet-overlay').addEventListener('click', (event) => {
      if (event.target.id === 'sheet-overlay') closeSheet();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && sheetOpen()) closeSheet();
    });
  }

  // ---- emoji picker ----
  const EMOJIS = [
    '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','😉','😍','🥰','😘','😗',
    '😋','😜','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😞','😔','😟','😕','🙁','😣',
    '😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨',
    '😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧',
    '😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑',
    '🤠','😈','👿','🤡','💩','👻','💀','👽','🤖','🎃','😺','🙈','🙉','🙊','💌',' ❤️',
    '🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖','💘','💝',
    '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👋','🙌','👏','🙏','💪','🫡','🤝','✍️',
    '🔥','✨','⭐','🌟','💫','💥','💯','🎉','🎊','🎈','🎁','🏆','⚽','🏏','🎵','🎶',
  ];
  function buildEmojiPanel(onPick) {
    const panel = document.createElement('div');
    panel.className = 'emoji-panel';
    for (const emoji of EMOJIS) {
      if (!emoji.trim()) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'emoji-cell';
      button.textContent = emoji.trim();
      button.onclick = () => onPick(emoji.trim());
      panel.appendChild(button);
    }
    return panel;
  }

  // ---- long-press + double-tap gestures ----
  function onLongPress(el, handler) {
    let timer = null;
    let startY = 0;
    el.addEventListener('touchstart', (event) => {
      startY = event.touches[0].clientY;
      timer = setTimeout(() => { timer = null; handler(event); }, 500);
    }, { passive: true });
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('touchend', cancel, { passive: true });
    el.addEventListener('touchcancel', cancel, { passive: true });
    el.addEventListener('touchmove', (event) => {
      if (timer && Math.abs(event.touches[0].clientY - startY) > 10) cancel();
    }, { passive: true });
    // Desktop: right-click opens the same menu.
    el.addEventListener('contextmenu', (event) => { event.preventDefault(); handler(event); });
  }
  function onDoubleTap(el, handler) {
    let lastTap = 0;
    el.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastTap < 300) { lastTap = 0; handler(); } else { lastTap = now; }
    });
  }

  // ---- voice notes (MediaRecorder) ----
  let recorder = null;
  let recordChunks = [];
  let recordMime = '';
  let recordTimer = null;
  let recordStart = 0;
  let recordStream = null;
  async function startRecording(onTick, onError) {
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      recordMime = '';
      for (const mime of ['audio/webm', 'audio/mp4', '']) {
        if (!mime || (window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) { recordMime = mime; break; }
      }
      recorder = recordMime ? new MediaRecorder(recordStream, { mimeType: recordMime }) : new MediaRecorder(recordStream);
      recorder.ondataavailable = (event) => { if (event.data.size) recordChunks.push(event.data); };
      recorder.start(250);
      recordStart = Date.now();
      recordTimer = setInterval(() => { if (onTick) onTick(Math.floor((Date.now() - recordStart) / 1000)); }, 500);
      return true;
    } catch (err) {
      stopTracks();
      if (onError) onError(err);
      return false;
    }
  }
  function stopTracks() {
    if (recordStream) { for (const track of recordStream.getTracks()) track.stop(); recordStream = null; }
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
  }
  function stopRecording() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') { stopTracks(); resolve(null); return; }
      const seconds = Math.max(1, Math.floor((Date.now() - recordStart) / 1000));
      recorder.onstop = () => {
        const blob = new Blob(recordChunks, { type: recordMime || 'audio/webm' });
        recorder = null;
        stopTracks();
        resolve({ blob, seconds });
      };
      recorder.stop();
    });
  }
  function cancelRecording() {
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      try { recorder.stop(); } catch (_) { /* already stopped */ }
    }
    recorder = null;
    stopTracks();
  }
  function fmtClock(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---- camera (photo capture) ----
  let cameraStream = null;
  async function openCamera(videoEl, facing = 'environment') {
    closeCamera(videoEl);
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing },
      audio: false,
    });
    videoEl.srcObject = cameraStream;
    await videoEl.play().catch(() => {});
    return cameraStream;
  }
  function closeCamera(videoEl) {
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) track.stop();
      cameraStream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }
  function captureFrame(videoEl) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        if (!canvas.width) { reject(new Error('Camera is not ready yet.')); return; }
        canvas.getContext('2d').drawImage(videoEl, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error('Could not capture the photo.'));
        }, 'image/jpeg', 0.9);
      } catch (err) { reject(err); }
    });
  }

  // ---- full-screen media viewer (chat photos/videos) ----
  let viewerUrl = null;
  function openMediaViewer(kind, src) {
    const overlay = document.getElementById('media-viewer');
    const stage = document.getElementById('media-viewer-stage');
    stage.innerHTML = '';
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
    viewerUrl = src;
    const tag = document.createElement(kind === 'video' ? 'video' : 'img');
    if (kind === 'video') { tag.controls = true; tag.autoplay = true; tag.playsInline = true; }
    tag.src = src;
    stage.appendChild(tag);
    overlay.classList.add('active');
  }
  function closeMediaViewer() {
    const overlay = document.getElementById('media-viewer');
    const stage = document.getElementById('media-viewer-stage');
    overlay.classList.remove('active');
    stage.innerHTML = '';
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  }
  function initMediaViewer() {
    document.getElementById('media-viewer-close').onclick = closeMediaViewer;
    document.getElementById('media-viewer').addEventListener('click', (event) => {
      if (event.target.id === 'media-viewer') closeMediaViewer();
    });
  }

  // ---- linkify text (safe: only http(s) URLs become anchors) ----
  const URL_RE = /(https?:\/\/[^\s]+)/g;
  function linkifyText(container, text) {
    let lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
      const start = match.index;
      if (start > lastIndex) container.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      const link = document.createElement('a');
      link.className = 'msg-link';
      link.href = match[0];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = match[0].length > 48 ? match[0].slice(0, 45) + '…' : match[0];
      container.appendChild(link);
      lastIndex = start + match[0].length;
    }
    if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  function init() {
    initSound();
    initSheet();
    initMediaViewer();
  }

  return {
    init, playSent, playReceived, soundEnabled, setSoundEnabled,
    avatarGradient, applyAvatar,
    openSheet, closeSheet, sheetOpen, buildEmojiPanel,
    onLongPress, onDoubleTap,
    startRecording, stopRecording, cancelRecording, fmtClock,
    openCamera, closeCamera, captureFrame,
    openMediaViewer, closeMediaViewer, linkifyText,
    EMOJIS,
  };
})();
