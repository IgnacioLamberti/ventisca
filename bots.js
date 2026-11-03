'use strict';
/**
 * Inteligencia de los bots que completan la partida hasta llegar a la capacidad máxima.
 *
 * Los bots corren dentro del servidor y "juegan" igual que una persona: en cada tick deciden
 * qué teclas apretar y hacia dónde apuntar (p.input, p.angle). Después la simulación normal
 * los mueve, resuelve sus disparos y les aplica daño con las mismas reglas que a todos.
 */
const S = require('./public/shared.js');

const NAMES = ['Copito', 'Yeti', 'Pingüino', 'Escarcha', 'Témpano', 'Glaciar', 'Avalancha', 'Granizo', 'Ventisquero', 'Iglú', 'Trineo', 'Morsa'];
const ENGAGE_RANGE = 850;  // distancia máxima a la que un bot ve y ataca
const THINK_MS = 150;      // cada cuánto replantea objetivo y destino
const WEAPON_RANK = { pistol: 0, sniper: 2, shotgun: 3, smg: 3, rifle: 4 };
const IDEAL_RANGE = { pistol: 350, smg: 380, rifle: 450, shotgun: 200, sniper: 650 };

function pickName(taken) {
  const free = NAMES.filter((n) => !taken.has(`Bot ${n}`));
  const base = free.length ? free[Math.floor(Math.random() * free.length)] : String(Math.floor(Math.random() * 1000));
  return `Bot ${base}`;
}

function createBrain() {
  return {
    nextThink: 0,
    targetId: null,
    reactAt: 0,
    aimError: 0,
    nextClick: 0,
    goal: null,
    goalUntil: 0,
    strafe: 1,
    strafeUntil: 0,
    lastPos: null,
    stuckCheckAt: 0,
    unstickUntil: 0,
    unstickDir: null,
  };
}

function hasLineOfSight(ax, ay, bx, by, rayAABB) {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  for (const w of S.WALLS) {
    if (rayAABB(ax, ay, dx / dist, dy / dist, w) < dist) return false;
  }
  return true;
}

function randomFreePoint() {
  for (let i = 0; i < 30; i++) {
    const x = 100 + Math.random() * (S.MAP.w - 200);
    const y = 100 + Math.random() * (S.MAP.h - 200);
    if (!S.circleHitsWall(x, y, S.PLAYER_R + 10)) return { x, y };
  }
  return { x: S.MAP.w / 2, y: S.MAP.h / 2 };
}

