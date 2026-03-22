const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── GAME STATE ──
const room = {
  hostId: null,       // socket.id of the host
  slots: Array.from({ length: 12 }, (_, i) => ({
    idx: i,
    socketId: null,
    name: '',
    muted: false,
    dead: false,
    isHost: i === 11
  })),
  phase: 'day',
  timerSeconds: 15,
  timerRunning: false
};

function broadcast(event, data) {
  io.emit(event, data);
}

function getState() {
  return {
    slots: room.slots,
    phase: room.phase,
    hostId: room.hostId,
    timerSeconds: room.timerSeconds,
    timerRunning: room.timerRunning
  };
}

// ── TIMER on server ──
let timerInterval = null;

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  room.timerRunning = true;
  timerInterval = setInterval(() => {
    if (room.timerSeconds > 0) {
      room.timerSeconds--;
      broadcast('timer:tick', { seconds: room.timerSeconds });
    } else {
      clearInterval(timerInterval);
      room.timerRunning = false;
      broadcast('timer:end', {});
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  room.timerRunning = false;
  broadcast('timer:tick', { seconds: room.timerSeconds });
}

function resetTimer(seconds) {
  clearInterval(timerInterval);
  room.timerRunning = false;
  room.timerSeconds = seconds;
  broadcast('timer:tick', { seconds: room.timerSeconds });
}

// ── CONNECTIONS ──
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Send current state to new joiner
  socket.emit('state:full', getState());

  // ── ROLE ──
  socket.on('role:take:host', () => {
    if (room.hostId && room.hostId !== socket.id) {
      socket.emit('role:host:taken');
      return;
    }
    room.hostId = socket.id;
    // assign to host slot
    room.slots[11].socketId = socket.id;
    broadcast('state:full', getState());
  });

  socket.on('role:release:host', () => {
    if (room.hostId === socket.id) {
      room.hostId = null;
      room.slots[11].socketId = null;
      broadcast('state:full', getState());
    }
  });

  socket.on('role:take:player', (slotIdx) => {
    // find free player slot or use provided
    let idx = slotIdx;
    if (idx === undefined || idx === null) {
      idx = room.slots.findIndex(s => !s.isHost && !s.socketId);
    }
    if (idx === -1 || idx === 11) return;
    room.slots[idx].socketId = socket.id;
    broadcast('state:full', getState());
  });

  // ── HOST ACTIONS ──
  socket.on('slot:rename', ({ idx, name }) => {
    if (socket.id !== room.hostId) return;
    room.slots[idx].name = name;
    broadcast('state:full', getState());
  });

  socket.on('slot:mute', ({ idx }) => {
    if (socket.id !== room.hostId) return;
    room.slots[idx].muted = !room.slots[idx].muted;
    broadcast('state:full', getState());
  });

  socket.on('slot:kill', ({ idx }) => {
    if (socket.id !== room.hostId) return;
    room.slots[idx].dead = !room.slots[idx].dead;
    broadcast('state:full', getState());
  });

  socket.on('slot:swap', ({ from, to }) => {
    if (socket.id !== room.hostId) return;
    const a = room.slots[from];
    const b = room.slots[to];
    [a.name, b.name] = [b.name, a.name];
    [a.muted, b.muted] = [b.muted, a.muted];
    [a.dead, b.dead] = [b.dead, a.dead];
    [a.socketId, b.socketId] = [b.socketId, a.socketId];
    broadcast('state:full', getState());
  });

  socket.on('slot:shuffle', () => {
    if (socket.id !== room.hostId) return;
    const playerSlots = room.slots.filter(s => !s.isHost);
    const data = playerSlots.map(s => ({ name: s.name, muted: s.muted, dead: s.dead, socketId: s.socketId }));
    for (let i = data.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [data[i], data[j]] = [data[j], data[i]];
    }
    playerSlots.forEach((s, i) => {
      s.name = data[i].name;
      s.muted = data[i].muted;
      s.dead = data[i].dead;
      s.socketId = data[i].socketId;
    });
    broadcast('state:full', getState());
  });

  // ── PHASE ──
  socket.on('phase:set', ({ phase }) => {
    if (socket.id !== room.hostId) return;
    room.phase = phase;
    broadcast('state:full', getState());
  });

  // ── TIMER ──
  socket.on('timer:start', () => {
    if (socket.id !== room.hostId) return;
    startTimer();
  });

  socket.on('timer:stop', () => {
    if (socket.id !== room.hostId) return;
    stopTimer();
  });

  socket.on('timer:reset', ({ seconds }) => {
    if (socket.id !== room.hostId) return;
    resetTimer(seconds);
  });

  // ── WebRTC SIGNALING ──
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);
    if (room.hostId === socket.id) {
      room.hostId = null;
      room.slots[11].socketId = null;
    }
    room.slots.forEach(s => {
      if (s.socketId === socket.id) s.socketId = null;
    });
    broadcast('state:full', getState());
  });
});

app.get('/', (req, res) => res.send('Mafia server running ✓'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
