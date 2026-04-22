require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Start playing once this fraction of the file is buffered server-side.
// 0.15 = 15% — for a 2 GB file that's ~300 MB, enough for ~18 min of 1080p.
const PLAY_THRESHOLD = parseFloat(process.env.PLAY_THRESHOLD || '0.15');

// When Google Drive omits Content-Length, start playback after this many bytes.
const FALLBACK_READY_BYTES = parseInt(process.env.FALLBACK_READY_BYTES || String(20 * 1024 * 1024), 10);

// ─── In-Memory Room Store ─────────────────────────────────────────────────────
const rooms = new Map();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));


// ─── Google Drive fetch — redirect chain + cookie + confirm-token handling ────
//
// Drive's download flow for large publicly-shared files:
//   drive.google.com/uc?export=download&id=ID&confirm=t
//     → (302) → accounts.google.com  (sometimes)
//     → (302) → doc-XX.googleusercontent.com  (final byte server)
//
// For very large files Drive injects an HTML "too large to scan" page that
// contains a fresh confirm= token.  We extract it and retry.
//
function fetchDriveStream(url, abortSignal, cookies = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 15) return reject(new Error('Too many redirects from Google Drive'));

    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    const req = mod.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      timeout: 30000,   // 30 s to receive the first response byte
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,video/mp4,video/*;q=0.8,*/*;q=0.7',
        ...(cookieStr ? { Cookie: cookieStr } : {})
      }
    }, (res) => {
      // Accumulate cookies across hops
      (res.headers['set-cookie'] || []).forEach(sc => {
        const m = sc.match(/^([^=]+)=([^;]*)/);
        if (m) cookies[m[1].trim()] = m[2].trim();
      });

      // Follow HTTP redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.host}${res.headers.location}`;
        return fetchDriveStream(next, abortSignal, cookies, hops + 1).then(resolve, reject);
      }

      const ct = res.headers['content-type'] || '';

      // Drive returns HTML for the "too large to virus-scan" confirmation page
      if (ct.includes('text/html') && res.statusCode === 200) {
        let html = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { html += chunk; });
        res.on('end', () => {
          if (html.toLowerCase().includes('quota') || html.toLowerCase().includes('download quota exceeded')) {
            return reject(new Error('Google Drive download quota exceeded for this file. Try again later.'));
          }

          // 1) Full download URL embedded in a link (most reliable)
          const hrefMatch = html.match(/href="([^"]*(?:\/uc|\/download)\?[^"]*export=download[^"]*)"/i);
          if (hrefMatch) {
            let next = hrefMatch[1].replace(/&amp;/g, '&');
            if (next.startsWith('//')) next = 'https:' + next;
            else if (!next.startsWith('http')) next = 'https://drive.google.com' + next;
            return fetchDriveStream(next, abortSignal, cookies, hops + 1).then(resolve, reject);
          }

          // 2) uuid= token (modern Drive confirmation page)
          const uuidMatch = html.match(/[?&"']uuid=([a-zA-Z0-9_-]+)/);
          if (uuidMatch) {
            const base = url.replace(/[?&]uuid=[^&]*/g, '').replace(/[?&]confirm=[^&]*/g, '');
            const sep = base.includes('?') ? '&' : '?';
            return fetchDriveStream(`${base}${sep}confirm=t&uuid=${uuidMatch[1]}`, abortSignal, cookies, hops + 1).then(resolve, reject);
          }

          // 3) Legacy long confirm token (not just 't' or '1')
          const m = html.match(/confirm=([a-zA-Z0-9_-]{4,})/);
          if (m) {
            const sep = url.includes('?') ? '&' : '?';
            return fetchDriveStream(`${url}${sep}confirm=${m[1]}`, abortSignal, cookies, hops + 1).then(resolve, reject);
          }

          reject(new Error(
            'Google Drive returned a webpage instead of the video file. ' +
            'Make sure the file is shared as "Anyone with the link can view" and try again.'
          ));
        });
        res.on('error', reject);
        return;
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`Google Drive returned HTTP ${res.statusCode}`));
      }

      resolve({
        stream: res,
        contentLength: parseInt(res.headers['content-length'] || '0', 10)
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Google Drive request timed out. The file may be unavailable or too large to access. Try again.'));
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        req.destroy();
        reject(Object.assign(new Error('Download aborted'), { name: 'AbortError' }));
      }, { once: true });
    }

    req.on('error', reject);
  });
}

