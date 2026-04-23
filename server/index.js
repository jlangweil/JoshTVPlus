require('dotenv').config();
const express = require('express');
const http = require('http');
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

    room.hostSocketId   = socket.id;
    socket.roomId       = id;
    socket.isHost       = true;
    socket.displayName  = room.hostName;

    room.participants.set(socket.id, { name: room.hostName, joinedAt: Date.now(), isBuffering: false, isHost: true });
    socket.join(id);

    socket.emit('room-state', {
      playbackState: room.playbackState,
      participants:  serializeParticipants(room),
      chatMessages:  room.chatMessages,
      hostName:      room.hostName,
      isHost:        true,
      videoUrl:      room.videoUrl
    });
    io.to(id).emit('participant-update', { participants: serializeParticipants(room) });
  });

  // ── Guest joins ──
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
      isHost:        false,
      videoUrl:      room.videoUrl
    });

    const sysMsg = systemMessage(`${displayName} joined the room.`);
    pushChat(room, sysMsg);
    io.to(id).emit('chat-message', sysMsg);
    io.to(id).emit('participant-update', { participants: serializeParticipants(room) });
  });

  // ── Playback: play ──
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
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdated = Date.now();
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
