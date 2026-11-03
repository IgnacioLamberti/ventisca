# ❄ Ventisca — Deathmatch multijugador

Juego 2D vista desde arriba, **todos contra todos**, en un mapa nevado. Todos arrancan con una pistola y las **armas están en el piso**. Al morir **reaparecés** a los pocos segundos, y **gana quien hace más bajas** en la partida.

Comunicación en tiempo real con **WebSocket** (juego) y **Server-Sent Events** (eventos globales).

---

## Cómo correrlo

Requisitos: Node.js 18 o superior.

```bash
npm install
npm start
```

Abrir `http://localhost:3000`. Para jugar con otras personas en la misma red, usar la dirección que imprime la consola (`http://192.168.x.x:3000`).

No hace falta nadie más para probarlo: en cuanto entra una persona, el servidor completa la partida con bots.

### Configuración (variables de entorno)

```bash
MATCH_MS=60000 KILL_LIMIT=5 MAX_PLAYERS=6 npm start
```

| Variable | Qué controla | Por defecto |
|---|---|---|
| `MATCH_MS` | Duración de cada partida, en milisegundos | 300000 (5 min) |
| `KILL_LIMIT` | Bajas necesarias para ganar | 20 |
| `MAX_PLAYERS` | Capacidad de la partida (personas + bots) | 10 |
| `PORT` | Puerto del servidor | 3000 |

---

## Mapa

4200 × 4200 píxeles. En el centro hay una zona diseñada a mano con un fuerte (el mejor botín), muros de hielo y cajas. Alrededor hay una zona exterior con cabañas de madera (cada una tiene un arma adentro), bosques de pinos, rocas, cajas y muros. Esa zona se genera con una semilla fija, así que el servidor y todos los clientes arman exactamente el mismo mapa sin tener que enviarlo por la red.

## Reglas

| Estado | Qué pasa |
|---|---|
| **Calentamiento** | No hay nadie jugando. Apenas entra la primera persona, los bots completan la partida y arranca la cuenta regresiva. |
| **Cuenta regresiva** | 5 s antes de empezar la partida. |
| **Partida** | Bajas y muertes vuelven a cero, se reinician las armas del piso y todos aparecen con pistola. Al morir reaparecés a los 3 s en un lugar lejos de los enemigos, con 1,5 s de protección (se pierde si disparás). Dura 5 minutos o hasta que alguien llega a 20 bajas. |
| **Fin** | Gana quien tiene más bajas (si empatan, el que murió menos) y suma una victoria. Todos quedan congelados 8 s y arranca otra partida. |

Se puede entrar en cualquier momento: aparecés directamente en la partida en curso.

### Capacidad y bots

- La partida tiene lugar para **10 jugadores**. Los lugares que no ocupan personas los ocupan **bots**, así siempre hay 10 en el mapa.
- Cuando entra una persona, se va un bot (si puede, uno que esté muerto, para no cortar una pelea). Cuando una persona se va, entra un bot.
- Si ya hay 10 personas, la siguiente recibe el aviso de partida llena y vuelve al lobby.
- Si no queda ninguna persona, los bots se van y el servidor queda en calentamiento.
- En la tabla los bots tienen la etiqueta **BOT**.

Los bots corren dentro del servidor (`bots.js`) y juegan con las mismas reglas que una persona: en cada tick deciden qué teclas apretar y hacia dónde apuntar. Buscan armas si no tienen, botiquines si están heridos y si no van hacia el enemigo más cercano. Solo disparan a quien ven (las paredes y los árboles tapan), tardan un poco en reaccionar, apuntan peor cuanto más lejos está el objetivo y se mueven de costado mientras pelean.

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
 killfeed, chat, partidas, tabla, stats ◀──   broadcastSSE(evento, datos)

                 HTTP
 index.html, game.js, shared.js ◀────────   archivos estáticos + GET /api/estado
```

### ¿Por qué WebSocket **y** SSE?

| | WebSocket | SSE |
|---|---|---|
| Dirección | Cliente ↔ servidor | Servidor → cliente |
| Uso en el juego | Teclas, mouse y disparos (cliente → servidor) y posición y marcador de todos los jugadores, objetos y balas (servidor → cliente), 30 veces por segundo | Eventos esporádicos que les interesan a todos: bajas (killfeed), chat, anuncios, inicio y fin de partida, tabla de posiciones y estadísticas |
| Por qué | Necesita baja latencia en ambos sentidos | Es simple, reconecta solo (`EventSource`), funciona sobre HTTP común y no necesita estar dentro de la partida: el **lobby** ya muestra la actividad en vivo antes de entrar a jugar |

El chat muestra los dos juntos: el mensaje **sale por WebSocket** (`{t:'chat'}`) y el servidor lo **reparte por SSE** (`event: chat`) a todos, incluso a quienes están en el lobby.

### Servidor autoritativo

El cliente nunca dice "estoy en (x, y)" ni "le pegué a Juan": solo manda qué teclas aprieta y hacia dónde apunta. El servidor:

1. Mueve a cada jugador con las mismas reglas de colisión (`public/shared.js`).
2. Resuelve cada disparo con un rayo contra paredes (intersección rayo–rectángulo) y jugadores (rayo–círculo).
3. Aplica daño, chaleco, muertes, reapariciones y el estado de la partida (tiempo y límite de bajas).
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
| `{t:'full', max}` | La partida está llena: no se pudo entrar |
| `{t:'s', now, st, te, rn, kl, p, i, sh, me}` | Snapshot: estado y fin de la partida, límite de bajas, jugadores (con bajas y muertes), objetos, disparos de este tick y mi estado |
| `{t:'pong', ts}` | Respuesta al ping |

**SSE — eventos (`GET /events`)**

| Evento | Datos |
|---|---|
| `kill` | `{killer, victim, weapon}` |
| `chat` | `{name, color, text}` |
| `announce` | `{text}` — entradas, salidas, inicio y fin de partida |
| `round` | `{state, number, endsAt, killLimit, winner?, winnerKills?}` |
| `scoreboard` | Lista ordenada por bajas, muertes y victorias |
| `stats` | Personas, bots, capacidad, conectados por WS, escuchando SSE, vivos, uptime |

Se puede ver el stream crudo con:

```bash
curl -N http://localhost:3000/events
```

---

## Estructura

```
server.js          Servidor HTTP + WebSocket + SSE y la lógica del juego
bots.js            Inteligencia de los bots de relleno
public/
  index.html       Lobby y HUD
  style.css        Estilos
  shared.js        Mapa, armas y colisiones (lo usan servidor y cliente)
  game.js          Cliente: red, predicción, dibujo en canvas, sonido
```
