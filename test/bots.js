'use strict';
/**
 * Bots de prueba: se conectan por WebSocket, deambulan, recogen armas y disparan al más cercano.
 * Sirven para probar el juego solo, o para llenar la partida en una demo.
 *
 *   node test/bots.js [cantidad] [url]
 *   node test/bots.js 4 ws://localhost:3000/ws
 */
const WebSocket = require('ws');

const COUNT = Number(process.argv[2]) || 3;
const URL = process.argv[3] || `ws://localhost:${process.env.PORT || 3000}/ws`;
const NAMES = ['Copito', 'Yeti', 'Pingüino', 'Escarcha', 'Témpano', 'Glaciar', 'Avalancha', 'Granizo'];

function startBot(i) {
  const ws = new WebSocket(URL);
  const name = `Bot ${NAMES[i % NAMES.length]}`;
  const bot = { me: null, snap: null, dir: { u: false, d: false, l: false, r: false }, clicks: 0 };

  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 's') return;
    bot.snap = m;
    bot.me = m.me;
  });
  ws.on('close', () => setTimeout(() => startBot(i), 2000));
  ws.on('error', () => {});

  // Cambia de dirección cada tanto
  setInterval(() => {
    bot.dir = { u: Math.random() < 0.4, d: Math.random() < 0.4, l: Math.random() < 0.4, r: Math.random() < 0.4 };
  }, 900 + Math.random() * 600);

  setInterval(() => {
    const { me, snap } = bot;
    if (ws.readyState !== WebSocket.OPEN || !me || !me.al || !snap) return;

    let target = null;
    let best = 700;
    for (const p of snap.p) {
      if (p.id === me.id || !p.al) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < best) {
        best = d;
        target = p;
      }
    }

    // Sin nadie a la vista, ir hacia el enemigo vivo más cercano para no quedarse dando vueltas solo
    let dir = bot.dir;
    if (!target) {
      let chase = null;
      let chaseD = Infinity;
      for (const p of snap.p) {
        if (p.id === me.id || !p.al) continue;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < chaseD) {
          chaseD = d;
          chase = p;
        }
      }
      if (chase && Math.random() < 0.7) {
        dir = { u: chase.y < me.y - 40, d: chase.y > me.y + 40, l: chase.x < me.x - 40, r: chase.x > me.x + 40 };
      }
    }

    const a = target ? Math.atan2(target.y - me.y, target.x - me.x) + (Math.random() - 0.5) * 0.15 : 0;
    const shoot = !!target && Math.random() < 0.6;
    if (shoot) bot.clicks++;
    ws.send(JSON.stringify({ t: 'i', ...dir, a, s: shoot, c: bot.clicks }));

    if (!me.pw && Math.random() < 0.3) ws.send(JSON.stringify({ t: 'pickup' }));
  }, 1000 / 15);
}

for (let i = 0; i < COUNT; i++) startBot(i);
console.log(`${COUNT} bots conectados a ${URL}`);
