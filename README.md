# ❄ Ventisca — Battle Royale multijugador

Juego 2D vista desde arriba, **todos contra todos**, en un mapa nevado. Todos arrancan con una pistola y las **armas están en el piso**. Una **tormenta** va cerrando el mapa y el **último en pie gana** la ronda.

Comunicación en tiempo real con **WebSocket** (juego) y **Server-Sent Events** (eventos globales).

---

## Cómo correrlo

Requisitos: Node.js 18 o superior.

```bash
npm install
npm start
```

Abrir `http://localhost:3000`. Para jugar con otras personas en la misma red, usar la dirección que imprime la consola (`http://192.168.x.x:3000`).

### Probar solo, con bots

En otra terminal, con el servidor corriendo:

```bash
npm run bots            # 3 bots
node test/bots.js 6     # 6 bots
```

### Tormenta rápida (para la demo)

```bash
ZONE_GRACE_MS=5000 ZONE_SHRINK_MS=30000 npm start
```

---

## Reglas

| Estado | Qué pasa |
|---|---|
| **Calentamiento** | Hay menos de 2 jugadores. Se puede practicar; al morir reaparecés a los 3 s. |
| **Cuenta regresiva** | 5 s antes de empezar la ronda. |
| **Ronda** | Todos reaparecen con pistola, se reinician las armas del piso. Sin respawn. A los 20 s la tormenta empieza a cerrarse (150 s), y hace cada vez más daño. |
| **Fin** | Gana el último vivo (+1 victoria). A los 7 s arranca otra ronda. |

Quien entra con una ronda en curso la mira como espectador y juega desde la siguiente.

### Armas y objetos

| Arma | Daño | Cargador | Notas |
|---|---|---|---|
| Pistola | 20 | 12 / ∞ | Con la que arrancan todos |
| Subfusil | 15 | 30 | Automática, mucha dispersión |
| Rifle | 26 | 30 | Automática, precisa |
| Escopeta | 8 × 14 | 6 | Pierde daño con la distancia |
| Francotirador | 105 | 5 | Más lenta al moverse, cámara más alejada |

- **Botiquín**: +50 de vida (se toma solo al pasar por encima).
- **Chaleco**: absorbe la mitad del daño hasta gastarse.
- Al morir, tu arma principal queda en el piso para que otro la tome.

### Controles

`WASD` moverse · `Mouse` apuntar · `Clic` disparar · `E` recoger arma · `G` tirarla · `R` recargar · `1` `2` `Q` / rueda cambiar arma · `Enter` chat · `Tab` tabla · `Espacio` cambiar a quién mirás cuando estás muerto.

---

## Arquitectura

```
Navegador                                   Servidor Node (server.js)
─────────                                   ─────────────────────────
                 WebSocket  /ws  (bidireccional, 30/s)
 inputs  ───────────────────────────────▶   simulación autoritativa (30 ticks/s)
 estado  ◀───────────────────────────────   snapshot del mundo + mi estado

                 SSE  /events  (servidor → todos)
 killfeed, chat, rondas, tabla, stats ◀──   broadcastSSE(evento, datos)

                 HTTP
 index.html, game.js, shared.js ◀────────   archivos estáticos + GET /api/estado
```

### ¿Por qué WebSocket **y** SSE?

| | WebSocket | SSE |
|---|---|---|
| Dirección | Cliente ↔ servidor | Servidor → cliente |
| Uso en el juego | Teclas, mouse y disparos (cliente → servidor) y posición de todos los jugadores, balas y tormenta (servidor → cliente), 30 veces por segundo | Eventos esporádicos que les interesan a todos: bajas (killfeed), chat, anuncios, cambios de ronda, tabla de posiciones y estadísticas |
| Por qué | Necesita baja latencia en ambos sentidos | Es simple, reconecta solo (`EventSource`), funciona sobre HTTP común y no necesita estar dentro de la partida: el **lobby** ya muestra la actividad en vivo antes de entrar a jugar |

El chat muestra los dos juntos: el mensaje **sale por WebSocket** (`{t:'chat'}`) y el servidor lo **reparte por SSE** (`event: chat`) a todos, incluso a quienes están en el lobby.

### Servidor autoritativo

El cliente nunca dice "estoy en (x, y)" ni "le pegué a Juan": solo manda qué teclas aprieta y hacia dónde apunta. El servidor:

1. Mueve a cada jugador con las mismas reglas de colisión (`public/shared.js`).
2. Resuelve cada disparo con un rayo contra paredes (intersección rayo–rectángulo) y jugadores (rayo–círculo).
3. Aplica daño, chaleco, muertes, la tormenta y el estado de la ronda.
4. Envía a cada cliente el snapshot. La parte común se serializa una sola vez y a cada uno se le agrega su estado privado (`me`: munición, recarga, eventos de daño).

Para que el movimiento propio no se sienta con retraso, el cliente **predice** su posición con el mismo código del servidor y la **corrige** suavemente cuando el servidor dice otra cosa. A los demás jugadores los **interpola** entre snapshots.

### Protocolo

**WebSocket — cliente → servidor**

| Mensaje | Significado |
|---|---|
| `{t:'join', name}` | Entrar a la partida |
| `{t:'i', u,d,l,r, a, s, c}` | Teclas de movimiento, ángulo de la mira, gatillo apretado y contador de clics |
| `{t:'pickup'}` / `{t:'drop'}` | Recoger / tirar arma |
| `{t:'reload'}` | Recargar |
| `{t:'slot', s}` | Cambiar a `primary`, `secondary` o `toggle` |
| `{t:'chat', text}` | Mensaje de chat |
| `{t:'ping', ts}` | Medir latencia |

**WebSocket — servidor → cliente**

| Mensaje | Significado |
|---|---|
| `{t:'welcome', id}` | Id asignado |
| `{t:'s', now, st, te, rn, z, p, i, sh, me}` | Snapshot: estado de ronda, tormenta, jugadores, objetos, disparos de este tick y mi estado |
| `{t:'pong', ts}` | Respuesta al ping |

**SSE — eventos (`GET /events`)**

| Evento | Datos |
|---|---|
| `kill` | `{killer, victim, weapon}` (killer `null` si fue la tormenta) |
| `chat` | `{name, color, text}` |
| `announce` | `{text}` — entradas, salidas, inicio y fin de ronda |
| `round` | `{state, number, endsAt, winner?}` |
| `scoreboard` | Lista ordenada por victorias y bajas |
| `stats` | Conectados por WS, escuchando SSE, vivos, uptime |

Se puede ver el stream crudo con:

```bash
curl -N http://localhost:3000/events
```

---

## Estructura

```
server.js          Servidor HTTP + WebSocket + SSE y la lógica del juego
public/
  index.html       Lobby y HUD
  style.css        Estilos
  shared.js        Mapa, armas y colisiones (lo usan servidor y cliente)
  game.js          Cliente: red, predicción, dibujo en canvas, sonido
test/bots.js       Bots para probar y llenar partidas
```
