/* room.js — JoshTV+ room page */
(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  const roomId = location.pathname.split('/').pop().toUpperCase();
  let isHost = false;
  let myName = '';
  let socket = null;
  let heartbeatInterval = null;
  let rateAdjustTimer = null;
  let participants = [];

  // Host data from sessionStorage (set by landing page after creation)
  const hostData = (() => {
    try {
      const raw = sessionStorage.getItem('sw_host');
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d.roomId === roomId ? d : null;
    } catch (_) { return null; }
  })();

  // ─── DOM refs ─────────────────────────────────────────────────────────────────
  const joinScreen = document.getElementById('join-screen');
  const roomPage = document.getElementById('room-page');
  const joinRoomCode = document.getElementById('join-room-code');
  const joinNameInput = document.getElementById('join-name-input');
  const joinSubmit = document.getElementById('join-submit');
  const joinStatus = document.getElementById('join-status');

  const topbarRoomId = document.getElementById('topbar-room-id');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnParticipants = document.getElementById('btn-participants');
  const participantCountEl = document.getElementById('participant-count');

  const video = document.getElementById('video');
  const videoOverlay = document.getElementById('video-overlay');
  const bufferingOverlay = document.getElementById('buffering-overlay');
  const videoError = document.getElementById('video-error');
  const videoErrorMsg = document.getElementById('video-error-msg');
  const guestBadge = document.getElementById('guest-badge');

  const seekBar = document.getElementById('seek-bar');
  const timeDisplay = document.getElementById('time-display');
  const hostControls = document.getElementById('host-controls');
  const guestControls = document.getElementById('guest-controls');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const muteBtn = document.getElementById('mute-btn');
  const iconVol = document.getElementById('icon-vol');
  const iconMute = document.getElementById('icon-mute');
  const volumeSlider = document.getElementById('volume-slider');
  const fullscreenBtn = document.getElementById('fullscreen-btn');

  const guestMuteBtn = document.getElementById('guest-mute-btn');
  const guestVolumeSlider = document.getElementById('guest-volume-slider');
  const guestFullscreenBtn = document.getElementById('guest-fullscreen-btn');

  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');

  const participantsPanel = document.getElementById('participants-panel');
  const closeParticipants = document.getElementById('close-participants');
  const participantsList = document.getElementById('participants-list');
  const participantsCountPanel = document.getElementById('participants-count-panel');

  const roomEndedOverlay = document.getElementById('room-ended-overlay');
  const roomEndedMsg = document.getElementById('room-ended-msg');
  const toastContainer = document.getElementById('toast-container');

  const fetchOverlay = document.getElementById('fetch-overlay');
  const fetchLabel = document.getElementById('fetch-label');
  const fetchBarFill = document.getElementById('fetch-bar-fill');
  const fetchPct = document.getElementById('fetch-pct');
  const bufferPctEl = document.getElementById('buffer-pct');

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    joinRoomCode.textContent = roomId;
    topbarRoomId.textContent = roomId;

    if (hostData) {
      // This user is the host
      isHost = true;
      myName = hostData.hostName || 'Host';
      enterRoom();
    } else {
      // Show join form
      joinScreen.classList.remove('hidden');
      joinNameInput.focus();
    }

    bindJoinEvents();
    bindCopyLink();
    bindParticipantPanel();
  }

  // ─── Join form ────────────────────────────────────────────────────────────────
  function bindJoinEvents() {
    joinSubmit.addEventListener('click', submitJoin);
    joinNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitJoin();
    });
  }

  async function submitJoin() {
    const name = joinNameInput.value.trim();
    if (!name) {
      showJoinStatus('Please enter your display name.', 'error');
      return;
    }
    // Quick room existence check
    try {
      const res = await fetch(`/api/rooms/${roomId}`);
      if (!res.ok) {
        showJoinStatus('This room does not exist or has ended.', 'error');
        return;
      }
    } catch (_) {
      showJoinStatus('Cannot connect to server.', 'error');
      return;
    }
    myName = name;
    isHost = false;
    enterRoom();
  }

  function showJoinStatus(msg, type) {
    joinStatus.textContent = msg;
    joinStatus.className = `status-msg ${type}`;
  }

  // ─── Enter Room ───────────────────────────────────────────────────────────────
  function enterRoom() {
    joinScreen.classList.add('hidden');
    roomPage.classList.remove('hidden');
    setupControls();
    connectSocket();
  }

  function setupControls() {
    if (isHost) {
      hostControls.classList.remove('hidden');
      guestControls.classList.add('hidden');
      guestBadge.classList.add('hidden');
      seekBar.classList.remove('guest-seek');
      bindHostControls();
    } else {
      hostControls.classList.add('hidden');
      guestControls.classList.remove('hidden');
      guestBadge.classList.remove('hidden');
      seekBar.classList.add('guest-seek');
      seekBar.disabled = true;
      bindGuestControls();
    }
    videoOverlay.classList.add('always-show');
    bindVideoEvents();
  }

  // ─── Socket.io Connection ─────────────────────────────────────────────────────
  function connectSocket() {
    socket = io();

    socket.on('connect', () => {
      if (isHost) {
        socket.emit('host-join', { roomId, hostName: myName });
      } else {
        socket.emit('join-room', { roomId, name: myName });
      }
    });

    socket.on('room-state', onRoomState);
    socket.on('video-status', onVideoStatus);
    socket.on('play', onRemotePlay);
    socket.on('pause', onRemotePause);
    socket.on('seek', onRemoteSeek);
    socket.on('sync', onSync);
    socket.on('chat-message', onChatMessage);
    socket.on('participant-update', onParticipantUpdate);
    socket.on('host-disconnected', onHostDisconnected);
    socket.on('host-reconnected', onHostReconnected);
    socket.on('room-ended', onRoomEnded);
    socket.on('error', (data) => toast(data.message || 'An error occurred.', 'error'));

    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') {
        toast('Connection lost. Reconnecting…', 'error');
      }
    });
    socket.on('reconnect', () => {
      toast('Reconnected.', 'success');
      if (isHost) {
        socket.emit('host-join', { roomId, hostName: myName });
      } else {
        socket.emit('join-room', { roomId, name: myName });
      }
    });
  }

  // ─── Socket Event Handlers ────────────────────────────────────────────────────
  // Store playback state from room-state so we can apply it once video is ready
  let pendingPlaybackState = null;

  function onRoomState(data) {
    pendingPlaybackState = data.playbackState;

    // Hydrate chat history
    chatMessages.innerHTML = '';
    (data.chatMessages || []).forEach(renderChatMessage);
    scrollChat();

    onParticipantUpdate({ participants: data.participants });

    // If the server already finished fetching, video-status:ready will follow
    // immediately (or was already sent). If still downloading, the overlay stays up.
    if (data.videoStatus === 'ready') {
      // video-status event will arrive right after; nothing to do here
    } else if (isHost) {
      // Host sees the progress bar; disable play until ready
      if (playPauseBtn) playPauseBtn.disabled = true;
    }
  }

  function onVideoStatus(data) {
    const { status, progress, message } = data;
    if (status === 'downloading') {
      fetchOverlay.classList.remove('hidden');
      if (isHost && playPauseBtn) playPauseBtn.disabled = true;

      if (progress != null) {
        // Known file size — show percentage
        fetchBarFill.style.width = progress + '%';
        fetchPct.textContent = progress + '%';
      } else if (data.downloadedMB != null) {
        // Drive omitted Content-Length — show MB and animate bar up to ~90%
        const vizPct = Math.min(90, data.downloadedMB * 3);
        fetchBarFill.style.width = vizPct + '%';
        fetchPct.textContent = `${data.downloadedMB} MB downloaded…`;
      }
      return;
    }

    if (status === 'error') {
      fetchOverlay.classList.add('hidden');
      videoError.classList.remove('hidden');
      videoErrorMsg.textContent = message || 'Failed to fetch video from Google Drive.';
      return;
    }

    if (status === 'ready') {
      fetchOverlay.classList.add('hidden');
      videoError.classList.add('hidden');

      // Load video from the server proxy — same origin, proper Range support
      video.src = `/proxy/${roomId}/video`;
      video.load();

      video.addEventListener('loadedmetadata', () => {
        const state = pendingPlaybackState || { playing: false, currentTime: 0 };
        video.currentTime = state.currentTime || 0;
        updateSeekBar();
        if (!isHost && state.playing) {
          video.play().catch(() => {});
        }
        if (isHost) {
          if (playPauseBtn) playPauseBtn.disabled = false;
          startHeartbeat();
        }
      }, { once: true });
    }
  }

  function onRemotePlay({ currentTime }) {
    video.currentTime = currentTime;
    video.play().catch(() => {});
    updatePlayPauseIcon(true);
  }

  function onRemotePause({ currentTime }) {
    video.currentTime = currentTime;
    video.pause();
    updatePlayPauseIcon(false);
  }

  function onRemoteSeek({ currentTime }) {
    video.currentTime = currentTime;
    updateSeekBar();
  }

  function onSync({ currentTime, playing }) {
    if (isHost) return; // Host doesn't apply sync from server

    const drift = Math.abs(video.currentTime - currentTime);

    if (drift > 1.5) {
      // Hard resync
      video.currentTime = currentTime;
    } else if (drift > 0.3) {
      // Smooth rate convergence
      if (rateAdjustTimer) clearTimeout(rateAdjustTimer);
      video.playbackRate = video.currentTime < currentTime ? 1.05 : 0.95;
      rateAdjustTimer = setTimeout(() => { video.playbackRate = 1.0; }, 2000);
    }

    // Align play/pause state
    if (playing && video.paused && !video.ended) {
      video.play().catch(() => {});
    } else if (!playing && !video.paused) {
      video.pause();
    }
  }

  function onChatMessage(msg) {
    renderChatMessage(msg);
    scrollChat();
  }

  function onParticipantUpdate({ participants: list }) {
    participants = list || [];
    const count = participants.length;
    participantCountEl.textContent = count;
    participantsCountPanel.textContent = count;
    renderParticipantList();
  }

  function onHostDisconnected() {
    toast('Host disconnected. Waiting for reconnect…', 'error');
    video.pause();
  }

  function onHostReconnected() {
    toast('Host reconnected.', 'success');
  }

  function onRoomEnded() {
    roomEndedMsg.textContent = 'The host has ended the session.';
    roomEndedOverlay.classList.remove('hidden');
    if (socket) socket.disconnect();
    stopHeartbeat();
  }

  // ─── Host Video Controls ──────────────────────────────────────────────────────
  function bindHostControls() {
    playPauseBtn.addEventListener('click', togglePlayPause);
    muteBtn.addEventListener('click', toggleMute);
    volumeSlider.addEventListener('input', onVolumeChange);
    fullscreenBtn.addEventListener('click', toggleFullscreen);

    seekBar.addEventListener('input', onSeekInput);
    seekBar.addEventListener('change', onSeekChange);
  }

  function togglePlayPause() {
    if (video.paused || video.ended) {
      video.play().then(() => {
        socket.emit('play', { currentTime: video.currentTime });
      }).catch(() => {});
    } else {
      video.pause();
      socket.emit('pause', { currentTime: video.currentTime });
    }
  }

  let isSeeking = false;
  function onSeekInput() {
    isSeeking = true;
    const pct = seekBar.value / 1000;
    const t = pct * (video.duration || 0);
    video.currentTime = t;
    updateTimeDisplay();
  }
  function onSeekChange() {
    isSeeking = false;
    socket.emit('seek', { currentTime: video.currentTime });
  }

  function toggleMute() {
    video.muted = !video.muted;
    iconVol.classList.toggle('hidden', video.muted);
    iconMute.classList.toggle('hidden', !video.muted);
  }

  function onVolumeChange() {
    video.volume = volumeSlider.value / 100;
    video.muted = video.volume === 0;
    iconVol.classList.toggle('hidden', video.muted);
    iconMute.classList.toggle('hidden', !video.muted);
  }

  // ─── Guest Volume/Fullscreen ──────────────────────────────────────────────────
  function bindGuestControls() {
    guestMuteBtn.addEventListener('click', () => {
      video.muted = !video.muted;
    });
    guestVolumeSlider.addEventListener('input', () => {
      video.volume = guestVolumeSlider.value / 100;
      video.muted = video.volume === 0;
    });
    guestFullscreenBtn.addEventListener('click', toggleFullscreen);
  }

  function toggleFullscreen() {
    const el = document.getElementById('video-container');
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen).call(document);
    }
  }

  // ─── Video Events ─────────────────────────────────────────────────────────────
  function bindVideoEvents() {
    video.addEventListener('timeupdate', () => {
      if (!isSeeking) updateSeekBar();
      updateBufferBar();
    });

    video.addEventListener('progress', updateBufferBar);

    video.addEventListener('play', () => updatePlayPauseIcon(true));
    video.addEventListener('pause', () => updatePlayPauseIcon(false));
    video.addEventListener('ended', () => updatePlayPauseIcon(false));

    video.addEventListener('waiting', () => {
      bufferingOverlay.classList.remove('hidden');
      if (socket) socket.emit('buffering', { isBuffering: true });
    });
    video.addEventListener('canplay', () => {
      bufferingOverlay.classList.add('hidden');
      if (socket) socket.emit('buffering', { isBuffering: false });
    });
    video.addEventListener('playing', () => {
      bufferingOverlay.classList.add('hidden');
      if (socket) socket.emit('buffering', { isBuffering: false });
    });

    video.addEventListener('error', () => {
      const err = video.error;
      let msg = 'Unable to load video.';
      if (err) {
        switch (err.code) {
          case 1: msg = 'Video loading was aborted.'; break;
          case 2: msg = 'Network error while loading video. Google Drive may be throttling this file.'; break;
          case 3: msg = 'Video decoding error. The file may be corrupted.'; break;
          case 4: msg = 'Video format not supported or file is not accessible. Ensure sharing is set to "Anyone with link".'; break;
        }
      }
      videoErrorMsg.textContent = msg;
      videoError.classList.remove('hidden');
    });

    video.addEventListener('loadedmetadata', () => {
      videoError.classList.add('hidden');
      updateSeekBar();
      updateBufferBar();
    });
  }

  // ─── Seek bar & time display ──────────────────────────────────────────────────
  function updateSeekBar() {
    const duration = video.duration || 0;
    const current = video.currentTime || 0;
    const pct = duration > 0 ? (current / duration) * 1000 : 0;
    seekBar.value = pct;
    seekBar.style.setProperty('--progress', (pct / 10) + '%');
    updateTimeDisplay();
  }

  function updateBufferBar() {
    const duration = video.duration;
    if (!duration) return;

    // Find the furthest buffered end across all ranges
    let bufferedEnd = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.end(i) > bufferedEnd) {
        bufferedEnd = video.buffered.end(i);
      }
    }

    const bufferedPct = Math.min(100, (bufferedEnd / duration) * 100);
    // Never let the buffered zone fall behind the playhead visually
    const playedPct = (video.currentTime / duration) * 100;
    const displayPct = Math.max(playedPct, bufferedPct);

    seekBar.style.setProperty('--buffered', displayPct.toFixed(1) + '%');

    if (bufferPctEl) {
      bufferPctEl.textContent = bufferedPct >= 99.5 ? '' : Math.round(bufferedPct) + '% buffered';
    }
  }

  function updateTimeDisplay() {
    const duration = video.duration || 0;
    const current = video.currentTime || 0;
    timeDisplay.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }

  function updatePlayPauseIcon(playing) {
    iconPlay.classList.toggle('hidden', playing);
    iconPause.classList.toggle('hidden', !playing);
  }

  // ─── Host heartbeat ───────────────────────────────────────────────────────────
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (!socket || !socket.connected) return;
      if (!video.paused && !video.ended) {
        socket.emit('host-heartbeat', {
          currentTime: video.currentTime,
          playing: !video.paused
        });
      }
    }, 3000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────────
  function renderChatMessage(msg) {
    const div = document.createElement('div');
    div.className = `chat-msg${msg.type === 'system' ? ' system' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'chat-msg-meta';

    if (msg.type !== 'system') {
      const sender = document.createElement('span');
      sender.className = 'chat-sender';
      sender.textContent = msg.sender || 'Unknown';
      sender.style.color = nameToColor(msg.sender || '');
      meta.appendChild(sender);
    }

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = fmtTimestamp(msg.timestamp);
    meta.appendChild(time);

    const text = document.createElement('div');
    text.className = 'chat-text';
    // msg.text is already server-sanitized; safe to set as textContent
    text.textContent = msg.text || '';

    div.appendChild(meta);
    div.appendChild(text);
    chatMessages.appendChild(div);
  }

  function scrollChat() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit('chat-message', { text: text.substring(0, 500) });
    chatInput.value = '';
    chatInput.style.height = '';
  }

  chatSend.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  function nameToColor(name) {
    // Deterministic color from name
    const colors = [
      '#a78bfa', '#34d399', '#60a5fa', '#f87171',
      '#fbbf24', '#f472b6', '#38bdf8', '#a3e635'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash << 5) - hash + name.charCodeAt(i);
    return colors[Math.abs(hash) % colors.length];
  }

  function fmtTimestamp(ts) {
    const d = new Date(ts);
    const h = d.getHours(), m = d.getMinutes();
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  // ─── Participant list ─────────────────────────────────────────────────────────
  function renderParticipantList() {
    participantsList.innerHTML = '';
    participants.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'participant-item';

      const avatar = document.createElement('div');
      avatar.className = 'participant-avatar';
      avatar.style.background = nameToColor(p.name);
      avatar.textContent = (p.name || '?')[0].toUpperCase();

      const name = document.createElement('span');
      name.className = 'participant-name';
      name.textContent = p.name;

      const badges = document.createElement('div');
      badges.className = 'participant-badges';

      if (p.isHost) {
        const hostBadge = document.createElement('span');
        hostBadge.className = 'badge-host';
        hostBadge.textContent = 'HOST';
        badges.appendChild(hostBadge);
      }
      if (p.isBuffering) {
        const buf = document.createElement('div');
        buf.className = 'badge-buffering';
        buf.title = 'Buffering…';
        badges.appendChild(buf);
      }

      item.appendChild(avatar);
      item.appendChild(name);
      item.appendChild(badges);
      participantsList.appendChild(item);
    });
  }

  // ─── Copy Link ────────────────────────────────────────────────────────────────
  function bindCopyLink() {
    btnCopyLink.addEventListener('click', async () => {
      const link = `${location.origin}/room/${roomId}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied!', 'success');
      } catch (_) {
        prompt('Copy this link:', link);
      }
    });
  }

  // ─── Participant panel ────────────────────────────────────────────────────────
  function bindParticipantPanel() {
    btnParticipants.addEventListener('click', () => {
      participantsPanel.classList.toggle('open');
    });
    closeParticipants.addEventListener('click', () => {
      participantsPanel.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
      if (participantsPanel.classList.contains('open')
          && !participantsPanel.contains(e.target)
          && e.target !== btnParticipants) {
        participantsPanel.classList.remove('open');
      }
    });
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = `toast${type ? ' ' + type : ''}`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ─── Cleanup on page hide ─────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    stopHeartbeat();
    // Don't disconnect — let the server's grace period handle it
  });

  // ─── Start ────────────────────────────────────────────────────────────────────
  init();
})();
