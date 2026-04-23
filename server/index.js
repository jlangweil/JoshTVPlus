require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ─── In-Memory Room Store ─────────────────────────────────────────────────────
const rooms = new Map();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Drive URL resolution ─────────────────────────────────────────────────────
// Follows Drive's redirect chain (including HTML confirmation pages) using a
// tiny Range: bytes=0-0 probe so we read nothing and just discover the final
// CDN URL.  Result is cached per room for ~45 min (CDN tokens last ~1 hr).
function resolveVideoUrl(url, cookies = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 15) return reject(new Error('Too many redirects from Google Drive'));

    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    const req = mod.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
        ...(cookieStr ? { Cookie: cookieStr } : {})
      }
    }, (res) => {
      (res.headers['set-cookie'] || []).forEach(sc => {
        const m = sc.match(/^([^=]+)=([^;]*)/);
        if (m) cookies[m[1].trim()] = m[2].trim();
      });

      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.host}${res.headers.location}`;
        return resolveVideoUrl(next, cookies, hops + 1).then(resolve, reject);
      }

      // Drive HTML confirmation page
      const ct = res.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        let html = '';
        res.setEncoding('utf8');
        res.on('data', c => { html += c; });
        res.on('end', () => {
          if (html.toLowerCase().includes('quota')) {
            return reject(new Error('Google Drive download quota exceeded. Try again later.'));
          }
          // Full href with export=download
          const hrefMatch = html.match(/href="([^"]*(?:\/uc|\/download)\?[^"]*export=download[^"]*)"/i);
          if (hrefMatch) {
            let next = hrefMatch[1].replace(/&amp;/g, '&');
            if (!next.startsWith('http')) next = 'https://drive.google.com' + next;
            return resolveVideoUrl(next, cookies, hops + 1).then(resolve, reject);
          }
          // Modern uuid token
          const uuidMatch = html.match(/uuid=([a-zA-Z0-9_-]+)/);
          if (uuidMatch) {
            const base = url.replace(/[?&]uuid=[^&]*/g, '').replace(/[?&]confirm=[^&]*/g, '');
            const sep = base.includes('?') ? '&' : '?';
            return resolveVideoUrl(`${base}${sep}confirm=t&uuid=${uuidMatch[1]}`, cookies, hops + 1).then(resolve, reject);
          }
          // Legacy long confirm token
          const mToken = html.match(/confirm=([a-zA-Z0-9_-]{4,})/);
          if (mToken) {
            const sep = url.includes('?') ? '&' : '?';
            return resolveVideoUrl(`${url}${sep}confirm=${mToken[1]}`, cookies, hops + 1).then(resolve, reject);
          }
          reject(new Error(
            'Google Drive returned a webpage instead of the video. ' +
            'Make sure the file is shared as "Anyone with the link can view" and try again.'
          ));
        });
        res.on('error', reject);
        return;
      }

      // 200 or 206 — we found the actual video URL
      res.resume();
      resolve({ url, cookies: { ...cookies } });
    });

    req.on('timeout', () => req.destroy(new Error('Google Drive request timed out')));
    req.on('error', reject);
  });
}

// ─── Streaming proxy ──────────────────────────────────────────────────────────
// Resolves the Drive URL once per room, then forwards every Range request from
// the browser straight to Drive's CDN and pipes bytes back.  Nothing is written
// to disk — data flows through memory only.
app.get('/proxy/:roomId/video', async (req, res) => {
  const roomId = req.params.roomId.toUpperCase();
  const room   = rooms.get(roomId);
  if (!room) return res.status(404).end();

  // Resolve (or re-resolve if the CDN token has aged out)
  if (!room.resolvedUrl || Date.now() - room.resolvedAt > 45 * 60 * 1000) {
    try {
      const result         = await resolveVideoUrl(room.videoUrl);
      room.resolvedUrl     = result.url;
      room.resolvedCookies = result.cookies;
      room.resolvedAt      = Date.now();
      console.log(`Room ${roomId}: Drive URL resolved`);
    } catch (err) {
      console.error(`Room ${roomId}: resolution failed —`, err.message);
      return res.status(502).json({ error: err.message });
    }
  }

  const u = new URL(room.resolvedUrl);
  const mod = u.protocol === 'https:' ? https : http;
  const cookieStr = Object.entries(room.resolvedCookies || {})
    .map(([k, v]) => `${k}=${v}`).join('; ');

  const driveReq = mod.get({
    hostname: u.hostname,
    path: u.pathname + u.search,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ...(req.headers.range ? { Range: req.headers.range } : {}),
      ...(cookieStr        ? { Cookie: cookieStr }         : {})
    }
  }, (driveRes) => {
    // CDN token expired — clear cache so next request re-resolves
    if (driveRes.statusCode === 401 || driveRes.statusCode === 403) {
      driveRes.resume();
      room.resolvedUrl = null;
      return res.status(502).json({ error: 'Drive session expired — refresh the page to reconnect.' });
    }

    res.status(driveRes.statusCode);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      if (driveRes.headers[h]) res.setHeader(h, driveRes.headers[h]);
    });
    driveRes.pipe(res);
    res.on('close', () => { try { driveRes.destroy(); } catch (_) {} });
  });

  driveReq.on('timeout', () => {
    driveReq.destroy();
    if (!res.headersSent) res.status(504).end('Gateway timeout');
  });
  driveReq.on('error', err => {
    if (!res.headersSent) res.status(502).end(err.message);
  });
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
    id:              roomId,
    hostSocketId:    null,
    hostName:        sanitize(hostName).substring(0, 30),
    videoUrl,
    resolvedUrl:     null,
    resolvedCookies: null,
    resolvedAt:      0,
    playbackState:   { playing: false, currentTime: 0, lastUpdated: Date.now() },
    participants:    new Map(),
    chatMessages:    [],
    createdAt:       Date.now(),
    gracePeriodTimer: null,
    idleTimer:       null
  };

  rooms.set(roomId, room);
  resetIdleTimer(roomId);
  console.log(`Room ${roomId} created by "${room.hostName}"`);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, hostName: room.hostName });
});

app.get('/room/:roomId', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
const chatLimits = new Map();

io.on('connection', (socket) => {

  socket.on('host-join', ({ roomId }) => {
    const id   = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    if (room.gracePeriodTimer) { clearTimeout(room.gracePeriodTimer); room.gracePeriodTimer = null; }

    room.hostSocketId  = socket.id;
    socket.roomId      = id;
    socket.isHost      = true;
    socket.displayName = room.hostName;

    room.participants.set(socket.id, { name: room.hostName, joinedAt: Date.now(), isBuffering: false, isHost: true });
    socket.join(id);

    socket.emit('room-state', {
      playbackState: room.playbackState,
      participants:  serializeParticipants(room),
      chatMessages:  room.chatMessages,
      hostName:      room.hostName,
      isHost:        true
    });
    io.to(id).emit('participant-update', { participants: serializeParticipants(room) });
  });

  socket.on('join-room', ({ roomId, name }) => {
    const id   = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) { socket.emit('error', { message: 'Room not found or has ended' }); return; }

    const displayName = sanitize((name || 'Guest').substring(0, 30));
    room.participants.set(socket.id, { name: displayName, joinedAt: Date.now(), isBuffering: false, isHost: false });
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
      isHost:        false
    });

    const sysMsg = systemMessage(`${displayName} joined the room.`);
    pushChat(room, sysMsg);
    io.to(id).emit('chat-message', sysMsg);
    io.to(id).emit('participant-update', { participants: serializeParticipants(room) });
  });

  socket.on('play', ({ currentTime }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState = { playing: true, currentTime, lastUpdated: Date.now() };
    resetIdleTimer(socket.roomId);
    const sysMsg = systemMessage('Host resumed playback.');
    pushChat(room, sysMsg);
    socket.broadcast.to(socket.roomId).emit('play', { currentTime });
    io.to(socket.roomId).emit('chat-message', sysMsg);
  });

  socket.on('pause', ({ currentTime }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState = { playing: false, currentTime, lastUpdated: Date.now() };
    const sysMsg = systemMessage('Host paused the video.');
    pushChat(room, sysMsg);
    socket.broadcast.to(socket.roomId).emit('pause', { currentTime });
    io.to(socket.roomId).emit('chat-message', sysMsg);
  });

  socket.on('seek', ({ currentTime }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdated = Date.now();
    socket.broadcast.to(socket.roomId).emit('seek', { currentTime });
  });

  socket.on('host-heartbeat', ({ currentTime, playing }) => {
    const room = hostRoom(socket);
    if (!room) return;
    room.playbackState = { playing, currentTime, lastUpdated: Date.now() };
    socket.to(socket.roomId).emit('sync', { currentTime, playing });
  });

  socket.on('buffering', ({ isBuffering }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) p.isBuffering = Boolean(isBuffering);
    io.to(socket.roomId).emit('participant-update', { participants: serializeParticipants(room) });
  });

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