// ─── Progressive stream helper ────────────────────────────────────────────────
// Reads bytes [start, end] from the cached file, waiting for bytes not yet
// written by the background download.  Unlocks automatically as the download
// progresses, or ends early if the room is destroyed.
function createFollowStream(room, start, end) {
  const output = new PassThrough({ highWaterMark: 256 * 1024 });
  let offset = start;

  function pump() {
    if (output.destroyed) return;
    if (!rooms.has(room.id)) { output.end(); return; }

    // How far into the file has the download reached?
    const ceiling = room.downloadComplete
      ? end + 1
      : Math.min(room.downloadedBytes, end + 1);
    const available = ceiling - offset;

    if (available <= 0) {
      if (room.downloadComplete) { output.end(); return; }
      // Wait until more bytes land or the room is torn down
      const onProgress = () => { room.downloadEmitter.off('abort', onAbort); pump(); };
      const onAbort   = () => { room.downloadEmitter.off('progress', onProgress); output.end(); };
      room.downloadEmitter.once('progress', onProgress);
      room.downloadEmitter.once('abort',    onAbort);
      return;
    }

    const rs = fs.createReadStream(room.localPath, { start: offset, end: offset + available - 1 });
    let bytesRead = 0;

    rs.on('data',  chunk => { bytesRead += chunk.length; output.write(chunk); });
    rs.on('error', err   => output.destroy(err));
    rs.on('end', () => {
      offset += bytesRead;
      if (offset > end) output.end();
      else pump();           // immediately check for more available bytes
    });
  }

  pump();
  return output;
}

