const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1600;
const TICK_RATE = 60;

const WEAPONS = {
  fists: { name: 'Fists', damage: 10, range: 50, fireRate: 500, type: 'melee', ammo: Infinity },
  sword: { name: 'Sword', damage: 35, range: 70, fireRate: 600, type: 'melee', ammo: Infinity },
  axe: { name: 'Axe', damage: 55, range: 65, fireRate: 900, type: 'melee', ammo: Infinity },
  pistol: { name: 'Pistol', damage: 20, range: 400, fireRate: 400, type: 'gun', ammo: 30 },
  shotgun: { name: 'Shotgun', damage: 60, range: 200, fireRate: 800, type: 'gun', ammo: 10 },
  rifle: { name: 'Rifle', damage: 40, range: 600, fireRate: 300, type: 'gun', ammo: 20 },
};

let gameState = {
  players: {},
  bullets: [],
  pickups: [],
  zone: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2, radius: 900, targetRadius: 680, shrinking: false, shrinkTimer: 10, stage: 0 },
  gameStarted: false,
  gameOver: false,
  winner: null,
  countdown: null,
};

let bulletIdCounter = 0;
let pickupIdCounter = 0;
let countdownInterval = null;
let readyPlayers = new Set();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function spawnPickups() {
  gameState.pickups = [];
  const weaponTypes = ['sword', 'axe', 'pistol', 'shotgun', 'rifle'];
  for (let i = 0; i < 15; i++) {
    const wType = weaponTypes[randomInt(0, weaponTypes.length - 1)];
    gameState.pickups.push({
      id: pickupIdCounter++,
      x: randomInt(100, MAP_WIDTH - 100),
      y: randomInt(100, MAP_HEIGHT - 100),
      type: 'weapon',
      weapon: wType,
    });
  }
  for (let i = 0; i < 10; i++) {
    gameState.pickups.push({
      id: pickupIdCounter++,
      x: randomInt(100, MAP_WIDTH - 100),
      y: randomInt(100, MAP_HEIGHT - 100),
      type: 'health',
      amount: 40,
    });
  }
}

function resetGame() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  gameState.bullets = [];
  gameState.zone = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2, radius: 900, targetRadius: 680, shrinking: false, shrinkTimer: 10, stage: 0 };
  gameState.gameStarted = false;
  gameState.gameOver = false;
  gameState.winner = null;
  gameState.countdown = null;
  spawnPickups();
  const spawnPoints = [
    { x: MAP_WIDTH / 2, y: 150 },
    { x: MAP_WIDTH - 150, y: MAP_HEIGHT / 2 },
    { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 150 },
    { x: 150, y: MAP_HEIGHT / 2 },
  ];
  let si = 0;
  for (const id in gameState.players) {
    const p = gameState.players[id];
    const spawn = spawnPoints[si % spawnPoints.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.spawnIndex = si;
    si++;
    p.hp = 100;
    p.alive = true;
    p.weapon = 'fists';
    p.ammo = Infinity;
    p.lastShot = 0;
  }
  gameState.gameStartTime = null;
}

function startCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  let count = 5;
  gameState.countdown = count;
  io.emit('gameState', getSafeState());
  countdownInterval = setInterval(() => {
    count--;
    gameState.countdown = count;
    io.emit('gameState', getSafeState());
    if (count <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      gameState.gameStarted = true;
      gameState.gameStartTime = Date.now();
      gameState.countdown = null;
      spawnPickups();
      io.emit('gameState', getSafeState());
    }
  }, 1000);
}

