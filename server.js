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

const room = {
  hostId: null,
  slots: Array.from({ length: 12 }, (_, i) => ({
    idx: i, socketId: null, name: '', muted: false, dead: false, isHost: i === 11
  })),
  phase: 'day',
  timerSeconds: 15,
  timerRunning: false,
  allMuted: false
};

function broadcast(event, data) { io.emit(event, data); }

function getState() {
  return {
    slots: room.slots,
    hostId: room.hostId,
    phase: room.phase,
    timerSeconds: room.timerSeconds,
    timerRunning: room.timerRunning,
    allMuted: room.allMuted
  };
}

let timerInterval = null;

function startTimer() {
  if (timerInterval) return;
  room.timerRunning = true;
  timerInterval = setInterval(() => {
    if (room.timerSeconds > 0) {
      room.timerSeconds--;
      broadcast('timer:tick', { seconds: room.timerSeconds });
    }
    if (room.timerSeconds <= 0) {
      stopTimer();
      broadcast('timer:end', {});
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  room.timerRunning = false;
}

io.on('connection', (socket) => {
  console.log('connect:', socket.id);
  socket.emit('state:full', getState());

  socket.on('role:take:host', () => {
    if (room.hostId && room.hostId !== socket.id) {
      socket.emit('role:host:taken');
      return;
    }
    room.hostId = socket.id;
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

  socket.on('role:take:player', () => {
    const free = room.slots.slice(0, 11).find(s => !s.socketId);
    if (free) {
      free.socketId = socket.id;
      broadcast('state:full', getState());
    }
  });

  socket.on('timer:start', () => {
    if (socket.id !== room.hostId) return;
    startTimer();
    broadcast('state:full', getState());
  });

  socket.on('timer:stop', () => {
    if (socket.id !== room.hostId) return;
    stopTimer();
    broadcast('state:full', getState());
  });

  socket.on('timer:reset', ({ seconds }) => {
    if (socket.id !== room.hostId) return;
    stopTimer();
    room.timerSeconds = seconds;
    broadcast('state:full', getState());
  });

  socket.on('slot:rename', ({ idx, name }) => {
    if (socket.id !== room.hostId) return;
    if (room.slots[idx]) room.slots[idx].name = name;
    broadcast('state:full', getState());
  });

  socket.on('slot:mute', ({ idx }) => {
    if (socket.id !== room.hostId) return;
    if (room.slots[idx]) room.slots[idx].muted = !room.slots[idx].muted;
    broadcast('state:full', getState());
  });

  socket.on('slot:kill', ({ idx }) => {
    if (socket.id !== room.hostId) return;
    if (room.slots[idx]) room.slots[idx].dead = !room.slots[idx].dead;
    broadcast('state:full', getState());
  });

  socket.on('slot:swap', ({ from, to }) => {
    if (socket.id !== room.hostId) return;
    const a = room.slots[from], b = room.slots[to];
    if (!a || !b || a.isHost || b.isHost) return;
    [a.socketId, b.socketId, a.name, b.name, a.muted, b.muted, a.dead, b.dead] =
    [b.socketId, a.socketId, b.name, a.name, b.muted, a.muted, b.dead, a.dead];
    broadcast('state:full', getState());
  });

  socket.on('slot:shuffle', () => {
    if (socket.id !== room.hostId) return;
    const playerSlots = room.slots.slice(0, 11);
    for (let i = playerSlots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerSlots[i].socketId, playerSlots[j].socketId] =
      [playerSlots[j].socketId, playerSlots[i].socketId];
      [playerSlots[i].name, playerSlots[j].name] =
      [playerSlots[j].name, playerSlots[i].name];
    }
    broadcast('state:full', getState());
  });

  socket.on('slot:muteall', ({ muted }) => {
    if (socket.id !== room.hostId) return;
    room.allMuted = muted;
    io.emit('slot:muteall', { muted });
  });

  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    if (room.hostId === socket.id) {
      room.hostId = null;
      room.slots[11].socketId = null;
      stopTimer();
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
