/*
 * Código compartido entre el servidor (Node) y el cliente (navegador):
 * mapa, armas y colisiones. El servidor lo usa para simular y el cliente
 * para dibujar y predecir su propio movimiento con exactamente las mismas reglas.
 */
(function (root) {
  'use strict';

  const MAP = { w: 2400, h: 2400 };
  const PLAYER_R = 16;
  const SPEED = 230; // píxeles por segundo
  const PICKUP_R = 48;

  // k = tipo visual del obstáculo: ice (muro de hielo), crate (caja), rock (roca), tree (pino)
  const WALLS = [
    // Bordes del mapa
    { x: 0, y: 0, w: 2400, h: 40, k: 'ice' },
    { x: 0, y: 2360, w: 2400, h: 40, k: 'ice' },
    { x: 0, y: 0, w: 40, h: 2400, k: 'ice' },
    { x: 2360, y: 0, w: 40, h: 2400, k: 'ice' },

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

  // Lugares donde aparecen objetos en el piso (y reaparecen al rato de ser tomados)
  const ITEM_SPAWNS = [
    // Dentro del fuerte: el botín más jugoso
    { x: 1300, y: 1100, type: 'sniper' },
    { x: 1300, y: 1300, type: 'rifle' },
    { x: 1100, y: 1100, type: 'armor' },
    { x: 1100, y: 1300, type: 'medkit' },
    // Resto del mapa
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