function getSafeState() {
  return {
    players: gameState.players,
    bullets: gameState.bullets,
    pickups: gameState.pickups,
    zone: gameState.zone,
    gameStarted: gameState.gameStarted,
    gameOver: gameState.gameOver,
    winner: gameState.winner,
    countdown: gameState.countdown,
  };
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Game loop
let lastTick = Date.now();
setInterval(() => {
  if (!gameState.gameStarted || gameState.gameOver) return;

  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  // Shrink zone - 5 stages, each starts after 10s wait, shrinks over ~8s
  const stageTargets = [680, 480, 280, 130, 30];
  gameState.zone.shrinkTimer -= dt;
  if (gameState.zone.shrinkTimer <= 0 && !gameState.zone.shrinking && gameState.zone.stage < stageTargets.length) {
    gameState.zone.shrinking = true;
    gameState.zone.targetRadius = stageTargets[gameState.zone.stage];
  }
  if (gameState.zone.shrinking) {
    gameState.zone.radius -= 25 * dt;
    if (gameState.zone.radius <= gameState.zone.targetRadius) {
      gameState.zone.radius = gameState.zone.targetRadius;
      gameState.zone.shrinking = false;
      gameState.zone.stage += 1;
      gameState.zone.shrinkTimer = 10;
    }
  }

  // Zone damage
  for (const id in gameState.players) {
    const p = gameState.players[id];
    if (!p.alive) continue;
    const d = dist(p, gameState.zone);
    if (d > gameState.zone.radius) {
      p.hp -= 8 * dt;
      if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
        io.emit('playerDied', { id, killer: 'zone' });
      }
    }
  }

  // Move bullets
  gameState.bullets = gameState.bullets.filter(b => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) return false;
    if (b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > MAP_HEIGHT) return false;

    // Check bullet hits
    for (const id in gameState.players) {
      if (id === b.ownerId) continue;
      const p = gameState.players[id];
      if (!p.alive) continue;
      if (dist(b, p) < 18) {
        p.hp -= b.damage;
        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          io.emit('playerDied', { id, killer: b.ownerName });
          // Give killer some hp
          if (gameState.players[b.ownerId]) {
            gameState.players[b.ownerId].hp = Math.min(100, gameState.players[b.ownerId].hp + 15);
          }
        }
        return false;
      }
    }
    return true;
  });

  // Check win condition - only after game has been running for at least 2 seconds
  if (!gameState.gameStartTime) gameState.gameStartTime = Date.now();
  const timeAlive = (Date.now() - gameState.gameStartTime) / 1000;
  if (timeAlive > 2) {
    const alive = Object.values(gameState.players).filter(p => p.alive);
    if (alive.length === 1 && Object.keys(gameState.players).length > 1) {
      gameState.gameOver = true;
      gameState.winner = alive[0].name;
      io.emit('gameOver', { winner: alive[0].name });
    } else if (alive.length === 0) {
      gameState.gameOver = true;
      gameState.winner = 'Nobody';
      io.emit('gameOver', { winner: 'Nobody' });
    }
  }

  io.emit('gameState', getSafeState());
}, 1000 / TICK_RATE);

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  if (Object.keys(gameState.players).length >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect();
    return;
  }

  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
  const usedColors = Object.values(gameState.players).map(p => p.color);
  const color = colors.find(c => !usedColors.includes(c)) || colors[0];

  const playerIndex = Object.keys(gameState.players).length;
  const spawnPoints = [
    { x: MAP_WIDTH / 2, y: 150 },           // North
    { x: MAP_WIDTH - 150, y: MAP_HEIGHT / 2 }, // East
    { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 150 }, // South
    { x: 150, y: MAP_HEIGHT / 2 },           // West
  ];
  const spawn = spawnPoints[playerIndex] || spawnPoints[0];

  gameState.players[socket.id] = {
    id: socket.id,
    name: `Player${playerIndex + 1}`,
    x: spawn.x,
    y: spawn.y,
    spawnIndex: playerIndex,
    hp: 100,
    alive: true,
    color,
    weapon: 'fists',
    ammo: Infinity,
    lastShot: 0,
    angle: 0,
    joined: false,
  };

  socket.emit('init', { id: socket.id, mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT, weapons: WEAPONS });
  socket.emit('gameState', getSafeState());
  io.emit('gameState', getSafeState());

  socket.on('move', (data) => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive || !gameState.gameStarted) return;
    p.x = Math.max(0, Math.min(MAP_WIDTH, data.x));
    p.y = Math.max(0, Math.min(MAP_HEIGHT, data.y));
    p.angle = data.angle;
  });

  socket.on('shoot', (data) => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive || !gameState.gameStarted) return;
    const weapon = WEAPONS[p.weapon];
    if (!weapon || weapon.type !== 'gun') return;
    const now = Date.now();
    if (now - p.lastShot < weapon.fireRate) return;
    if (p.ammo <= 0) return;
    p.lastShot = now;
    if (p.ammo !== Infinity) p.ammo--;

    const speed = 500;
    gameState.bullets.push({
      id: bulletIdCounter++,
      x: p.x,
      y: p.y,
      vx: Math.cos(data.angle) * speed,
      vy: Math.sin(data.angle) * speed,
      damage: weapon.damage,
      ownerId: socket.id,
      ownerName: p.name,
      life: weapon.range / speed,
    });
  });

  socket.on('melee', () => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive || !gameState.gameStarted) return;
    const weapon = WEAPONS[p.weapon];
    if (!weapon || weapon.type !== 'melee') return;
    const now = Date.now();
    if (now - p.lastShot < weapon.fireRate) return;
    p.lastShot = now;

    for (const id in gameState.players) {
      if (id === socket.id) continue;
      const target = gameState.players[id];
      if (!target.alive) continue;
      if (dist(p, target) < weapon.range) {
        target.hp -= weapon.damage;
        if (target.hp <= 0) {
          target.hp = 0;
          target.alive = false;
          io.emit('playerDied', { id, killer: p.name });
          p.hp = Math.min(100, p.hp + 15);
        }
      }
    }
  });

  socket.on('pickup', (pickupId) => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive || !gameState.gameStarted) return;
    const idx = gameState.pickups.findIndex(pk => pk.id === pickupId);
    if (idx === -1) return;
    const pickup = gameState.pickups[idx];
    if (dist(p, pickup) > 40) return;

    if (pickup.type === 'weapon') {
      p.weapon = pickup.weapon;
      p.ammo = WEAPONS[pickup.weapon].ammo;
    } else if (pickup.type === 'health') {
      p.hp = Math.min(100, p.hp + pickup.amount);
    }
    gameState.pickups.splice(idx, 1);
  });

  socket.on('setName', (name) => {
    const p = gameState.players[socket.id];
    if (!p) return;
    p.name = name.slice(0, 12);
    p.joined = true;
    io.emit('gameState', getSafeState());
    // Start countdown only when 2+ players have actually joined
    const joinedCount = Object.values(gameState.players).filter(pl => pl.joined).length;
    if (joinedCount >= 2 && !gameState.gameStarted && gameState.countdown === null && !gameState.gameOver) {
      startCountdown();
    }
  });

  socket.on('voteRestart', () => {
    if (!gameState.gameOver) return;
    readyPlayers.add(socket.id);
    const totalPlayers = Object.keys(gameState.players).length;
    io.emit('restartVote', { ready: readyPlayers.size, total: totalPlayers });
    if (readyPlayers.size >= totalPlayers && totalPlayers >= 1) {
      readyPlayers.clear();
      resetGame();
      for (const id in gameState.players) {
        gameState.players[id].joined = true;
      }
      io.emit('gameState', getSafeState());
      const joinedCount = Object.values(gameState.players).filter(pl => pl.joined).length;
      if (joinedCount >= 2) startCountdown();
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete gameState.players[socket.id];
    io.emit('gameState', getSafeState());

    const playerCount = Object.keys(gameState.players).length;

    // Remove from ready set if they disconnect
    readyPlayers.delete(socket.id);

    // If no players left, fully reset everything
    if (playerCount === 0) {
      readyPlayers.clear();
      resetGame();
      return;
    }

    // Update vote count for remaining players
    if (gameState.gameOver) {
      io.emit('restartVote', { ready: readyPlayers.size, total: playerCount });
    }

    if (gameState.gameOver) return;

    const alive = Object.values(gameState.players).filter(p => p.alive);
    if (alive.length === 1 && playerCount >= 1 && gameState.gameStarted) {
      gameState.gameOver = true;
      gameState.winner = alive[0].name;
      io.emit('gameOver', { winner: alive[0].name });
    } else if (alive.length === 0 && gameState.gameStarted) {
      gameState.gameOver = true;
      gameState.winner = 'Nobody';
      io.emit('gameOver', { winner: 'Nobody' });
    }

    // If game hasn't started and countdown is running but not enough joined players, cancel
    const joinedCount = Object.values(gameState.players).filter(pl => pl.joined).length;
    if (!gameState.gameStarted && joinedCount < 2 && gameState.countdown !== null) {
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      gameState.countdown = null;
      io.emit('gameState', getSafeState());
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));