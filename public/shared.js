/*
 * Código compartido entre el servidor (Node) y el cliente (navegador):
 * mapa, armas y colisiones. El servidor lo usa para simular y el cliente
 * para dibujar y predecir su propio movimiento con exactamente las mismas reglas.
 */
(function (root) {
  'use strict';

  const MAP = { w: 4200, h: 4200 };
  const PLAYER_R = 16;
  const SPEED = 230; // píxeles por segundo
  const PICKUP_R = 48;

  // El diseño hecho a mano ocupa el centro del mapa (2400 × 2400); alrededor
  // se genera una zona exterior con cabañas, bosques, rocas y cajas.
  const CORE = 2400;
  const OFFSET = (MAP.w - CORE) / 2;

  // k = tipo visual del obstáculo: ice (muro de hielo), crate (caja), rock (roca), tree (pino), wood (pared de cabaña)
  const CORE_WALLS = [
    // Fuerte central (cuatro esquinas con entradas en cada lado)
    { x: 1000, y: 1000, w: 160, h: 30, k: 'ice' },
    { x: 1000, y: 1000, w: 30, h: 160, k: 'ice' },
    { x: 1240, y: 1000, w: 160, h: 30, k: 'ice' },
    { x: 1370, y: 1000, w: 30, h: 160, k: 'ice' },
    { x: 1000, y: 1370, w: 160, h: 30, k: 'ice' },
    { x: 1000, y: 1240, w: 30, h: 160, k: 'ice' },
    { x: 1240, y: 1370, w: 160, h: 30, k: 'ice' },
    { x: 1370, y: 1240, w: 30, h: 160, k: 'ice' },
    { x: 1170, y: 1170, w: 60, h: 60, k: 'crate' },

    // Muros largos
    { x: 300, y: 480, w: 560, h: 30, k: 'ice' },
    { x: 1540, y: 480, w: 560, h: 30, k: 'ice' },
    { x: 300, y: 1890, w: 560, h: 30, k: 'ice' },
    { x: 1540, y: 1890, w: 560, h: 30, k: 'ice' },
    { x: 480, y: 820, w: 30, h: 320, k: 'ice' },
    { x: 480, y: 1260, w: 30, h: 320, k: 'ice' },
    { x: 1890, y: 820, w: 30, h: 320, k: 'ice' },
    { x: 1890, y: 1260, w: 30, h: 320, k: 'ice' },

    // Esquinas en L
    { x: 700, y: 700, w: 200, h: 30, k: 'ice' },
    { x: 700, y: 700, w: 30, h: 200, k: 'ice' },
    { x: 1500, y: 700, w: 200, h: 30, k: 'ice' },
    { x: 1670, y: 700, w: 30, h: 200, k: 'ice' },
    { x: 700, y: 1670, w: 200, h: 30, k: 'ice' },
    { x: 700, y: 1500, w: 30, h: 200, k: 'ice' },
    { x: 1500, y: 1670, w: 200, h: 30, k: 'ice' },
    { x: 1670, y: 1500, w: 30, h: 200, k: 'ice' },

    // Cajas en las esquinas
    { x: 200, y: 200, w: 60, h: 60, k: 'crate' },
    { x: 260, y: 200, w: 60, h: 60, k: 'crate' },
    { x: 200, y: 260, w: 60, h: 60, k: 'crate' },
    { x: 2140, y: 200, w: 60, h: 60, k: 'crate' },
    { x: 2080, y: 200, w: 60, h: 60, k: 'crate' },
    { x: 2140, y: 260, w: 60, h: 60, k: 'crate' },
    { x: 200, y: 2140, w: 60, h: 60, k: 'crate' },
    { x: 260, y: 2140, w: 60, h: 60, k: 'crate' },
    { x: 200, y: 2080, w: 60, h: 60, k: 'crate' },
    { x: 2140, y: 2140, w: 60, h: 60, k: 'crate' },
    { x: 2080, y: 2140, w: 60, h: 60, k: 'crate' },
    { x: 2140, y: 2080, w: 60, h: 60, k: 'crate' },

    // Cajas sueltas
    { x: 1170, y: 250, w: 60, h: 60, k: 'crate' },
    { x: 1170, y: 2090, w: 60, h: 60, k: 'crate' },
    { x: 250, y: 1170, w: 60, h: 60, k: 'crate' },
    { x: 2090, y: 1170, w: 60, h: 60, k: 'crate' },
    { x: 900, y: 1150, w: 50, h: 50, k: 'crate' },
    { x: 1450, y: 1200, w: 50, h: 50, k: 'crate' },
    { x: 1150, y: 880, w: 50, h: 50, k: 'crate' },
    { x: 1200, y: 1460, w: 50, h: 50, k: 'crate' },

    // Rocas
    { x: 600, y: 300, w: 90, h: 70, k: 'rock' },
    { x: 1700, y: 2050, w: 90, h: 70, k: 'rock' },
    { x: 2000, y: 600, w: 70, h: 90, k: 'rock' },
    { x: 330, y: 1700, w: 70, h: 90, k: 'rock' },

    // Pinos
    { x: 1000, y: 300, w: 40, h: 40, k: 'tree' },
    { x: 1360, y: 2060, w: 40, h: 40, k: 'tree' },
    { x: 300, y: 1000, w: 40, h: 40, k: 'tree' },
    { x: 2060, y: 1360, w: 40, h: 40, k: 'tree' },
    { x: 820, y: 2000, w: 40, h: 40, k: 'tree' },
    { x: 1540, y: 360, w: 40, h: 40, k: 'tree' },
  ];

  const CORE_ITEMS = [
    // Dentro del fuerte: el botín más jugoso
    { x: 1300, y: 1100, type: 'sniper' },
    { x: 1300, y: 1300, type: 'rifle' },
    { x: 1100, y: 1100, type: 'armor' },
    { x: 1100, y: 1300, type: 'medkit' },
    // Resto del centro
    { x: 600, y: 600, type: 'rifle' },
    { x: 1800, y: 1800, type: 'rifle' },
    { x: 1800, y: 600, type: 'smg' },
    { x: 600, y: 1800, type: 'smg' },
    { x: 1500, y: 900, type: 'smg' },
    { x: 1200, y: 600, type: 'shotgun' },
    { x: 1200, y: 1800, type: 'shotgun' },
    { x: 600, y: 1200, type: 'shotgun' },
    { x: 1800, y: 1200, type: 'shotgun' },
    { x: 2000, y: 2000, type: 'sniper' },
    { x: 400, y: 400, type: 'smg' },
    { x: 350, y: 1200, type: 'medkit' },
    { x: 2050, y: 1200, type: 'medkit' },
    { x: 1200, y: 380, type: 'medkit' },
    { x: 1200, y: 2020, type: 'medkit' },
    { x: 900, y: 900, type: 'armor' },
    { x: 1500, y: 1500, type: 'armor' },
  ];

  const WALLS = [
    // Bordes del mapa
    { x: 0, y: 0, w: MAP.w, h: 40, k: 'ice' },
    { x: 0, y: MAP.h - 40, w: MAP.w, h: 40, k: 'ice' },
    { x: 0, y: 0, w: 40, h: MAP.h, k: 'ice' },
    { x: MAP.w - 40, y: 0, w: 40, h: MAP.h, k: 'ice' },
    ...CORE_WALLS.map((w) => ({ ...w, x: w.x + OFFSET, y: w.y + OFFSET })),
  ];

  // Lugares donde aparecen objetos en el piso (y reaparecen al rato de ser tomados)
  const ITEM_SPAWNS = CORE_ITEMS.map((it) => ({ ...it, x: it.x + OFFSET, y: it.y + OFFSET }));

  // ---------------------------------------------------------------- Zona exterior generada
  // Se usa un generador pseudoaleatorio con semilla fija: servidor y cliente
  // construyen exactamente el mismo mapa sin tener que enviarlo por la red.

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(20261102);
  const between = (a, b) => a + rand() * (b - a);
  const pick = (list) => list[Math.floor(rand() * list.length)];

  // Una cabaña de madera de 220 × 170 con una puerta en un lado al azar
  function cabin(x, y) {
    const W = 220, H = 170, t = 22, door = 70;
    const side = Math.floor(rand() * 4);
    const parts = [];
    const hWall = (yy, withDoor) => {
      if (!withDoor) return parts.push({ x, y: yy, w: W, h: t });
      const seg = (W - door) / 2;
      parts.push({ x, y: yy, w: seg, h: t }, { x: x + W - seg, y: yy, w: seg, h: t });
    };
    const vWall = (xx, withDoor) => {
      if (!withDoor) return parts.push({ x: xx, y, w: t, h: H });
      const seg = (H - door) / 2;
      parts.push({ x: xx, y, w: t, h: seg }, { x: xx, y: y + H - seg, w: t, h: seg });
    };
    hWall(y, side === 0);
    hWall(y + H - t, side === 1);
    vWall(x, side === 2);
    vWall(x + W - t, side === 3);
    return { w: W, h: H, parts: parts.map((p) => ({ ...p, k: 'wood' })), loot: { x: x + W / 2, y: y + H / 2 } };
  }

  function crates(x, y) {
    const layouts = [
      [[0, 0], [60, 0], [0, 60]],
      [[0, 0], [60, 0]],
      [[0, 0], [0, 60], [60, 60]],
      [[0, 0], [60, 0], [120, 0]],
    ];
    const parts = pick(layouts).map(([dx, dy]) => ({ x: x + dx, y: y + dy, w: 60, h: 60, k: 'crate' }));
    return { w: 180, h: 120, parts };
  }

  function grove(x, y) {
    const parts = [];
    const n = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      parts.push({ x: x + Math.floor(rand() * 4) * 70, y: y + Math.floor(rand() * 3) * 80, w: 40, h: 40, k: 'tree' });
    }
    return { w: 250, h: 200, parts };
  }

  function rock(x, y) {
    const w = Math.round(between(70, 120));
    const h = Math.round(between(60, 100));
    return { w, h, parts: [{ x, y, w, h, k: 'rock' }] };
  }

  function iceWall(x, y) {
    const long = Math.round(between(220, 420));
    const horizontal = rand() < 0.5;
    const w = horizontal ? long : 30;
    const h = horizontal ? 30 : long;
    return { w, h, parts: [{ x, y, w, h, k: 'ice' }] };
  }

  const inCore = (x, y, w, h, pad) =>
    x < OFFSET + CORE + pad && x + w > OFFSET - pad && y < OFFSET + CORE + pad && y + h > OFFSET - pad;

  const overlapsWall = (x, y, w, h, pad) =>
    WALLS.some((o) => x < o.x + o.w + pad && x + w + pad > o.x && y < o.y + o.h + pad && y + h + pad > o.y);

  // Pide un lugar libre en la zona exterior y coloca la estructura ahí
  function scatter(count, build) {
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 60; tries++) {
      const x = Math.round(between(90, MAP.w - 90));
      const y = Math.round(between(90, MAP.h - 90));
      const s = build(x, y);
      if (x + s.w > MAP.w - 90 || y + s.h > MAP.h - 90) continue;
      if (inCore(x, y, s.w, s.h, 60) || overlapsWall(x, y, s.w, s.h, 70)) continue;
      WALLS.push(...s.parts);
      if (s.loot) ITEM_SPAWNS.push({ ...s.loot, type: pick(['rifle', 'rifle', 'smg', 'shotgun', 'sniper', 'armor']) });
      placed++;
    }
  }

  scatter(10, cabin);
  scatter(12, grove);
  scatter(14, crates);
  scatter(16, rock);
  scatter(16, iceWall);

  // Objetos sueltos por la zona exterior
  const LOOSE_LOOT = ['smg', 'smg', 'rifle', 'shotgun', 'shotgun', 'medkit', 'medkit', 'medkit', 'armor'];
  for (let placed = 0, tries = 0; placed < 22 && tries < 2000; tries++) {
    const x = Math.round(between(120, MAP.w - 120));
    const y = Math.round(between(120, MAP.h - 120));
    if (inCore(x, y, 0, 0, 40) || overlapsWall(x - 30, y - 30, 60, 60, 20)) continue;
    if (ITEM_SPAWNS.some((it) => Math.hypot(it.x - x, it.y - y) < 300)) continue;
    ITEM_SPAWNS.push({ x, y, type: pick(LOOSE_LOOT) });
    placed++;
  }

  // ---------------------------------------------------------------- Armas

  // rate = ms entre disparos, spread = desvío máximo en radianes, speed = multiplicador de velocidad al llevarla
  const WEAPONS = {
    pistol:  { name: 'Pistola',       dmg: 20,  rate: 280,  mag: 12, reserve: 0,  infinite: true, spread: 0.035, range: 900,  pellets: 1, reload: 1200, auto: false, speed: 1.0,  len: 14 },
    smg:     { name: 'Subfusil',      dmg: 15,  rate: 75,   mag: 30, reserve: 90, spread: 0.085, range: 750,  pellets: 1, reload: 1800, auto: true,  speed: 0.97, len: 22 },
    rifle:   { name: 'Rifle',         dmg: 26,  rate: 115,  mag: 30, reserve: 60, spread: 0.035, range: 1400, pellets: 1, reload: 2200, auto: true,  speed: 0.92, len: 32 },
    shotgun: { name: 'Escopeta',      dmg: 14,  rate: 850,  mag: 6,  reserve: 18, spread: 0.2,   range: 480,  pellets: 8, reload: 2500, auto: false, speed: 0.92, len: 28 },
    sniper:  { name: 'Francotirador', dmg: 105, rate: 1400, mag: 5,  reserve: 10, spread: 0.003, range: 2600, pellets: 1, reload: 2800, auto: false, speed: 0.85, len: 42 },
  };

  const ITEM_NAMES = { medkit: 'Botiquín', armor: 'Chaleco' };

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function isWeapon(type) {
    return Object.prototype.hasOwnProperty.call(WEAPONS, type);
  }

  function circleHitsWall(x, y, r) {
    for (const w of WALLS) {
      const cx = clamp(x, w.x, w.x + w.w);
      const cy = clamp(y, w.y, w.y + w.h);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  // Empuja un círculo {x, y} fuera de cualquier obstáculo que esté tocando.
  function resolveCircle(o, r) {
    for (const w of WALLS) {
      const cx = clamp(o.x, w.x, w.x + w.w);
      const cy = clamp(o.y, w.y, w.y + w.h);
      const dx = o.x - cx;
      const dy = o.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        o.x = cx + (dx / d) * r;
        o.y = cy + (dy / d) * r;
      } else {
        // El centro quedó dentro del rectángulo: salir por el lado más cercano
        const left = o.x - w.x;
        const right = w.x + w.w - o.x;
        const top = o.y - w.y;
        const bottom = w.y + w.h - o.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) o.x = w.x - r;
        else if (m === right) o.x = w.x + w.w + r;
        else if (m === top) o.y = w.y - r;
        else o.y = w.y + w.h + r;
      }
    }
  }

  function moveCircle(o, mx, my, r) {
    o.x += mx;
    o.y += my;
    resolveCircle(o, r);
    resolveCircle(o, r);
    o.x = clamp(o.x, r, MAP.w - r);
    o.y = clamp(o.y, r, MAP.h - r);
  }

  const api = {
    MAP, PLAYER_R, SPEED, PICKUP_R, WALLS, ITEM_SPAWNS, WEAPONS, ITEM_NAMES,
    clamp, isWeapon, circleHitsWall, resolveCircle, moveCircle,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shared = api;
})(typeof window !== 'undefined' ? window : globalThis);
