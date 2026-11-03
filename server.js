'use strict';
/**
 * Ventisca — Deathmatch multijugador (todos contra todos, con respawn) en un mapa nevado.
 *
 * Un único proceso Node sirve tres cosas sobre el mismo puerto:
 *   - HTTP:      archivos estáticos de /public y GET /api/estado.
 *   - WebSocket: /ws  → canal bidireccional de juego (inputs del jugador ↔ estado del mundo, 30 veces por segundo).
 *   - SSE:       /events → canal unidireccional servidor → todos (killfeed, chat, rondas, tabla de posiciones, estadísticas).
 *
 * El servidor es autoritativo: él mueve a los jugadores, resuelve los disparos y decide quién muere.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const S = require('./public/shared.js');

const PORT = Number(process.env.PORT) || 3000;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const MIN_PLAYERS = 2;          // jugadores necesarios para arrancar una ronda
const RESPAWN_MS = 3000;
const SPAWN_PROTECT_MS = 1500;  // invulnerabilidad al reaparecer (se pierde al disparar)
const COUNTDOWN_MS = 5000;
const ROUND_END_MS = 8000;
const ITEM_RESPAWN_MS = 25000;
const MAX_DROPPED_ITEMS = 40;
// Duración y límite de bajas de cada partida; se pueden cambiar por variable de entorno
const MATCH_MS = Number(process.env.MATCH_MS) || 5 * 60 * 1000;
const KILL_LIMIT = Number(process.env.KILL_LIMIT) || 20;
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#ff6b9d', '#34495e', '#c0392b', '#16a085', '#8e44ad'];

// ---------------------------------------------------------------- Estado

const players = new Map();      // id → jugador
const items = new Map();        // id → objeto en el piso
const spawnTimers = new Map();  // índice de ITEM_SPAWNS → momento en que reaparece
let nextPlayerId = 1;
let nextItemId = 1;
let tickShots = [];
let scoreDirty = true;
const startedAt = Date.now();
const round = { state: 'warmup', endsAt: 0, number: 0 };

const clamp = S.clamp;
const r1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- HTTP

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') return handleSSE(req, res);

  if (url.pathname === '/api/estado') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ...stats(), ronda: roundInfo(), tabla: scoreboard() }));
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, file));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Prohibido');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- SSE (servidor → todos)

const sseClients = new Set();
let sseEventId = 0;

function formatSSE(event, data) {
  return `id: ${++sseEventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcastSSE(event, data) {
  const msg = formatSSE(event, data);
  for (const res of sseClients) res.write(msg);
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // Estado inicial para quien recién se conecta
  res.write(formatSSE('round', roundInfo()));
  res.write(formatSSE('scoreboard', scoreboard()));
  res.write(formatSSE('stats', stats()));
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// Comentario cada 15 s para que proxies y navegadores no corten la conexión
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 15000);

setInterval(() => {
  if (!scoreDirty) return;
  scoreDirty = false;
  broadcastSSE('scoreboard', scoreboard());
}, 1000);

setInterval(() => broadcastSSE('stats', stats()), 2000);

function scoreboard() {
  return [...players.values()]
    .filter((p) => p.joined)
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.wins - a.wins)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, wins: p.wins, alive: p.alive }));
}

function stats() {
  const joined = [...players.values()].filter((p) => p.joined);
  return {
    online: players.size,
    inGame: joined.length,
    alive: joined.filter((p) => p.alive).length,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    sseClients: sseClients.size,
  };
}

function roundInfo(extra) {
  return { state: round.state, endsAt: round.endsAt, number: round.number, minPlayers: MIN_PLAYERS, killLimit: KILL_LIMIT, ...extra };
}

// ---------------------------------------------------------------- WebSocket (juego)

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  const p = createPlayer(ws);
  players.set(p.id, p);
  send(ws, { t: 'welcome', id: p.id, tickRate: TICK_RATE });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') handleMessage(p, msg);
  });

  ws.on('close', () => removePlayer(p));
  ws.on('error', () => {});
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleMessage(p, msg) {
  const now = Date.now();
  switch (msg.t) {
    case 'join': {
      if (p.joined) return;
      p.name = cleanName(msg.name) || `Jugador${p.id}`;
      p.joined = true;
      // En deathmatch se puede entrar en cualquier momento; si la partida está terminando, aparece en la siguiente
      if (round.state !== 'ended') spawnPlayer(p);
      broadcastSSE('announce', { text: `${p.name} entró a la partida` });
      scoreDirty = true;
      break;
    }
    case 'i': {
      p.input.up = !!msg.u;
      p.input.down = !!msg.d;
      p.input.left = !!msg.l;
      p.input.right = !!msg.r;
      p.input.shoot = !!msg.s;
      if (Number.isFinite(msg.a)) p.angle = msg.a;
      // Contador de clics: permite no perder disparos semiautomáticos rápidos entre ticks
      if (Number.isFinite(msg.c) && msg.c > p.clicks) {
        p.clicks = msg.c;
        p.pendingClick = true;
        p.clickAt = now;
      }
      break;
    }
    case 'pickup':
      tryPickup(p);
      break;
    case 'reload':
      startReload(p, now);
      break;
    case 'slot':
      switchSlot(p, msg.s, now);
      break;
    case 'drop':
      if (p.alive && p.primary) {
        dropWeapon(p.primary, p.x + Math.cos(p.angle) * 30, p.y + Math.sin(p.angle) * 30);
        p.primary = null;
        switchSlot(p, 'secondary', now);
      }
      break;
    case 'chat': {
      if (!p.joined) return;
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!text || now - p.lastChat < 400) return;
      p.lastChat = now;
      broadcastSSE('chat', { name: p.name, color: p.color, text });
      break;
    }
    case 'ping':
      send(p.ws, { t: 'pong', ts: msg.ts });
      break;
  }
}

function cleanName(name) {
  return String(name || '').replace(/[<>\n\r\t]/g, '').trim().slice(0, 16);
}

function createPlayer(ws) {
  const id = nextPlayerId++;
  return {
    id, ws,
    name: '',
    color: COLORS[(id - 1) % COLORS.length],
    joined: false, alive: false, protectedUntil: 0,
    x: 0, y: 0, angle: 0, hp: 100, armor: 0, moving: false,
    input: { up: false, down: false, left: false, right: false, shoot: false },
    clicks: 0, pendingClick: false, clickAt: 0,
    primary: null, secondary: null, slot: 'secondary',
    lastShot: 0, reloadUntil: 0, reloadSlot: null, switchUntil: 0,
    kills: 0, deaths: 0, wins: 0,
    respawnAt: 0, killedBy: null, lastChat: 0,
    events: [],
  };
}

function removePlayer(p) {
  players.delete(p.id);
  if (!p.joined) return;
  if (p.alive && p.primary) dropWeapon(p.primary, p.x, p.y);
  broadcastSSE('announce', { text: `${p.name} salió de la partida` });
  scoreDirty = true;
}

// ---------------------------------------------------------------- Jugadores

function newWeapon(type) {
  const def = S.WEAPONS[type];
  return { type, mag: def.mag, reserve: def.reserve };
}

function currentWeapon(p) {
  return p.slot === 'primary' && p.primary ? p.primary : p.secondary;
}

// Busca un lugar libre lejos de los enemigos, pero no en la otra punta del mapa:
// cualquier punto a más de SAFE_SPAWN_DIST sirve; si no hay ninguno, el más alejado.
const SAFE_SPAWN_DIST = 800;

function findSpawn() {
  const others = [...players.values()].filter((o) => o.alive);
  let farthest = null;
  let farthestD = -1;
  for (let i = 0; i < 60; i++) {
    const x = 100 + Math.random() * (S.MAP.w - 200);
    const y = 100 + Math.random() * (S.MAP.h - 200);
    if (S.circleHitsWall(x, y, S.PLAYER_R + 8)) continue;
    let minD = Infinity;
    for (const o of others) minD = Math.min(minD, Math.hypot(o.x - x, o.y - y));
    if (minD >= SAFE_SPAWN_DIST) return { x, y };
    if (minD > farthestD) {
      farthestD = minD;
      farthest = { x, y };
    }
  }
  return farthest || { x: S.MAP.w / 2, y: S.MAP.h / 2 - 400 };
}

function spawnPlayer(p) {
  const pos = findSpawn();
  p.x = pos.x;
  p.y = pos.y;
  p.hp = 100;
  p.armor = 0;
  p.alive = true;
  p.protectedUntil = Date.now() + SPAWN_PROTECT_MS;
  p.primary = null;
  p.secondary = newWeapon('pistol');
  p.slot = 'secondary';
  p.reloadUntil = 0;
  p.respawnAt = 0;
  p.killedBy = null;
  p.pendingClick = false;
  scoreDirty = true;
}

function switchSlot(p, slot, now) {
  if (!p.alive) return;
  if (slot === 'toggle') slot = p.slot === 'primary' ? 'secondary' : 'primary';
  if (slot === 'primary' && !p.primary) return;
  if (slot !== 'primary' && slot !== 'secondary') return;
  if (slot === p.slot) return;
  p.slot = slot;
  p.reloadUntil = 0;
  p.switchUntil = now + 250;
}

function startReload(p, now) {
  if (!p.alive || p.reloadUntil) return;
  const w = currentWeapon(p);
  const def = S.WEAPONS[w.type];
  if (w.mag >= def.mag || (!def.infinite && w.reserve <= 0)) return;
  p.reloadUntil = now + def.reload;
  p.reloadSlot = p.slot;
}

function finishReload(p) {
  const w = p.reloadSlot === 'primary' ? p.primary : p.secondary;
  p.reloadUntil = 0;
  if (!w) return;
  const def = S.WEAPONS[w.type];
  const need = def.mag - w.mag;
  const take = def.infinite ? need : Math.min(need, w.reserve);
  w.mag += take;
  if (!def.infinite) w.reserve -= take;
}

// ---------------------------------------------------------------- Disparos

function rayAABB(ox, oy, dx, dy, w) {
  let tmin = -Infinity;
  let tmax = Infinity;
  if (dx !== 0) {
    const t1 = (w.x - ox) / dx;
    const t2 = (w.x + w.w - ox) / dx;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  } else if (ox < w.x || ox > w.x + w.w) return Infinity;
  if (dy !== 0) {
    const t1 = (w.y - oy) / dy;
    const t2 = (w.y + w.h - oy) / dy;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  } else if (oy < w.y || oy > w.y + w.h) return Infinity;
  if (tmax < Math.max(tmin, 0)) return Infinity;
  return Math.max(tmin, 0);
}

function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  if (-b - s >= 0) return -b - s;
  if (-b + s >= 0) return 0;
  return Infinity;
}

function tryShoot(p, now) {
  if (p.pendingClick && now - p.clickAt > 250) p.pendingClick = false;
  const w = currentWeapon(p);
  const def = S.WEAPONS[w.type];
  const wants = (def.auto && p.input.shoot) || p.pendingClick;
  if (!wants || p.reloadUntil || now < p.switchUntil || now - p.lastShot < def.rate) return;
  p.pendingClick = false;
  if (w.mag <= 0) {
    startReload(p, now);
    return;
  }
  w.mag--;
  p.protectedUntil = 0; // disparar cancela la protección de reaparición
  p.lastShot = now;
  const spread = def.spread * (p.moving ? 1.6 : 1);
  for (let i = 0; i < def.pellets; i++) {
    fireRay(p, p.angle + (Math.random() * 2 - 1) * spread, def, w.type);
  }
  if (w.mag === 0) startReload(p, now);
}

function fireRay(p, angle, def, type) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let tEnd = def.range;
  for (const w of S.WALLS) {
    const t = rayAABB(p.x, p.y, dx, dy, w);
    if (t < tEnd) tEnd = t;
  }
  let target = null;
  for (const o of players.values()) {
    if (o === p || !o.alive) continue;
    const t = rayCircle(p.x, p.y, dx, dy, o.x, o.y, S.PLAYER_R);
    if (t < tEnd) {
      tEnd = t;
      target = o;
    }
  }
  tickShots.push([r1(p.x + dx * 20), r1(p.y + dy * 20), r1(p.x + dx * tEnd), r1(p.y + dy * tEnd), target ? 1 : 0, type]);
  if (target) {
    // La escopeta pierde daño con la distancia
    const falloff = def.pellets > 1 ? clamp(1.2 - tEnd / def.range, 0.3, 1) : 1;
    damage(target, p, def.dmg * falloff, type);
  }
}

function damage(target, attacker, dmg, type) {
  if (!target.alive || Date.now() < target.protectedUntil) return;
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, dmg * 0.5);
    target.armor -= absorbed;
    dmg -= absorbed;
  }
  target.hp -= dmg;
  target.events.push('hurt');
  if (attacker) attacker.events.push('hit');
  if (target.hp <= 0) killPlayer(target, attacker, type);
}

function killPlayer(victim, killer, type) {
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  victim.killedBy = killer ? killer.name : null;
  victim.reloadUntil = 0;
  if (killer && killer !== victim) {
    killer.kills++;
    killer.events.push('kill');
  }
  if (victim.primary) {
    dropWeapon(victim.primary, victim.x, victim.y);
    victim.primary = null;
  }
  victim.respawnAt = Date.now() + RESPAWN_MS;
  scoreDirty = true;
  broadcastSSE('kill', {
    killer: killer ? killer.name : null,
    kc: killer ? killer.color : null,
    victim: victim.name,
    vc: victim.color,
    weapon: type,
  });
}

// ---------------------------------------------------------------- Objetos en el piso

function resetItems() {
  items.clear();
  spawnTimers.clear();
  S.ITEM_SPAWNS.forEach((_, idx) => spawnItemAt(idx));
}

function spawnItemAt(idx) {
  const sp = S.ITEM_SPAWNS[idx];
  const it = { id: nextItemId++, type: sp.type, x: sp.x, y: sp.y, spawn: idx };
  if (S.isWeapon(sp.type)) Object.assign(it, newWeapon(sp.type));
  items.set(it.id, it);
}

function dropWeapon(w, x, y) {
  const it = { id: nextItemId++, type: w.type, x: r1(x), y: r1(y), spawn: -1, mag: w.mag, reserve: w.reserve };
  items.set(it.id, it);
  // Evita que el mapa se llene de armas tiradas: se borra la más vieja
  const dropped = [...items.values()].filter((i) => i.spawn === -1);
  if (dropped.length > MAX_DROPPED_ITEMS) items.delete(dropped[0].id);
}

function takeItem(it, now) {
  items.delete(it.id);
  if (it.spawn >= 0) spawnTimers.set(it.spawn, now + ITEM_RESPAWN_MS);
}

function respawnItems(now) {
  for (const [idx, at] of spawnTimers) {
    if (now < at) continue;
    spawnTimers.delete(idx);
    spawnItemAt(idx);
  }
}

function autoPickups(p, now) {
  for (const it of items.values()) {
    if (it.type !== 'medkit' && it.type !== 'armor') continue;
    if (Math.hypot(it.x - p.x, it.y - p.y) > S.PICKUP_R) continue;
    if (it.type === 'medkit' && p.hp < 100) {
      p.hp = Math.min(100, p.hp + 50);
      takeItem(it, now);
    } else if (it.type === 'armor' && p.armor < 100) {
      p.armor = 100;
      takeItem(it, now);
    }
  }
}

function tryPickup(p) {
  if (!p.alive) return;
  const now = Date.now();
  let best = null;
  let bestD = S.PICKUP_R;
  for (const it of items.values()) {
    if (!S.isWeapon(it.type)) continue;
    const d = Math.hypot(it.x - p.x, it.y - p.y);
    if (d <= bestD) {
      best = it;
      bestD = d;
    }
  }
  if (!best) return;
  const def = S.WEAPONS[best.type];
  if (p.primary && p.primary.type === best.type) {
    // Misma arma: solo se toma la munición
    if (p.primary.reserve >= def.reserve * 2) return;
    p.primary.reserve = Math.min(def.reserve * 2, p.primary.reserve + best.mag + best.reserve);
  } else {
    if (p.primary) dropWeapon(p.primary, p.x, p.y);
    p.primary = { type: best.type, mag: best.mag, reserve: best.reserve };
    p.slot = 'primary';
    p.reloadUntil = 0;
    p.switchUntil = now + 250;
  }
  takeItem(best, now);
}

// ---------------------------------------------------------------- Partidas (deathmatch)

function setState(state, endsAt, extra) {
  round.state = state;
  round.endsAt = endsAt;
  broadcastSSE('round', roundInfo(extra));
}

function startRound(now) {
  round.number++;
  resetItems();
  for (const p of players.values()) {
    if (!p.joined) continue;
    p.kills = 0;
    p.deaths = 0;
    p.alive = false;
  }
  for (const p of players.values()) if (p.joined) spawnPlayer(p);
  setState('playing', now + MATCH_MS);
  broadcastSSE('announce', { text: `¡Empieza la partida ${round.number}! Gana el primero en llegar a ${KILL_LIMIT} bajas o el que tenga más al terminar el tiempo.` });
}

// Gana quien tiene más bajas; si empatan, quien murió menos
function leader() {
  let best = null;
  for (const p of players.values()) {
    if (!p.joined) continue;
    if (!best || p.kills > best.kills || (p.kills === best.kills && p.deaths < best.deaths)) best = p;
  }
  return best && best.kills > 0 ? best : null;
}

function endRound(now) {
  const winner = leader();
  if (winner) {
    winner.wins++;
    scoreDirty = true;
  }
  setState('ended', now + ROUND_END_MS, {
    winner: winner ? winner.name : null,
    winnerColor: winner ? winner.color : null,
    winnerKills: winner ? winner.kills : 0,
  });
  broadcastSSE('announce', {
    text: winner ? `${winner.name} ganó la partida ${round.number} con ${winner.kills} bajas` : `Partida ${round.number}: nadie hizo bajas`,
  });
}

function updateRound(now) {
  const active = [...players.values()].filter((p) => p.joined);
  switch (round.state) {
    case 'warmup':
      if (active.length >= MIN_PLAYERS) setState('countdown', now + COUNTDOWN_MS);
      break;
    case 'countdown':
      if (active.length < MIN_PLAYERS) setState('warmup', 0);
      else if (now >= round.endsAt) startRound(now);
      break;
    case 'playing':
      if (active.length < MIN_PLAYERS) setState('warmup', 0);
      else if (now >= round.endsAt || active.some((p) => p.kills >= KILL_LIMIT)) endRound(now);
      break;
    case 'ended':
      if (now < round.endsAt) break;
      if (active.length >= MIN_PLAYERS) setState('countdown', now + COUNTDOWN_MS);
      else setState('warmup', 0);
      for (const p of active) if (!p.alive) spawnPlayer(p);
      break;
  }
}

// ---------------------------------------------------------------- Bucle principal

function tick() {
  const now = Date.now();
  updateRound(now);
  // Al terminar la partida todos quedan congelados (sin disparar ni reaparecer) hasta la siguiente
  const frozen = round.state === 'ended';

  for (const p of players.values()) {
    if (!p.joined) continue;
    if (!p.alive) {
      if (!frozen && p.respawnAt && now >= p.respawnAt) spawnPlayer(p);
      continue;
    }

    const mx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const my = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    const len = Math.hypot(mx, my);
    p.moving = len > 0;
    if (p.moving) {
      const speed = S.SPEED * S.WEAPONS[currentWeapon(p).type].speed * DT;
      S.moveCircle(p, (mx / len) * speed, (my / len) * speed, S.PLAYER_R);
    }

    if (p.reloadUntil && now >= p.reloadUntil) finishReload(p);
    autoPickups(p, now);
    if (!frozen) tryShoot(p, now);
  }

  respawnItems(now);
  broadcastSnapshot(now);
  tickShots = [];
}

function broadcastSnapshot(now) {
  const pl = [];
  for (const p of players.values()) {
    if (!p.joined) continue;
    pl.push({
      id: p.id, n: p.name, c: p.color,
      x: r1(p.x), y: r1(p.y), a: Math.round(p.angle * 100) / 100,
      hp: Math.ceil(p.hp), ar: Math.ceil(p.armor), al: p.alive ? 1 : 0,
      w: p.alive ? currentWeapon(p).type : null,
      k: p.kills, d: p.deaths, pr: now < p.protectedUntil ? 1 : 0,
    });
  }
  const it = [];
  for (const i of items.values()) it.push({ id: i.id, k: i.type, x: i.x, y: i.y });

  // La parte común se serializa una sola vez; a cada cliente se le agrega su propio estado ("me")
  const base = JSON.stringify({ t: 's', now, st: round.state, te: round.endsAt, rn: round.number, kl: KILL_LIMIT, p: pl, i: it, sh: tickShots }).slice(0, -1);

  for (const p of players.values()) {
    if (p.ws.readyState !== WebSocket.OPEN || p.ws.bufferedAmount > 256 * 1024) continue;
    const me = p.joined
      ? {
          id: p.id, al: p.alive ? 1 : 0,
          x: r1(p.x), y: r1(p.y), hp: Math.ceil(p.hp), ar: Math.ceil(p.armor),
          slot: p.slot, pw: p.primary, sw: p.secondary, rl: p.reloadUntil,
          ev: p.events, kb: p.killedBy, ra: p.respawnAt,
        }
      : null;
    p.ws.send(`${base},"me":${JSON.stringify(me)}}`);
    p.events = [];
  }
}

resetItems();
setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`\n  ❄  Ventisca corriendo en http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`     En la red local: http://${net.address}:${PORT}`);
    }
  }
  console.log('');
});