// ─── Background download — Drive → server disk ───────────────────────────────
async function prepareVideo(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const abortCtrl = new AbortController();
  room.downloadController = abortCtrl;
  room.downloadedBytes    = 0;
  room.downloadComplete   = false;
  room.localPath          = null;
  room.videoSize          = 0;
  room.videoStatus        = 'downloading';

  const tmpPath = path.join(os.tmpdir(), `joshtv-${roomId}.mp4`);

  io.to(roomId).emit('video-status', { status: 'downloading', progress: 0 });

  try {
    const { stream, contentLength } = await fetchDriveStream(room.videoUrl, abortCtrl.signal);
    room.videoSize = contentLength;

    // How many bytes before we tell clients to start playing.
    // When Drive omits Content-Length, use a fixed 20 MB fallback instead of
    // waiting forever (Infinity would mean the ready signal never fires).
    const startAt = contentLength > 0
      ? Math.ceil(contentLength * PLAY_THRESHOLD)
      : FALLBACK_READY_BYTES;

    // Open the temp file NOW so the proxy can read from it as bytes arrive
    const fileStream = fs.createWriteStream(tmpPath);
    room.localPath = tmpPath;

    let lastEmittedPct = -1;
    let emittedReady   = false;

    await new Promise((resolve, reject) => {
      stream.on('data', chunk => {
        room.downloadedBytes += chunk.length;
        room.downloadEmitter.emit('progress', room.downloadedBytes);

        if (contentLength > 0) {
          const pct = Math.floor((room.downloadedBytes / contentLength) * 100);
          if (pct >= lastEmittedPct + 5) {
            lastEmittedPct = pct;
            // Keep showing progress bar until ready fires
            if (!emittedReady) {
              io.to(roomId).emit('video-status', { status: 'downloading', progress: pct });
            }
          }
        } else {
          // No Content-Length: emit a signal every 2 MB so the client knows
          // the download is alive and shows how much has arrived.
          const tick = Math.floor(room.downloadedBytes / (2 * 1024 * 1024));
          if (tick > lastEmittedPct) {
            lastEmittedPct = tick;
            if (!emittedReady) {
              io.to(roomId).emit('video-status', {
                status: 'downloading',
                progress: null,
                downloadedMB: Math.round(room.downloadedBytes / 1e6)
              });
            }
          }
        }

        // Fire "ready" once the threshold is reached
        if (!emittedReady && room.downloadedBytes >= startAt) {
          emittedReady     = true;
          room.videoStatus = 'ready';
          io.to(roomId).emit('video-status', { status: 'ready' });
          const totalLabel = contentLength > 0 ? `${(contentLength / 1e6).toFixed(0)} MB` : 'unknown size';
          console.log(`Room ${roomId}: threshold reached — starting playback (${(room.downloadedBytes / 1e6).toFixed(0)} MB / ${totalLabel})`);
        }
      });

      stream.on('error',         reject);
      fileStream.on('error',     reject);
      stream.pipe(fileStream);
      fileStream.on('finish',    resolve);
    });

    room.downloadComplete = true;
    // If Drive didn't send Content-Length, we now know the real size
    if (room.videoSize === 0) room.videoSize = room.downloadedBytes;
    room.downloadEmitter.emit('progress', room.downloadedBytes); // wake any waiting readers

    // If the file was tiny and threshold was never reached, fire ready now
    if (!emittedReady) {
      room.videoStatus = 'ready';
      io.to(roomId).emit('video-status', { status: 'ready' });
    }

    console.log(`Room ${roomId}: fully cached — ${(room.downloadedBytes / 1e6).toFixed(1)} MB`);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`Room ${roomId}: download cancelled`);
    } else {
      console.error(`Room ${roomId}: download failed —`, err.message);
      if (rooms.has(roomId)) {
        rooms.get(roomId).videoStatus = 'error';
        io.to(roomId).emit('video-status', { status: 'error', message: err.message });
      }
    }
    room.downloadEmitter.emit('abort');
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ─── Proxy endpoint — serve cached file with Range support ───────────────────
app.get('/proxy/:roomId/video', (req, res) => {
  const roomId = req.params.roomId.toUpperCase();
  const room   = rooms.get(roomId);

  if (!room)                          return res.status(404).end();
  if (!room.localPath)               return res.status(503).json({ error: 'Video not ready yet' });
  if (room.videoStatus !== 'ready')  return res.status(503).json({ error: 'Still buffering' });

  // Use the known total size; fall back to bytes-downloaded if Drive omitted Content-Length
  const fileSize = room.videoSize || room.downloadedBytes;
  if (!fileSize)                     return res.status(503).json({ error: 'Video not ready yet' });
  const range    = req.headers.range;

  res.setHeader('Content-Type',   'video/mp4');
  res.setHeader('Accept-Ranges',  'bytes');

  let start, end;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    start = parseInt(s, 10);
    end   = e ? Math.min(parseInt(e, 10), fileSize - 1) : fileSize - 1;

    if (isNaN(start) || start >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    res.setHeader('Content-Range',  `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', end - start + 1);
    res.status(206);
  } else {
    start = 0;
    end   = fileSize - 1;
    res.setHeader('Content-Length', fileSize);
    res.status(200);
  }

  const stream = createFollowStream(room, start, end);
  req.on('close', () => stream.destroy());   // client disconnected — stop reading
  stream.pipe(res);
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  const { fileId, videoUrl, hostName } = req.body;
  if (!fileId || !videoUrl || !hostName)
    return res.status(400).json({ error: 'fileId, videoUrl, and hostName are required' });
  if (!videoUrl.includes('drive.google.com') && !videoUrl.includes('googleapis.com') && !videoUrl.includes('drive.usercontent.google.com'))
    return res.status(400).json({ error: 'videoUrl must be a Google Drive URL' });

  const roomId = generateRoomId();
  const room = {
    id: roomId,
    hostSocketId:    null,
    hostName:        sanitize(hostName).substring(0, 30),
    videoFileId:     fileId,
    videoUrl,
    videoStatus:     'downloading',
    localPath:       null,
    videoSize:       0,
    downloadedBytes: 0,
    downloadComplete: false,
    downloadController: null,
    downloadEmitter: new EventEmitter(),
    playbackState:   { playing: false, currentTime: 0, lastUpdated: Date.now() },
    participants:    new Map(),
    chatMessages:    [],
    createdAt:       Date.now(),
    gracePeriodTimer: null,
    idleTimer:       null
  };
  room.downloadEmitter.setMaxListeners(100); // many concurrent proxy connections

  rooms.set(roomId, room);
  resetIdleTimer(roomId);
  prepareVideo(roomId); // fire-and-forget background download

  console.log(`Room ${roomId} created by "${hostName}"`);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, hostName: room.hostName });
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
const chatLimits = new Map();

io.on('connection', (socket) => {

  // ── Host joins room page ──
  socket.on('host-join', ({ roomId, hostName }) => {
    const id   = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    if (room.gracePeriodTimer) { clearTimeout(room.gracePeriodTimer); room.gracePeriodTimer = null; }

    room.hostSocketId = socket.id;
    socket.roomId     = id;
    socket.isHost     = true;
    socket.displayName = room.hostName;

    room.participants.set(socket.id, {
      name: room.hostName, joinedAt: Date.now(), isBuffering: false, isHost: true
    });
    socket.join(id);

    socket.emit('room-state', {
      playbackState: room.playbackState,
      participants:  serializeParticipants(room),
      chatMessages:  room.chatMessages,
      hostName:      room.hostName,
      isHost:        true,
      videoStatus:   room.videoStatus
    });
    if (room.videoStatus === 'ready') {
      socket.emit('video-status', { status: 'ready' });
    } else if (room.videoStatus === 'downloading') {
      const pct = room.videoSize > 0 ? Math.floor((room.downloadedBytes / room.videoSize) * 100) : 0;
      socket.emit('video-status', { status: 'downloading', progress: pct });
    }
    io.to(id).emit('participant-update', { participants: serializeParticipants(room) });
  });

  // ── Guest joins ──
  socket.on('join-room', ({ roomId, name }) => {
    const id   = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) { socket.emit('error', { message: 'Room not found or has ended' }); return; }

    const displayName = sanitize((name || 'Guest').substring(0, 30));
    room.participants.set(socket.id, {
      name: displayName, joinedAt: Date.now(), isBuffering: false, isHost: false
    });
    socket.roomId      = id;
    socket.isHost      = false;
    socket.displayName = displayName;
    socket.join(id);

    const ps           = room.playbackState;
    const adjustedTime = ps.playing
      ? ps.currentTime + (Date.now() - ps.lastUpdated) / 1000
      : ps.currentTime;

    socket.emit('room-state', {
      playbackState: { ...ps, currentTime: adjustedTime },
      participants:  serializeParticipants(room),
      chatMessages:  room.chatMessages,
      hostName:      room.hostName,
      isHost:        false,
      videoStatus:   room.videoStatus
    });

    // Bring new joiner up to speed on download state
    if (room.videoStatus === 'ready') {
      socket.emit('video-status', { status: 'ready' });
    } else if (room.videoStatus === 'downloading') {
      const pct = room.videoSize > 0 ? Math.floor((room.downloadedBytes / room.videoSize) * 100) : 0;
      socket.emit('video-status', { status: 'downloading', progress: pct });
    }

    const sysMsg = systemMessage(`${displayName} joined the room.`);
    pushChat(room, sysMsg);
    io.to(id).emit('chat-message', sysMsg);
    io.to(id).emit('participant-update', { participants: serializeParticipants(room) });
  });

  // ── Playback: play ──
  socket.on('play', ({ currentTime }) => {
    const room = hostRoom(socket);
    if (!room || room.videoStatus !== 'ready') return;
    room.playbackState = { playing: true, currentTime, lastUpdated: Date.now() };
    resetIdleTimer(socket.roomId);
    const sysMsg = systemMessage('Host resumed playback.');
    pushChat(room, sysMsg);
    socket.broadcast.to(socket.roomId).emit('play', { currentTime });
    io.to(socket.roomId).emit('chat-message', sysMsg);
  });

  // ── Playback: pause ──
  socket.on('pause', ({ currentTime }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState = { playing: false, currentTime, lastUpdated: Date.now() };
    const sysMsg = systemMessage('Host paused the video.');
    pushChat(room, sysMsg);
    socket.broadcast.to(socket.roomId).emit('pause', { currentTime });
    io.to(socket.roomId).emit('chat-message', sysMsg);
  });

  // ── Playback: seek ──
  socket.on('seek', ({ currentTime }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState.currentTime  = currentTime;
    room.playbackState.lastUpdated  = Date.now();
    socket.broadcast.to(socket.roomId).emit('seek', { currentTime });
  });

  // ── Host heartbeat ──
  socket.on('host-heartbeat', ({ currentTime, playing }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState = { playing, currentTime, lastUpdated: Date.now() };
    socket.to(socket.roomId).emit('sync', { currentTime, playing });
  });

  // ── Buffering ──
  socket.on('buffering', ({ isBuffering }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) p.isBuffering = Boolean(isBuffering);
    io.to(socket.roomId).emit('participant-update', { participants: serializeParticipants(room) });
  });

  // ── Chat ──
  socket.on('chat-message', ({ text }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const now = Date.now();
    let rl = chatLimits.get(socket.id) || { count: 0, resetAt: now + 10000 };
    if (now > rl.resetAt) rl = { count: 0, resetAt: now + 10000 };
    rl.count++;
    chatLimits.set(socket.id, rl);
    if (rl.count > 5) { socket.emit('error', { message: 'Sending too fast — slow down.' }); return; }
    const clean = sanitize(String(text || '')).substring(0, 500);
    if (!clean.trim()) return;
    const msg = { sender: socket.displayName || 'Unknown', text: clean, timestamp: Date.now(), type: 'user' };
    pushChat(room, msg);
    io.to(socket.roomId).emit('chat-message', msg);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.participants.delete(socket.id);
    chatLimits.delete(socket.id);

    if (socket.id === room.hostSocketId) {
      const sysMsg = systemMessage('Host disconnected. Waiting up to 5 minutes for reconnect…');
      pushChat(room, sysMsg);
      io.to(socket.roomId).emit('chat-message', sysMsg);
      io.to(socket.roomId).emit('host-disconnected', {});
      io.to(socket.roomId).emit('participant-update', { participants: serializeParticipants(room) });
      room.gracePeriodTimer = setTimeout(() => {
        if (rooms.has(socket.roomId))
          io.to(socket.roomId).emit('chat-message', systemMessage('Host did not reconnect. Session ended.'));
        destroyRoom(socket.roomId);
      }, 5 * 60 * 1000);
    } else if (socket.displayName) {
      const sysMsg = systemMessage(`${socket.displayName} left the room.`);
      pushChat(room, sysMsg);
      io.to(socket.roomId).emit('chat-message', sysMsg);
      io.to(socket.roomId).emit('participant-update', { participants: serializeParticipants(room) });
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(id));
  return id;
}

function serializeParticipants(room) {
  const list = [];
  room.participants.forEach((p, socketId) =>
    list.push({ socketId, name: p.name, isHost: p.isHost, isBuffering: p.isBuffering }));
  return list;
}

function systemMessage(text)  { return { sender: 'System', text, timestamp: Date.now(), type: 'system' }; }
function pushChat(room, msg)  { room.chatMessages.push(msg); if (room.chatMessages.length > 200) room.chatMessages.shift(); }
function sanitize(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hostRoom(socket) {
  const room = rooms.get(socket.roomId);
  return (room && socket.id === room.hostSocketId) ? room : null;
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // Stop the background download
  if (room.downloadController) room.downloadController.abort();
  // Wake any proxy requests that are waiting on more bytes
  if (room.downloadEmitter)    room.downloadEmitter.emit('abort');
  // Delete the cached temp file from server disk
  if (room.localPath) {
    fs.unlink(room.localPath, err => {
      if (err && err.code !== 'ENOENT')
        console.warn(`Could not delete ${room.localPath}:`, err.message);
    });
  }
  if (room.gracePeriodTimer) clearTimeout(room.gracePeriodTimer);
  if (room.idleTimer)        clearTimeout(room.idleTimer);
  io.to(roomId).emit('room-ended', {});
  io.in(roomId).socketsLeave(roomId);
  rooms.delete(roomId);
  console.log(`Room ${roomId} destroyed.`);
}

function resetIdleTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.idleTimer) clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => {
    if (rooms.has(roomId)) io.to(roomId).emit('chat-message', systemMessage('Room closed due to 2 hours of inactivity.'));
    destroyRoom(roomId);
  }, 2 * 60 * 60 * 1000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`\n  JoshTV+ running at http://localhost:${PORT}\n`));
