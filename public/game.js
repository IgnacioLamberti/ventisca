/*
 * Cliente de Ventisca.
 *   - WebSocket: envía los inputs (30/s) y recibe el estado del mundo (30/s).
 *   - SSE (EventSource): recibe killfeed, chat, anuncios, partidas, tabla y estadísticas.
 *   - Canvas 2D: dibuja el mundo; el HUD es HTML.
 */
(() => {
  'use strict';

  const S = window.Shared;
  const $ = (id) => document.getElementById(id);
  const clamp = S.clamp;

  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1, zoom = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------ Estado

  let ws = null;
  let myId = null;
  let joinName = null;     // nombre con el que entramos (para re-entrar si se corta el WS)
  let joined = false;
  let snap = null;         // último snapshot del servidor
  let me = null;           // mi estado según el servidor
  let serverOffset = 0;    // reloj del servidor − reloj local
  let ping = null;
  let spectateId = null;
  let chatOpen = false;
  let relativeMove = true; // W/S/A/D relativos a la mira (se cambia con V)
  let scoreboardData = [];
  let hitMarkerUntil = 0;
  let hurtUntil = 0;

  const others = new Map();   // id → jugador con posición interpolada
  const local = { x: S.MAP.w / 2, y: S.MAP.h / 2, a: 0, alive: false, print: null, side: 1 };
  const camera = { x: S.MAP.w / 2, y: S.MAP.h / 2 };
  const keys = Object.create(null);
  const mouse = { x: 0, y: 0, down: false };
  let clicks = 0;

  const tracers = [];
  const particles = [];
  const footprints = [];

  const serverNow = () => Date.now() + serverOffset;
  const weaponName = (type) => (S.WEAPONS[type] ? S.WEAPONS[type].name : type);

  function myWeapon() {
    if (!me) return null;
    return me.slot === 'primary' && me.pw ? me.pw : me.sw;
  }

  function myWeaponType() {
    const w = myWeapon();
    return w ? w.type : 'pistol';
  }

  // ------------------------------------------------------------ WebSocket

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      setDot('ws', true);
      if (joinName) send({ t: 'join', name: joinName });
    };
    ws.onclose = () => {
      setDot('ws', false);
      myId = null;
      me = null;
      setTimeout(connectWS, 1500);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 's') onSnapshot(m);
      else if (m.t === 'welcome') myId = m.id;
      else if (m.t === 'full') onFull(m.max);
      else if (m.t === 'pong') ping = Date.now() - m.ts;
    };
  }

  setInterval(() => send({ t: 'ping', ts: Date.now() }), 2000);

  function movementKeys() {
    if (chatOpen) return { u: false, d: false, l: false, r: false };
    return {
      u: !!(keys.KeyW || keys.ArrowUp),
      d: !!(keys.KeyS || keys.ArrowDown),
      l: !!(keys.KeyA || keys.ArrowLeft),
      r: !!(keys.KeyD || keys.ArrowRight),
    };
  }

  function sendInput() {
    if (!joined) return;
    const m = movementKeys();
    send({ t: 'i', ...m, rel: relativeMove, a: Math.round(local.a * 1000) / 1000, s: mouse.down && !chatOpen, c: clicks });
  }
  setInterval(sendInput, 1000 / 30);

  function onSnapshot(m) {
    serverOffset = m.now - Date.now();
    const prevMe = me;
    snap = m;
    me = m.me;

    const seen = new Set();
    for (const p of m.p) {
      seen.add(p.id);
      let o = others.get(p.id);
      if (!o) {
        o = { ...p, dx: p.x, dy: p.y, da: p.a, print: { x: p.x, y: p.y }, side: 1 };
        others.set(p.id, o);
      }
      if (o.al && !p.al) burst(o.dx, o.dy, o.c, 22);
      // Teletransporte (respawn): no interpolar a través del mapa
      if ((!o.al && p.al) || Math.hypot(p.x - o.dx, p.y - o.dy) > 250) {
        o.dx = p.x;
        o.dy = p.y;
        o.print = { x: p.x, y: p.y };
      }
      Object.assign(o, p);
    }
    for (const id of others.keys()) if (!seen.has(id)) others.delete(id);

    if (me) {
      if (me.al) {
        const ex = me.x - local.x;
        const ey = me.y - local.y;
        const err = Math.hypot(ex, ey);
        const mk = movementKeys();
        const moving = mk.u || mk.d || mk.l || mk.r;
        if (!local.alive || err > 60) {
          local.x = me.x;
          local.y = me.y;
          local.print = { x: me.x, y: me.y };
        } else if (!moving) {
          local.x += ex * 0.3;
          local.y += ey * 0.3;
        } else if (err > 16) {
          local.x += ex * 0.1;
          local.y += ey * 0.1;
        }
      }
      local.alive = !!me.al;
      for (const ev of me.ev) {
        if (ev === 'hit' || ev === 'kill') hitMarkerUntil = performance.now() + (ev === 'kill' ? 350 : 140);
        if (ev === 'hurt') hurtUntil = performance.now() + 300;
      }
      if (prevMe && prevMe.al && !me.al) spectateId = null;
    } else {
      local.alive = false;
    }

    const now = performance.now();
    const played = new Set();
    for (const s of m.sh) {
      const [x1, y1, x2, y2, hit, type] = s;
      tracers.push({ x1, y1, x2, y2, t: now, type });
      if (hit) burst(x2, y2, '#d33', 5, 90);
      else puff(x2, y2);
      const key = x1 + ',' + y1;
      if (!played.has(key)) {
        played.add(key);
        playShot(x1, y1, type);
      }
    }

    updateHud();
  }

  // ------------------------------------------------------------ SSE

  function connectSSE() {
    const es = new EventSource('/events');
    es.onopen = () => setDot('sse', true);
    es.onerror = () => setDot('sse', false); // EventSource reintenta solo
    es.addEventListener('kill', (e) => onKill(JSON.parse(e.data)));
    es.addEventListener('chat', (e) => {
      const d = JSON.parse(e.data);
      addChat(d.name, d.color, d.text);
      addLobbyFeed(`${d.name}: ${d.text}`);
    });
    es.addEventListener('announce', (e) => {
      const d = JSON.parse(e.data);
      addChat(null, null, d.text);
      addLobbyFeed(d.text);
    });
    es.addEventListener('round', (e) => onRound(JSON.parse(e.data)));
    es.addEventListener('scoreboard', (e) => {
      scoreboardData = JSON.parse(e.data);
      renderScoreboard();
    });
    es.addEventListener('stats', (e) => {
      const d = JSON.parse(e.data);
      $('lobby-stats').textContent = `${d.humans}/${d.maxPlayers} personas · ${d.bots} bots · ${d.online} conectados por WS · ${d.sseClients} escuchando SSE`;
    });
  }

  function onKill(d) {
    const el = document.createElement('div');
    el.className = 'kill';
    const myName = joinName;
    if (myName && (d.killer === myName || d.victim === myName)) el.classList.add('mine');
    if (d.killer && d.killer !== d.victim) {
      el.append(colored(d.killer, d.kc));
      const w = document.createElement('span');
      w.className = 'wpn';
      w.textContent = `[${weaponName(d.weapon)}]`;
      el.append(w);
    }
    el.append(colored(d.victim, d.vc));
    const feed = $('killfeed');
    feed.append(el);
    while (feed.children.length > 6) feed.firstChild.remove();
    setTimeout(() => el.remove(), 7000);
    addLobbyFeed(d.killer ? `${d.killer} eliminó a ${d.victim} (${weaponName(d.weapon)})` : `${d.victim} murió`);
  }

  function onRound(d) {
    if (d.state === 'countdown') showBanner('La partida empieza en 5 segundos', 2500);
    else if (d.state === 'playing') showBanner(`Deathmatch · primero a ${d.killLimit} bajas`, 3000);
    else if (d.state === 'ended') showBanner(d.winner ? `🏆 ${d.winner} ganó con ${d.winnerKills} bajas` : 'Nadie hizo bajas', 6000);
  }

  function colored(text, color) {
    const s = document.createElement('span');
    s.textContent = text;
    if (color) s.style.color = color;
    return s;
  }

  let bannerTimer = 0;
  function showBanner(text, ms) {
    const b = $('banner');
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  function addChat(name, color, text) {
    const log = $('chat-log');
    const line = document.createElement('div');
    if (name) {
      const n = colored(name + ': ', color);
      n.style.fontWeight = '700';
      line.append(n, document.createTextNode(text));
    } else {
      line.className = 'sys';
      line.textContent = text;
    }
    log.append(line);
    while (log.children.length > 8) log.firstChild.remove();
    setTimeout(() => line.classList.add('old'), 8000);
  }

  function addLobbyFeed(text) {
    const feed = $('lobby-feed');
    const line = document.createElement('div');
    line.textContent = text;
    feed.prepend(line);
    while (feed.children.length > 6) feed.lastChild.remove();
  }

  function renderScoreboard() {
    const body = $('score-body');
    body.replaceChildren();
    scoreboardData.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (p.id === myId) tr.className = 'me';
      const nameTd = document.createElement('td');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = p.color;
      nameTd.append(sw, document.createTextNode(p.name));
      if (p.bot) nameTd.append(botTag());
      const cells = [i + 1, null, p.kills, p.deaths, p.wins, p.alive ? 'Vivo' : '💀'];
      cells.forEach((c, idx) => {
        if (idx === 1) return tr.append(nameTd);
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      });
      body.append(tr);
    });

    const top = $('lobby-top');
    top.replaceChildren();
    for (const p of scoreboardData.slice(0, 5)) {
      const li = document.createElement('li');
      li.append(colored(p.name, p.color), document.createTextNode(` — ${p.wins} victorias, ${p.kills} bajas`));
      top.append(li);
    }
  }

  function setDot(which, on) {
    $(which + '-dot').classList.toggle('on', on);
  }

  // ------------------------------------------------------------ HUD

  function updateHud() {
    if (!joined || !snap) return;
    const now = serverNow();
    let label = '';
    let sub = '';
    switch (snap.st) {
      case 'warmup':
        label = 'Calentamiento';
        sub = `Esperando jugadores (${snap.p.length}/2) · reaparecés al morir`;
        break;
      case 'countdown':
        label = `La partida empieza en ${Math.max(0, Math.ceil((snap.te - now) / 1000))}`;
        sub = 'Agarrá un arma';
        break;
      case 'playing': {
        const left = Math.max(0, Math.ceil((snap.te - now) / 1000));
        label = `Partida ${snap.rn} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        const top = snap.p.reduce((a, b) => (b.k > a.k || (b.k === a.k && b.d < a.d) ? b : a), snap.p[0]);
        const mine = snap.p.find((p) => p.id === myId);
        sub = `Primero a ${snap.kl} bajas`;
        if (top && top.k > 0) sub += ` · Líder: ${top.n} (${top.k})`;
        if (mine) sub += ` · Vos: ${mine.k}/${mine.d}`;
        break;
      }
      case 'ended':
        label = 'Fin de la partida';
        sub = `Próxima en ${Math.max(0, Math.ceil((snap.te - now) / 1000))} s`;
        break;
    }
    $('round-label').textContent = label;
    $('round-sub').textContent = sub;

    if (!me) return;

    $('vitals').classList.toggle('hidden', !me.al);
    $('weapon-box').classList.toggle('hidden', !me.al);
    $('hp-fill').style.width = me.hp + '%';
    $('hp-text').textContent = me.hp;
    $('armor-fill').style.width = me.ar + '%';
    $('armor-text').textContent = me.ar;

    const w = myWeapon();
    if (w) {
      const def = S.WEAPONS[w.type];
      $('weapon-name').textContent = def.name;
      $('ammo-mag').textContent = w.mag;
      $('ammo-mag').classList.toggle('low', w.mag <= Math.ceil(def.mag * 0.25));
      $('ammo-res').textContent = '/ ' + (def.infinite ? '∞' : w.reserve);
      const reloading = me.rl > 0;
      $('reload').classList.toggle('hidden', !reloading);
      if (reloading) $('reload-fill').style.width = clamp(100 - ((me.rl - now) / def.reload) * 100, 0, 100) + '%';
    }
    $('slot-1').querySelector('span').textContent = me.pw ? S.WEAPONS[me.pw.type].name : '—';
    $('slot-1').classList.toggle('active', me.slot === 'primary' && !!me.pw);
    $('slot-2').classList.toggle('active', me.slot !== 'primary' || !me.pw);

    // Arma cercana
    const near = me.al ? nearestWeaponItem() : null;
    $('hint').classList.toggle('hidden', !near);
    if (near) $('hint').textContent = `E — recoger ${S.WEAPONS[near.k].name}`;

    // Muerte
    const death = $('death');
    if (me.al) {
      death.classList.add('hidden');
    } else {
      death.classList.remove('hidden');
      const target = spectateTarget();
      const watching = target ? `Espectando a ${target.n} · Espacio para cambiar` : '';
      death.innerHTML = '<strong>Eliminado</strong>';
      if (me.kb) death.append(`Te eliminó ${me.kb}`, document.createElement('br'));
      if (snap.st === 'ended') death.append('Esperando la próxima partida', document.createElement('br'));
      else if (me.ra > 0) death.append(`Reaparecés en ${Math.max(0, Math.ceil((me.ra - now) / 1000))} s`, document.createElement('br'));
      if (watching) death.append(watching);
    }
  }

  function nearestWeaponItem() {
    if (!snap) return null;
    let best = null;
    let bestD = S.PICKUP_R;
    for (const it of snap.i) {
      if (!S.isWeapon(it.k)) continue;
      const d = Math.hypot(it.x - local.x, it.y - local.y);
      if (d <= bestD) {
        best = it;
        bestD = d;
      }
    }
    return best;
  }

  function spectateTarget() {
    const alive = [...others.values()].filter((o) => o.al && o.id !== myId);
    if (!alive.length) return null;
    let t = alive.find((o) => o.id === spectateId);
    if (!t) {
      t = alive[0];
      spectateId = t.id;
    }
    return t;
  }

  function cycleSpectate() {
    const alive = [...others.values()].filter((o) => o.al && o.id !== myId);
    if (!alive.length) return;
    const idx = alive.findIndex((o) => o.id === spectateId);
    spectateId = alive[(idx + 1) % alive.length].id;
  }

  // ------------------------------------------------------------ Entrada

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('name-input').value.trim().slice(0, 16);
    if (!name) return;
    joinName = name;
    try { localStorage.setItem('ventisca-name', name); } catch {}
    send({ t: 'join', name });
    $('join-error').classList.add('hidden');
    joined = true;
    document.body.classList.add('playing');
    $('lobby').classList.add('hidden');
    $('hud').classList.remove('hidden');
    initAudio();
    canvas.focus();
  });

  try { $('name-input').value = localStorage.getItem('ventisca-name') || ''; } catch {}

  function setRelativeMove(on) {
    relativeMove = on;
    try { localStorage.setItem('ventisca-relative', on ? '1' : '0'); } catch {}
    $('move-mode').textContent = on ? 'Movimiento: relativo a la mira · V para cambiar' : 'Movimiento: clásico · V para cambiar';
  }
  let savedMode = null;
  try { savedMode = localStorage.getItem('ventisca-relative'); } catch {}
  setRelativeMove(savedMode !== '0');

  // El servidor rechazó la entrada porque ya hay MAX_PLAYERS personas: volver al lobby
  function onFull(max) {
    joined = false;
    joinName = null;
    document.body.classList.remove('playing');
    $('hud').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    $('join-error').textContent = `La partida está llena (${max} de ${max} personas). Probá en un rato.`;
    $('join-error').classList.remove('hidden');
  }

  function botTag() {
    const tag = document.createElement('span');
    tag.className = 'bot-tag';
    tag.textContent = 'BOT';
    return tag;
  }

  function openChat() {
    chatOpen = true;
    mouse.down = false;
    $('chat').classList.add('open');
    $('chat-input').focus();
  }

  function closeChat() {
    chatOpen = false;
    $('chat').classList.remove('open');
    $('chat-input').value = '';
    $('chat-input').blur();
    canvas.focus();
  }

  $('chat-input').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = e.target.value.trim();
      if (text) send({ t: 'chat', text });
      closeChat();
    } else if (e.key === 'Escape') {
      closeChat();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!joined || chatOpen) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      $('scoreboard').classList.remove('hidden');
      return;
    }
    if (e.code === 'Enter' || e.code === 'KeyT') {
      e.preventDefault();
      openChat();
      return;
    }
    keys[e.code] = true;
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyE': send({ t: 'pickup' }); break;
      case 'KeyR': send({ t: 'reload' }); break;
      case 'KeyG': send({ t: 'drop' }); break;
      case 'KeyV': setRelativeMove(!relativeMove); break;
      case 'Digit1': send({ t: 'slot', s: 'primary' }); break;
      case 'Digit2': send({ t: 'slot', s: 'secondary' }); break;
      case 'KeyQ': send({ t: 'slot', s: 'toggle' }); break;
      case 'Space': e.preventDefault(); if (me && !me.al) cycleSpectate(); break;
    }
  });

  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
  });

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    mouse.down = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !joined) return;
    if (chatOpen) closeChat();
    mouse.down = true;
    clicks++;
    sendInput(); // enviar ya: no esperar al próximo intervalo
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.down = false;
  });
  canvas.addEventListener('wheel', (e) => {
    if (joined) send({ t: 'slot', s: 'toggle' });
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------ Sonido (generado, sin archivos)

  let actx = null;
  let noiseBuf = null;

  function initAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      actx.resume();
      if (!noiseBuf) {
        const len = Math.floor(actx.sampleRate * 0.4);
        noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
    } catch {
      actx = null;
    }
  }

  const SHOT_SOUND = {
    pistol: { f: 2400, d: 0.12 }, smg: { f: 2800, d: 0.09 }, rifle: { f: 1800, d: 0.14 },
    shotgun: { f: 900, d: 0.3 }, sniper: { f: 1100, d: 0.4 },
  };

  function playShot(x, y, type) {
    if (!actx || !noiseBuf) return;
    const dist = Math.hypot(x - camera.x, y - camera.y);
    const vol = clamp(1 - dist / 1500, 0, 1) * 0.25;
    if (vol < 0.01) return;
    const cfg = SHOT_SOUND[type] || SHOT_SOUND.pistol;
    const src = actx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = actx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cfg.f;
    const gain = actx.createGain();
    const t = actx.currentTime;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + cfg.d);
    src.connect(filter).connect(gain).connect(actx.destination);
    src.start(t);
    src.stop(t + cfg.d);
  }

  // ------------------------------------------------------------ Efectos

  function burst(x, y, color, n, speed = 160) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random());
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.4 + Math.random() * 0.4, c: color, r: 2 + Math.random() * 2.5 });
    }
  }

  function puff(x, y) {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 40 + Math.random() * 60;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.5, c: '#ffffff', r: 2 + Math.random() * 3 });
    }
  }

  function leaveFootprint(o, x, y) {
    if (!o.print) o.print = { x, y };
    const dx = x - o.print.x;
    const dy = y - o.print.y;
    if (dx * dx + dy * dy < 26 * 26) return;
    const a = Math.atan2(dy, dx);
    o.side = -o.side;
    footprints.push({ x: x + Math.cos(a + Math.PI / 2) * 6 * o.side, y: y + Math.sin(a + Math.PI / 2) * 6 * o.side, a, t: performance.now() });
    o.print = { x, y };
    if (footprints.length > 900) footprints.splice(0, footprints.length - 900);
  }

  // Copos de nieve en coordenadas de pantalla (con un poco de paralaje)
  const flakes = [];
  function newFlake(anywhere) {
    return {
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : -10,
      r: 0.6 + Math.random() * 2.2,
      vy: 25 + Math.random() * 55,
      vx: -12 + Math.random() * 24,
      depth: 0.2 + Math.random() * 0.6,
    };
  }
  for (let i = 0; i < 160; i++) flakes.push(newFlake(true));

  // Textura de nieve
  const snowPattern = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#eef4f9';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * 256, y = Math.random() * 256, r = 30 + Math.random() * 50;
      // Se dibuja también desplazado ±256 para que la textura no tenga costuras al repetirse
      for (const ox of [-256, 0, 256]) {
        for (const oy of [-256, 0, 256]) {
          const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          grad.addColorStop(0, 'rgba(214,228,240,0.45)');
          grad.addColorStop(1, 'rgba(214,228,240,0)');
          g.fillStyle = grad;
          g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
      }
    }
    for (let i = 0; i < 380; i++) {
      g.fillStyle = Math.random() < 0.7 ? 'rgba(170,192,214,0.35)' : 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(Math.random() * 256, Math.random() * 256, 0.5 + Math.random() * 1.4, 0, Math.PI * 2);
      g.fill();
    }
    return ctx.createPattern(c, 'repeat');
  })();

  // ------------------------------------------------------------ Bucle de juego

  let last = performance.now();
  const prevCam = { x: camera.x, y: camera.y };

  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    update(dt, t);
    draw(t);
    requestAnimationFrame(frame);
  }

  function update(dt, t) {
    zoom = clamp(Math.min(W, H) / 820, 0.55, 1.25) * (myWeaponType() === 'sniper' && local.alive ? 0.75 : 1);

    // Predicción local: me muevo ya y el servidor me corrige si hace falta
    if (joined && me && me.al) {
      // Primero la mira (el movimiento relativo depende de hacia dónde apunto).
      // Con la mira casi encima del personaje el ángulo no es estable: se mantiene el anterior.
      const wx = camera.x + (mouse.x - W / 2) / zoom;
      const wy = camera.y + (mouse.y - H / 2) / zoom;
      if (Math.hypot(wx - local.x, wy - local.y) > S.PLAYER_R * 1.5) local.a = Math.atan2(wy - local.y, wx - local.x);

      const m = movementKeys();
      const dir = S.moveDirection({ up: m.u, down: m.d, left: m.l, right: m.r }, local.a, relativeMove);
      if (dir.x !== 0 || dir.y !== 0) {
        const speed = S.SPEED * S.WEAPONS[myWeaponType()].speed * dt;
        S.moveCircle(local, dir.x * speed, dir.y * speed, S.PLAYER_R);
      }
      leaveFootprint(local, local.x, local.y);
    }

    // Interpolación de los demás jugadores
    const f = 1 - Math.exp(-dt * 16);
    for (const o of others.values()) {
      if (o.id === myId) continue;
      o.dx += (o.x - o.dx) * f;
      o.dy += (o.y - o.dy) * f;
      let da = o.a - o.da;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      o.da += da * f;
      if (o.al) leaveFootprint(o, o.dx, o.dy);
    }

    // Cámara
    let tx = S.MAP.w / 2;
    let ty = S.MAP.h / 2;
    if (joined && me && me.al) {
      tx = local.x + clamp((mouse.x - W / 2) / zoom, -400, 400) * 0.18;
      ty = local.y + clamp((mouse.y - H / 2) / zoom, -400, 400) * 0.18;
    } else if (joined && me) {
      const target = spectateTarget();
      if (target) {
        tx = target.dx;
        ty = target.dy;
      }
    } else {
      // En el lobby la cámara pasea lentamente por el mapa
      tx = S.MAP.w / 2 + Math.cos(t / 9000) * S.MAP.w * 0.3;
      ty = S.MAP.h / 2 + Math.sin(t / 11000) * S.MAP.h * 0.3;
    }
    const cf = 1 - Math.exp(-dt * 10);
    camera.x += (tx - camera.x) * cf;
    camera.y += (ty - camera.y) * cf;

    // Partículas
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      if (p.life >= p.max) particles.splice(i, 1);
    }

    // Copos
    const cdx = (camera.x - prevCam.x) * zoom;
    const cdy = (camera.y - prevCam.y) * zoom;
    prevCam.x = camera.x;
    prevCam.y = camera.y;
    const wind = Math.sin(t / 3000) * 20;
    for (const fl of flakes) {
      fl.x += (fl.vx + wind) * dt - cdx * fl.depth;
      fl.y += fl.vy * dt - cdy * fl.depth;
      if (fl.y > H + 10) Object.assign(fl, newFlake(false));
      if (fl.y < -12) fl.y = H + 8;
      if (fl.x < -10) fl.x += W + 20;
      if (fl.x > W + 10) fl.x -= W + 20;
    }
  }

  // ------------------------------------------------------------ Dibujo

  function draw(t) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const vw = W / zoom;
    const vh = H / zoom;
    const view = { x0: camera.x - vw / 2, y0: camera.y - vh / 2, x1: camera.x + vw / 2, y1: camera.y + vh / 2 };
    const inView = (x, y, m) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camera.x, -camera.y);

    // Suelo
    ctx.fillStyle = '#b4c4d4';
    ctx.fillRect(view.x0, view.y0, vw, vh);
    ctx.fillStyle = snowPattern;
    ctx.fillRect(0, 0, S.MAP.w, S.MAP.h);

    drawFootprints(t, inView);
    drawWalls(inView, false);
    drawItems(t, inView);
    drawPlayers(inView);
    drawWalls(inView, true); // copas de los pinos por encima de los jugadores
    drawTracers(t);
    drawParticles();

    ctx.restore();

    drawSnow();
    if (joined) {
      drawMinimap();
      if (me && me.al) drawCrosshair(t);
    }
    if (performance.now() < hurtUntil) {
      const k = (hurtUntil - performance.now()) / 300;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(200,30,40,0)');
      g.addColorStop(1, `rgba(200,30,40,${0.45 * k})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    $('ping').textContent = ping == null ? '— ms' : `${ping} ms`;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawFootprints(t, inView) {
    const now = performance.now();
    let cut = 0;
    while (cut < footprints.length && now - footprints[cut].t > 9000) cut++;
    if (cut) footprints.splice(0, cut);
    ctx.fillStyle = '#8fa8c0';
    for (const fp of footprints) {
      if (!inView(fp.x, fp.y, 10)) continue;
      ctx.globalAlpha = 0.35 * (1 - (now - fp.t) / 9000);
      ctx.beginPath();
      ctx.ellipse(fp.x, fp.y, 4.5, 2.6, fp.a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawWalls(inView, treesOnly) {
    for (const w of S.WALLS) {
      if ((w.k === 'tree') !== treesOnly) continue;
      if (!inView(w.x + w.w / 2, w.y + w.h / 2, Math.max(w.w, w.h))) continue;
      if (w.k === 'tree') drawTree(w);
      else drawBlock(w);
    }
  }

  function drawBlock(w) {
    // Sombra
    ctx.fillStyle = 'rgba(40,60,90,0.18)';
    ctx.fillRect(w.x + 6, w.y + 8, w.w, w.h);

    if (w.k === 'crate') {
      ctx.fillStyle = '#a3713f';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = '#6e4723';
      ctx.lineWidth = 3;
      ctx.strokeRect(w.x + 1.5, w.y + 1.5, w.w - 3, w.h - 3);
      ctx.beginPath();
      ctx.moveTo(w.x + 4, w.y + 4);
      ctx.lineTo(w.x + w.w - 4, w.y + w.h - 4);
      ctx.moveTo(w.x + w.w - 4, w.y + 4);
      ctx.lineTo(w.x + 4, w.y + w.h - 4);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (w.k === 'wood') {
      ctx.fillStyle = '#8a5a32';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      // Tablones a lo largo de la pared
      ctx.strokeStyle = '#64401f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (w.w >= w.h) {
        for (let yy = w.y + 7; yy < w.y + w.h; yy += 7) {
          ctx.moveTo(w.x, yy);
          ctx.lineTo(w.x + w.w, yy);
        }
      } else {
        for (let xx = w.x + 7; xx < w.x + w.w; xx += 7) {
          ctx.moveTo(xx, w.y);
          ctx.lineTo(xx, w.y + w.h);
        }
      }
      ctx.stroke();
      ctx.strokeStyle = '#4e3218';
      ctx.lineWidth = 2;
      ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
    } else if (w.k === 'rock') {
      ctx.fillStyle = '#8693a3';
      roundRect(w.x, w.y, w.w, w.h, 18);
      ctx.fill();
      ctx.fillStyle = '#6d7a8a';
      roundRect(w.x + w.w * 0.15, w.y + w.h * 0.55, w.w * 0.7, w.h * 0.35, 10);
      ctx.fill();
    } else {
      const g = ctx.createLinearGradient(w.x, w.y, w.x + w.w, w.y + w.h);
      g.addColorStop(0, '#d4eefb');
      g.addColorStop(1, '#a6d3ee');
      ctx.fillStyle = g;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = '#7fb3d3';
      ctx.lineWidth = 2;
      ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
      // Brillos del hielo
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      for (let i = 12; i < w.w + w.h; i += 46) {
        const x0 = w.x + Math.min(i, w.w);
        const y0 = w.y + Math.max(0, i - w.w);
        const d = Math.min(14, x0 - w.x, w.y + w.h - y0);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 - d, y0 + d);
      }
      ctx.stroke();
    }

    // Nieve acumulada encima
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    const capH = Math.min(7, w.h * 0.3);
    roundRect(w.x - 1, w.y - 2, w.w + 2, capH + 2, 3);
    ctx.fill();
  }

  function drawTree(w) {
    const cx = w.x + w.w / 2;
    const cy = w.y + w.h / 2;
    ctx.fillStyle = 'rgba(40,60,90,0.2)';
    ctx.beginPath();
    ctx.ellipse(cx + 10, cy + 14, 44, 36, 0, 0, Math.PI * 2);
    ctx.fill();
    const layers = [[46, '#244b40'], [36, '#2f6152'], [25, '#3c7663'], [13, '#4b8a74']];
    for (const [r, c] of layers) {
      ctx.fillStyle = c;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rr = i % 2 ? r * 0.8 : r;
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const [dx, dy, r] of [[-18, -14, 8], [16, -20, 6], [-6, 22, 7], [22, 10, 6], [0, -4, 5]]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGun(type, x) {
    const def = S.WEAPONS[type] || S.WEAPONS.pistol;
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(x, -3, def.len, 6);
    if (type === 'sniper') {
      ctx.fillStyle = '#4a5260';
      ctx.fillRect(x + 8, -5, 12, 3);
    } else if (type === 'shotgun') {
      ctx.fillStyle = '#7a4f2a';
      ctx.fillRect(x, -3.5, 10, 7);
    } else if (type === 'rifle' || type === 'smg') {
      ctx.fillStyle = '#3d4450';
      ctx.fillRect(x + def.len * 0.35, 3, 4, 6);
    }
  }

  function drawItems(t, inView) {
    if (!snap) return;
    for (const it of snap.i) {
      if (!inView(it.x, it.y, 40)) continue;
      const bob = Math.sin(t / 380 + it.id) * 2;
      ctx.save();
      ctx.translate(it.x, it.y + bob);

      const pulse = 0.5 + Math.sin(t / 300 + it.id) * 0.2;
      const ring = S.isWeapon(it.k) ? `rgba(245,184,61,${pulse})` : it.k === 'medkit' ? `rgba(229,72,77,${pulse})` : `rgba(62,142,247,${pulse})`;
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();

      if (S.isWeapon(it.k)) {
        ctx.rotate(-0.5);
        drawGun(it.k, -S.WEAPONS[it.k].len / 2);
      } else if (it.k === 'medkit') {
        ctx.fillStyle = '#fff';
        roundRect(-10, -10, 20, 20, 4);
        ctx.fill();
        ctx.strokeStyle = '#ccd';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#e5484d';
        ctx.fillRect(-2.5, -7, 5, 14);
        ctx.fillRect(-7, -2.5, 14, 5);
      } else {
        ctx.fillStyle = '#3e6fb8';
        roundRect(-10, -11, 20, 22, 5);
        ctx.fill();
        ctx.fillStyle = '#2a4f88';
        ctx.fillRect(-2, -11, 4, 22);
      }
      ctx.restore();
    }
  }

  function drawPlayers(inView) {
    for (const o of others.values()) {
      if (!o.al || o.id === myId) continue;
      if (!inView(o.dx, o.dy, 60)) continue;
      drawPlayer(o.dx, o.dy, o.da, o.c, o.w, o.n, o.hp, false, o.pr);
    }
    if (joined && me && me.al) {
      const mine = others.get(myId);
      drawPlayer(local.x, local.y, local.a, mine ? mine.c : '#3498db', myWeaponType(), joinName, me.hp, true, mine && mine.pr);
    }
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(((n >> 16) & 255) + amt, 0, 255);
    const g = clamp(((n >> 8) & 255) + amt, 0, 255);
    const b = clamp((n & 255) + amt, 0, 255);
    return `rgb(${r},${g},${b})`;
  }

  function drawPlayer(x, y, a, color, wtype, name, hp, isMe, shielded) {
    const R = S.PLAYER_R;
    ctx.fillStyle = 'rgba(40,60,90,0.22)';
    ctx.beginPath();
    ctx.ellipse(x + 4, y + 6, R + 1, R - 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Protección de reaparición: un aro que titila
    if (shielded) {
      ctx.strokeStyle = `rgba(90,169,230,${0.5 + Math.sin(performance.now() / 80) * 0.3})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, R + 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    // Cuerpo (campera)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(color, -60);
    ctx.lineWidth = 2;
    ctx.stroke();
    // Gorro con pompón
    ctx.fillStyle = shade(color, -35);
    ctx.beginPath();
    ctx.arc(-2, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-3, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();
    // Arma y manos
    drawGun(wtype, 10);
    ctx.fillStyle = '#f0c8a0';
    ctx.strokeStyle = '#b98a5f';
    ctx.lineWidth = 1;
    for (const [hx, hy] of [[12, 5], [18, -3]]) {
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    if (!isMe) {
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(name, x, y - R - 14);
      ctx.fillStyle = '#0f2236';
      ctx.fillText(name, x, y - R - 14);
      ctx.fillStyle = 'rgba(15,34,54,0.35)';
      ctx.fillRect(x - 17, y - R - 9, 34, 4);
      ctx.fillStyle = hp > 50 ? '#3ecf72' : hp > 25 ? '#f5b83d' : '#e5484d';
      ctx.fillRect(x - 17, y - R - 9, 34 * clamp(hp / 100, 0, 1), 4);
    }
  }

  function drawTracers(t) {
    const now = performance.now();
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i];
      const age = (now - tr.t) / 110;
      if (age >= 1) {
        tracers.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = `rgba(255,214,120,${0.9 * (1 - age)})`;
      ctx.lineWidth = tr.type === 'sniper' ? 3 : 1.6;
      ctx.beginPath();
      ctx.moveTo(tr.x1, tr.y1);
      ctx.lineTo(tr.x2, tr.y2);
      ctx.stroke();
      if (age < 0.4) {
        ctx.fillStyle = `rgba(255,220,120,${1 - age * 2})`;
        ctx.beginPath();
        ctx.arc(tr.x1, tr.y1, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawSnow() {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const f of flakes) {
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawMinimap() {
    const size = Math.round(clamp(Math.min(W, H) * 0.24, 120, 210));
    const x0 = 14;
    const y0 = 14;
    const sc = size / S.MAP.w;
    ctx.save();
    roundRect(x0, y0, size, size, 10);
    ctx.fillStyle = 'rgba(238,244,249,0.88)';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = '#8fb3cc';
    for (const w of S.WALLS) {
      ctx.fillRect(x0 + w.x * sc, y0 + w.y * sc, Math.max(1.5, w.w * sc), Math.max(1.5, w.h * sc));
    }
    // Zona visible
    ctx.strokeStyle = 'rgba(15,34,54,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + (camera.x - W / zoom / 2) * sc, y0 + (camera.y - H / zoom / 2) * sc, (W / zoom) * sc, (H / zoom) * sc);
    // Yo
    const px = me && me.al ? local.x : camera.x;
    const py = me && me.al ? local.y : camera.y;
    ctx.fillStyle = '#e5484d';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x0 + px * sc, y0 + py * sc, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(15,34,54,0.35)';
    ctx.lineWidth = 1;
    roundRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1, 10);
    ctx.stroke();
  }

  function drawCrosshair() {
    const def = S.WEAPONS[myWeaponType()];
    const m = movementKeys();
    const moving = m.u || m.d || m.l || m.r;
    const gap = 5 + def.spread * (moving ? 1.6 : 1) * 160;
    const { x, y } = mouse;
    const lines = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (const [color, width] of [['rgba(15,34,54,0.8)', 4], ['#fff', 2]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [dx, dy] of lines) {
        ctx.moveTo(x + dx * gap, y + dy * gap);
        ctx.lineTo(x + dx * (gap + 8), y + dy * (gap + 8));
      }
      ctx.stroke();
    }
    if (performance.now() < hitMarkerUntil) {
      ctx.strokeStyle = '#e5484d';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.moveTo(x + dx * 5, y + dy * 5);
        ctx.lineTo(x + dx * 12, y + dy * 12);
      }
      ctx.stroke();
    }
  }

  connectWS();
  connectSSE();
  requestAnimationFrame(frame);
})();
