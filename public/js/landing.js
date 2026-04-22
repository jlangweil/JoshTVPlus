/* landing.js — JoshTV+ landing page */
(function () {
  'use strict';

  // ─── DOM refs ─────────────────────────────────────────────────────────────────
  const inputDriveUrl  = document.getElementById('input-drive-url');
  const inputHostName  = document.getElementById('input-host-name');
  const btnCreate      = document.getElementById('btn-create');
  const statusCreate   = document.getElementById('status-create');

  const inputRoomCode  = document.getElementById('input-room-code');
  const btnJoin        = document.getElementById('btn-join');
  const statusJoin     = document.getElementById('status-join');

  // ─── Google Drive URL parsing ─────────────────────────────────────────────────
  // Handles all common Drive share link formats:
  //   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  //   https://drive.google.com/file/d/FILE_ID/view
  //   https://drive.google.com/open?id=FILE_ID
  //   https://drive.google.com/uc?id=FILE_ID&export=download
  function extractFileId(url) {
    if (!url) return null;
    url = url.trim();

    const fileD = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    if (fileD) return fileD[1];

    const idParam = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (idParam) return idParam[1];

    return null;
  }

  function videoUrlFromId(fileId) {
    // drive.usercontent.google.com reliably returns Content-Length and skips
    // the HTML virus-scan confirmation page that drive.google.com/uc triggers.
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
  }

  // ─── Create room ──────────────────────────────────────────────────────────────
  btnCreate.addEventListener('click', handleCreate);
  inputDriveUrl.addEventListener('keydown',  (e) => { if (e.key === 'Enter') handleCreate(); });
  inputHostName.addEventListener('keydown',  (e) => { if (e.key === 'Enter') handleCreate(); });

  async function handleCreate() {
    const rawUrl  = inputDriveUrl.value.trim();
    const name    = inputHostName.value.trim();

    if (!rawUrl) {
      showStatus(statusCreate, 'Paste your Google Drive share link above.', 'error');
      inputDriveUrl.focus();
      return;
    }
    const fileId = extractFileId(rawUrl);
    if (!fileId) {
      showStatus(statusCreate, 'That doesn\'t look like a Google Drive link. Copy the share link from Drive and try again.', 'error');
      inputDriveUrl.focus();
      return;
    }
    if (!name) {
      showStatus(statusCreate, 'Enter your display name.', 'error');
      inputHostName.focus();
      return;
    }

    setLoading(true);
    showStatus(statusCreate, 'Creating room…', 'info');

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId,
          videoUrl: videoUrlFromId(fileId),
          hostName: name
        })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const { roomId } = await res.json();
      if (!roomId) throw new Error('No room ID returned.');

      // Persist host identity so the room page knows this socket is the host
      sessionStorage.setItem('sw_host', JSON.stringify({ roomId, hostName: name }));

      showStatus(statusCreate, 'Room created! Joining…', 'success');
      setTimeout(() => { window.location.href = `/room/${roomId}`; }, 350);

    } catch (err) {
      showStatus(statusCreate, `Failed: ${err.message}`, 'error');
      setLoading(false);
    }
  }

  // ─── Join room ────────────────────────────────────────────────────────────────
  btnJoin.addEventListener('click', handleJoin);
  inputRoomCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleJoin(); });

  async function handleJoin() {
    // Accept either a bare code or a full room URL
    const raw = inputRoomCode.value.trim();
    if (!raw) {
      showStatus(statusJoin, 'Enter a room code.', 'error');
      return;
    }

    // Pull code out of a pasted full URL (e.g. https://…/room/X7KQ2M)
    const fromUrl = raw.match(/\/room\/([A-Za-z0-9]{4,8})\/?$/);
    const code = (fromUrl ? fromUrl[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (code.length < 4) {
      showStatus(statusJoin, 'Room code too short — check and try again.', 'error');
      return;
    }

    showStatus(statusJoin, 'Checking room…', 'info');
    try {
      const res = await fetch(`/api/rooms/${code}`);
      if (!res.ok) {
        showStatus(statusJoin, 'Room not found. Check the code and try again.', 'error');
        return;
      }
      showStatus(statusJoin, 'Found! Joining…', 'success');
      setTimeout(() => { window.location.href = `/room/${code}`; }, 300);
    } catch (_) {
      showStatus(statusJoin, 'Cannot reach the server. Try again.', 'error');
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function showStatus(el, msg, type) {
    el.textContent = msg;
    el.className = `status-msg ${type}`;
  }

  function setLoading(on) {
    btnCreate.disabled = on;
    btnCreate.innerHTML = on
      ? `<span class="spinner"></span> Creating…`
      : `<svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
           <path d="M3.75 3A1.75 1.75 0 002 4.75v10.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25V4.75A1.75 1.75 0 0016.25 3H3.75zM10 7.5a.75.75 0 01.75.75v1.75h1.75a.75.75 0 010 1.5h-1.75v1.75a.75.75 0 01-1.5 0v-1.75H7.5a.75.75 0 010-1.5h1.75V8.25A.75.75 0 0110 7.5z"/>
         </svg> Create a Room`;
  }
})();