function nearestItem(p, items, accept, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const it of items.values()) {
    if (!accept(it.type)) continue;
    const d = Math.hypot(it.x - p.x, it.y - p.y);
    if (d < bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}

function nearestEnemy(p, players) {
  let best = null;
  let bestD = Infinity;
  for (const o of players.values()) {
    if (o === p || !o.joined || !o.alive) continue;
    const d = Math.hypot(o.x - p.x, o.y - p.y);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

// Elige hacia dónde caminar cuando no hay nadie a la vista
function chooseGoal(p, b, now, world) {
  let goal = null;
  if (!p.primary) goal = nearestItem(p, world.items, S.isWeapon, 1600);
  else if (p.hp < 60) goal = nearestItem(p, world.items, (t) => t === 'medkit', 1400);
  else if (p.armor < 1 && Math.random() < 0.3) goal = nearestItem(p, world.items, (t) => t === 'armor', 1400);
  if (!goal && Math.random() < 0.6) goal = nearestEnemy(p, world.players);
  b.goal = goal ? { x: goal.x, y: goal.y } : randomFreePoint();
  b.goalUntil = now + 4000 + Math.random() * 3000;
}

function think(p, b, now, world) {
  // Enemigo visible más cercano (los recién reaparecidos son invulnerables, no vale la pena)
  let target = null;
  let targetD = ENGAGE_RANGE;
  for (const o of world.players.values()) {
    if (o === p || !o.joined || !o.alive || now < o.protectedUntil) continue;
    const d = Math.hypot(o.x - p.x, o.y - p.y);
    if (d >= targetD || !hasLineOfSight(p.x, p.y, o.x, o.y, world.rayAABB)) continue;
    target = o;
    targetD = d;
  }
  if (target) {
    // Tiempo de reacción al ver a alguien nuevo, y puntería peor cuanto más lejos
    if (target.id !== b.targetId) b.reactAt = now + 250 + Math.random() * 350;
    b.targetId = target.id;
    b.aimError = (Math.random() * 2 - 1) * (0.015 + targetD / 30000);
  } else {
    b.targetId = null;
  }

  // Recoger un arma si está encima de una mejor que la que tiene (o de la misma, por munición)
  const rank = p.primary ? WEAPON_RANK[p.primary.type] : 0;
  const under = nearestItem(p, world.items, S.isWeapon, S.PICKUP_R);
  if (under && (WEAPON_RANK[under.type] > rank || (p.primary && p.primary.type === under.type && p.primary.reserve < S.WEAPONS[under.type].reserve))) {
    world.tryPickup(p);
  }

  // Usar el arma principal mientras tenga balas
  const primaryHasAmmo = p.primary && (p.primary.mag > 0 || p.primary.reserve > 0);
  if (primaryHasAmmo && p.slot !== 'primary') world.switchSlot(p, 'primary', now);
  else if (!primaryHasAmmo && p.slot === 'primary') world.switchSlot(p, 'secondary', now);

  const w = world.currentWeapon(p);
  if (!target && w.mag < S.WEAPONS[w.type].mag / 2) world.startReload(p, now);

  if (!target && (!b.goal || now > b.goalUntil || Math.hypot(b.goal.x - p.x, b.goal.y - p.y) < 60)) {
    chooseGoal(p, b, now, world);
  }
}

function setMove(p, x, y) {
  const len = Math.hypot(x, y);
  const nx = len ? x / len : 0;
  const ny = len ? y / len : 0;
  p.input.left = nx < -0.38;
  p.input.right = nx > 0.38;
  p.input.up = ny < -0.38;
  p.input.down = ny > 0.38;
}

function updateBot(p, now, world) {
  const b = p.brain;
  if (now >= b.nextThink) {
    b.nextThink = now + THINK_MS;
    think(p, b, now, world);
  }

  const target = b.targetId ? world.players.get(b.targetId) : null;
  const weapon = world.currentWeapon(p);
  const def = S.WEAPONS[weapon.type];
  let mx = 0;
  let my = 0;

  if (now < b.unstickUntil) {
    mx = b.unstickDir.x;
    my = b.unstickDir.y;
  } else if (target && target.alive) {
    // Mantener la distancia ideal para su arma y moverse de costado para no ser un blanco fácil
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ideal = IDEAL_RANGE[weapon.type];
    const toward = dist > ideal + 80 ? 1 : dist < ideal - 80 ? -1 : 0;
    if (now >= b.strafeUntil) {
      b.strafe = Math.random() < 0.5 ? -1 : 1;
      b.strafeUntil = now + 600 + Math.random() * 900;
    }
    mx = (dx / dist) * toward - (dy / dist) * b.strafe * 0.8;
    my = (dy / dist) * toward + (dx / dist) * b.strafe * 0.8;
  } else if (b.goal) {
    mx = b.goal.x - p.x;
    my = b.goal.y - p.y;
  }
  setMove(p, mx, my);

  p.input.shoot = false;
  if (target && target.alive) {
    p.angle = Math.atan2(target.y - p.y, target.x - p.x) + b.aimError;
    if (now >= b.reactAt && weapon.mag > 0) {
      if (def.auto) {
        p.input.shoot = true;
      } else if (now >= b.nextClick) {
        p.pendingClick = true;
        p.clickAt = now;
        b.nextClick = now + def.rate + 80 + Math.random() * 220;
      }
    }
  } else if (mx || my) {
    p.angle = Math.atan2(my, mx);
  }

  // Si quiere moverse pero casi no avanzó, está trabado contra algo: probar otra dirección un rato
  if (now >= b.stuckCheckAt) {
    if (b.lastPos && (mx || my) && now >= b.unstickUntil && Math.hypot(p.x - b.lastPos.x, p.y - b.lastPos.y) < 25) {
      const a = Math.random() * Math.PI * 2;
      b.unstickDir = { x: Math.cos(a), y: Math.sin(a) };
      b.unstickUntil = now + 500 + Math.random() * 500;
      b.goal = null;
    }
    b.lastPos = { x: p.x, y: p.y };
    b.stuckCheckAt = now + 500;
  }
}

function idleBot(p) {
  setMove(p, 0, 0);
  p.input.shoot = false;
}

module.exports = { pickName, createBrain, updateBot, idleBot };
