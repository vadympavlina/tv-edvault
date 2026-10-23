// Settings server for the TV schedule screens (Cloudflare Worker + one Durable Object).
//
// TVs keep a WebSocket open (GET /tv/ws). The Durable Object uses the hibernation API: between
// events it sleeps and is not billed, and the TVs' keep-alive pings are answered by Cloudflare
// itself ("ping" -> "pong") without waking it. It only wakes when a TV connects, changes state
// or disconnects, and when an admin saves something, which is then pushed to every TV at once.
//
//   GET  /tv/ws?id=&name=   TV WebSocket                                                  (public)
//   POST /tv                HTTP fallback for TVs without a working WebSocket             (public)
//   POST /login             { password } -> { token, expires }
//   GET  /admin             settings, history, screens, reload marker                     (token)
//   GET  /admin/ws?token=   live updates of the same for the settings page                (token)
//   PUT  /settings          { days, exceptions } -> saves, appends history, pushes to TVs (token)
//   PUT  /override          { mode: "on"|"off", until } or { mode: null } -> "now" button  (token)
//   POST /reload            asks every TV to reload the page                              (token)
//   POST /screens/forget    { id } -> removes an offline TV from the list                 (token)
//   POST /screens/rename    { id, label } -> name shown on the settings page              (token)
//   POST /screens/reload    { id } -> restarts the app on that one TV                     (token)
//
// ADMIN_PASSWORD is a Worker secret. Sessions are HMAC-signed with a key derived from it,
// so changing the password signs everybody out.
import "../../schedule.js";

const Schedule = globalThis.TVSchedule;

const SESSION_DAYS = 30;
const HISTORY_LIMIT = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
// TVs ping every 30 s; a socket silent for longer than this is treated as dead (power cut,
// network gone) and closed.
const SOCKET_STALE_MS = 75 * 1000;
// HTTP-fallback TVs check in every 5 minutes.
const HTTP_ONLINE_MS = 7 * 60 * 1000;
// While a settings page is open, look for dead TV sockets this often. Each look wakes the
// object, so this only runs while somebody watches (the page disconnects when hidden).
const SWEEP_MS = 60 * 1000;
const SCREEN_FORGET_MS = 30 * 24 * 60 * 60 * 1000;
const STATES = ["schedule", "night", "splash"];
// Per-TV log of what it showed and when it was offline, for the 24-hour strip on the settings
// page. Kept a little longer than shown so the strip always knows how the window began.
const EVENTS_KEEP_MS = 48 * 60 * 60 * 1000;
const EVENTS_MAX = 500;
// Special dates are kept this long after they end, then dropped on the next save.
const KEEP_PAST_EXCEPTIONS_DAYS = 60;
// A manual override may not reach further than this.
const OVERRIDE_MAX_MS = 14 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const hub = env.HUB.get(env.HUB.idFromName("main"));
    const response = await hub.fetch(request);
    if (response.webSocket) return response; // 101 Switching Protocols: pass through untouched

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },
};

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    // TVs may open the page from anywhere; admin routes still need a valid token.
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // In-memory only: lost when the object hibernates, which is fine for a rate limiter.
    this.failures = new Map(); // ip -> { count, since }
    // Answered by Cloudflare without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = request.method + " " + url.pathname;
    try {
      switch (route) {
        case "GET /tv/ws":
          return await this.connectTv(request, url);
        case "POST /tv":
          return json(await this.httpCheckIn(request));
        case "POST /login":
          return await this.login(request);
        case "GET /admin":
          await this.authorize(bearer(request));
          return json(await this.adminState());
        case "GET /admin/ws":
          await this.authorize(url.searchParams.get("token") || "");
          return await this.connectAdmin(request);
        case "PUT /settings":
          await this.authorize(bearer(request));
          return json(await this.saveSettings(request));
        case "PUT /override":
          await this.authorize(bearer(request));
          return json(await this.saveOverride(request));
        case "POST /reload":
          await this.authorize(bearer(request));
          return json(await this.requestReload());
        case "POST /screens/rename":
          await this.authorize(bearer(request));
          return json(await this.renameScreen(request));
        case "POST /screens/reload":
          await this.authorize(bearer(request));
          return json(await this.reloadScreen(request));
        case "POST /screens/forget":
          await this.authorize(bearer(request));
          return json(await this.forgetScreen(request));
        case "GET /":
          return json({ ok: true });
        default:
          return json({ error: "not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      console.error(error);
      return json({ error: "server_error" }, 500);
    }
  }

  // ---------- TV sockets ----------

  async connectTv(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "websocket_expected");
    const id = cleanText(url.searchParams.get("id"), 40);
    if (!id) throw new HttpError(400, "id_required");

    // A TV that reconnects before its old socket timed out: drop the old one.
    for (const old of this.ctx.getWebSockets("tv:" + id)) safeClose(old, 4000, "replaced");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["tv", "tv:" + id]);

    const stored = await this.ctx.storage.get("screen:" + id);
    const screen = {
      id,
      name: cleanText(url.searchParams.get("name"), 60) || (stored && stored.name) || "",
      label: (stored && stored.label) || "", // set on the settings page, wins over `name`
      state: STATES.includes(url.searchParams.get("state")) ? url.searchParams.get("state") : "unknown",
      size: cleanText(url.searchParams.get("size"), 20),
      startedAt: Number(url.searchParams.get("startedAt")) || 0,
      ip: request.headers.get("CF-Connecting-IP") || "",
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      transport: "websocket",
    };
    server.serializeAttachment(screen);
    await this.ctx.storage.put("screen:" + id, screen);
    await this.logEvent(id, screen.connectedAt, screen.state);

    send(server, { type: "hello", ...(await this.tvState()) });
    await this.broadcastScreens();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (!tags.includes("tv") || typeof message !== "string") return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data.type === "status") {
      const screen = ws.deserializeAttachment() || {};
      if (STATES.includes(data.state)) screen.state = data.state;
      if (typeof data.stale === "boolean") screen.stale = data.stale;
      if (Number(data.loadedAt) > 0) screen.loadedAt = Number(data.loadedAt);
      screen.lastSeen = Date.now();
      ws.serializeAttachment(screen);
      await this.ctx.storage.put("screen:" + screen.id, screen);
      await this.logEvent(screen.id, screen.lastSeen, screen.state);
      await this.broadcastScreens();
    } else if (data.type === "time") {
      send(ws, { type: "time", serverTime: Date.now() });
    }
  }

  async webSocketClose(ws, code) {
    safeClose(ws, 1000, "bye");
    await this.socketGone(ws, code);
  }

  async webSocketError(ws) {
    await this.socketGone(ws, 1006);
  }

  async socketGone(ws) {
    if (!this.ctx.getTags(ws).includes("tv")) return;
    const screen = ws.deserializeAttachment();
    if (!screen) return;
    // A newer socket from the same TV may already be open; it owns the record then.
    const others = openSockets(this.ctx, "tv:" + screen.id).filter((other) => other !== ws);
    if (others.length) return;
    screen.lastSeen = this.lastHeard(ws, screen);
    screen.offlineSince = Date.now();
    await this.ctx.storage.put("screen:" + screen.id, screen);
    await this.logEvent(screen.id, screen.lastSeen, "offline");
    await this.broadcastScreens();
  }

  // When we last heard from a TV socket: its last auto-answered ping, or the connect time.
  lastHeard(ws, screen) {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    return Math.max(pinged ? pinged.getTime() : 0, screen.lastSeen || 0, screen.connectedAt || 0);
  }

  // Close sockets whose TV stopped pinging (power cut, cable pulled): the network may never
  // tell us otherwise.
  async sweep() {
    const now = Date.now();
    let changed = false;
    for (const ws of openSockets(this.ctx, "tv")) {
      const screen = ws.deserializeAttachment();
      if (!screen) continue;
      const heard = this.lastHeard(ws, screen);
      if (now - heard > SOCKET_STALE_MS) {
        screen.lastSeen = heard;
        screen.offlineSince = now;
        ws.serializeAttachment(screen);
        await this.ctx.storage.put("screen:" + screen.id, screen);
        await this.logEvent(screen.id, heard, "offline");
        safeClose(ws, 4001, "stale");
        changed = true;
      }
    }
    return changed;
  }

  async alarm() {
    const changed = await this.sweep();
    if (changed) await this.broadcastScreens();
    // Keep watching only while somebody is looking at the settings page.
    if (openSockets(this.ctx, "admin").length) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  // ---------- TV over plain HTTP (fallback) ----------

  async httpCheckIn(request) {
    const body = await readJson(request);
    const id = cleanText(body.id, 40);
    if (id && !openSockets(this.ctx, "tv:" + id).length) {
      const stored = (await this.ctx.storage.get("screen:" + id)) || {};
      const screen = {
        id,
        name: cleanText(body.name, 60) || stored.name || "",
        label: stored.label || "",
        state: STATES.includes(body.state) ? body.state : "unknown",
        stale: body.stale === true,
        size: cleanText(body.size, 20),
        startedAt: Number(body.startedAt) || 0,
        ip: request.headers.get("CF-Connecting-IP") || "",
        lastSeen: Date.now(),
        transport: "http",
      };
      await this.ctx.storage.put("screen:" + id, screen);
      // A long gap between check-ins means it was offline in between.
      if (stored.lastSeen && screen.lastSeen - stored.lastSeen > HTTP_ONLINE_MS) {
        await this.logEvent(id, stored.lastSeen, "offline");
      }
      await this.logEvent(id, screen.lastSeen, screen.state);
      if (stored.state !== screen.state || stored.transport !== "http") await this.broadcastScreens();
    }
    return this.tvState();
  }

  // What a TV needs: saved settings (null until the first save), the manual override, the
  // reload marker and the exact time.
  async tvState() {
    const [settings, override, reloadAt] = await Promise.all([
      this.ctx.storage.get("settings"),
      this.override(),
      this.ctx.storage.get("reloadAt"),
    ]);
    return { settings: settings || null, override, reloadAt: reloadAt || 0, serverTime: Date.now() };
  }

  async override() {
    const override = Schedule.normalizeOverride(await this.ctx.storage.get("override"));
    return override && override.until > Date.now() ? override : null;
  }

  // ---------- Events ----------

  async logEvent(id, at, state) {
    const key = "events:" + id;
    const events = (await this.ctx.storage.get(key)) || [];
    const last = events[events.length - 1];
    if (last && last.s === state) return; // only changes matter
    events.push({ at, s: state });
    events.sort((a, b) => a.at - b.at);
    // Drop what is too old, but keep the last event before the cut: it says how the window began.
    const cut = Date.now() - EVENTS_KEEP_MS;
    let first = 0;
    while (first < events.length - 1 && events[first + 1].at < cut) first++;
    await this.ctx.storage.put(key, events.slice(first).slice(-EVENTS_MAX));
  }

  // ---------- Screens list ----------

  async screens() {
    const now = Date.now();
    const live = new Map();
    for (const ws of openSockets(this.ctx, "tv")) {
      const screen = ws.deserializeAttachment();
      if (screen) live.set(screen.id, { ...screen, lastSeen: this.lastHeard(ws, screen), online: true });
    }
    const result = [];
    for (const [key, stored] of await this.ctx.storage.list({ prefix: "screen:" })) {
      if (live.has(stored.id)) {
        result.push(live.get(stored.id));
        live.delete(stored.id);
      } else if (now - stored.lastSeen > SCREEN_FORGET_MS) {
        await this.ctx.storage.delete(key);
      } else {
        const online = stored.transport === "http" && now - stored.lastSeen < HTTP_ONLINE_MS;
        result.push({ ...stored, online });
      }
    }
    for (const screen of live.values()) result.push(screen);
    for (const screen of result) screen.events = (await this.ctx.storage.get("events:" + screen.id)) || [];
    return result
      .map(({ ip, ...screen }) => screen) // the settings page has no use for addresses
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "uk"));
  }

  async broadcastScreens() {
    const admins = openSockets(this.ctx, "admin");
    if (!admins.length) return;
    const message = { type: "screens", screens: await this.screens(), serverTime: Date.now() };
    for (const ws of admins) send(ws, message);
  }

  // Returns how many TVs got it right away; the rest pick it up when they reconnect.
  broadcastTvs(message) {
    const sockets = openSockets(this.ctx, "tv");
    for (const ws of sockets) send(ws, message);
    return sockets.length;
  }

  // ---------- Admin ----------

  async connectAdmin(request) {
    if (request.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "websocket_expected");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["admin"]);
    await this.sweep();
    send(server, { type: "state", ...(await this.adminState()) });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async login(request) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const record = this.failures.get(ip);
    if (record && now - record.since < LOGIN_WINDOW_MS && record.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, "too_many_attempts");
    }

    const body = await readJson(request);
    const password = String(body.password || "");
    if (!this.env.ADMIN_PASSWORD) throw new HttpError(503, "password_not_set");
    if (!(await safeEqual(password, this.env.ADMIN_PASSWORD))) {
      const fresh = !record || now - record.since >= LOGIN_WINDOW_MS;
      this.failures.set(ip, { count: fresh ? 1 : record.count + 1, since: fresh ? now : record.since });
      throw new HttpError(401, "wrong_password");
    }

    this.failures.delete(ip);
    const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
    return json({ token: await this.sign(String(expires)), expires });
  }

  async authorize(token) {
    const [expires, signature] = String(token).split(".");
    if (!expires || !signature || Number(expires) < Date.now()) throw new HttpError(401, "unauthorized");
    const expected = await this.sign(expires);
    if (!(await safeEqual(token, expected))) throw new HttpError(401, "unauthorized");
  }

  async sign(payload) {
    const key = await crypto.subtle.importKey(
      "raw",
      await sha256("tv-session:" + (this.env.ADMIN_PASSWORD || "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return payload + "." + base64url(mac);
  }

  async adminState() {
    const [settings, override, history, reloadAt, screens] = await Promise.all([
      this.ctx.storage.get("settings"),
      this.override(),
      this.ctx.storage.get("history"),
      this.ctx.storage.get("reloadAt"),
      this.screens(),
    ]);
    return {
      settings: settings || null,
      override,
      history: history || [],
      reloadAt: reloadAt || 0,
      screens,
      serverTime: Date.now(),
    };
  }

  async saveSettings(request) {
    const body = await readJson(request);
    if (!body || typeof body.days !== "object") throw new HttpError(400, "bad_settings");
    const today = Schedule.now(this.env.TIME_ZONE).date;
    const settings = Schedule.pruneExceptions(Schedule.normalize(body), today, KEEP_PAST_EXCEPTIONS_DAYS);
    const history = (await this.ctx.storage.get("history")) || [];
    history.unshift({ at: Date.now(), settings });
    const trimmed = history.slice(0, HISTORY_LIMIT);
    await this.ctx.storage.put({ settings, history: trimmed });

    const override = await this.override();
    const delivered = this.broadcastTvs({ type: "settings", settings, override, serverTime: Date.now() });
    for (const ws of openSockets(this.ctx, "admin")) send(ws, { type: "settings", settings, history: trimmed });
    return { settings, history: trimmed, delivered };
  }

  async saveOverride(request) {
    const body = await readJson(request);
    let override = null;
    if (body.mode !== null && body.mode !== undefined) {
      override = Schedule.normalizeOverride(body);
      const now = Date.now();
      if (!override || override.until <= now || override.until > now + OVERRIDE_MAX_MS) {
        throw new HttpError(400, "bad_override");
      }
    }
    if (override) await this.ctx.storage.put("override", override);
    else await this.ctx.storage.delete("override");

    const settings = (await this.ctx.storage.get("settings")) || null;
    const delivered = this.broadcastTvs({ type: "settings", settings, override, serverTime: Date.now() });
    for (const ws of openSockets(this.ctx, "admin")) send(ws, { type: "override", override });
    return { override, delivered };
  }

  async renameScreen(request) {
    const body = await readJson(request);
    const id = cleanText(body.id, 40);
    const stored = id && (await this.ctx.storage.get("screen:" + id));
    if (!stored) throw new HttpError(404, "screen_not_found");
    const label = cleanText(body.label, 60);
    stored.label = label;
    await this.ctx.storage.put("screen:" + id, stored);
    for (const ws of openSockets(this.ctx, "tv:" + id)) {
      const screen = ws.deserializeAttachment();
      if (screen) ws.serializeAttachment({ ...screen, label });
    }
    await this.broadcastScreens();
    return { screens: await this.screens() };
  }

  async reloadScreen(request) {
    const body = await readJson(request);
    const id = cleanText(body.id, 40);
    if (!id) throw new HttpError(400, "id_required");
    const sockets = openSockets(this.ctx, "tv:" + id);
    for (const ws of sockets) send(ws, { type: "restart" });
    return { delivered: sockets.length };
  }

  async forgetScreen(request) {
    const body = await readJson(request);
    const id = cleanText(body.id, 40);
    if (!id) throw new HttpError(400, "id_required");
    if (openSockets(this.ctx, "tv:" + id).length) throw new HttpError(409, "screen_online");
    await this.ctx.storage.delete(["screen:" + id, "events:" + id]);
    await this.broadcastScreens();
    return { screens: await this.screens() };
  }

  async requestReload() {
    const reloadAt = Date.now();
    await this.ctx.storage.put("reloadAt", reloadAt);
    const delivered = this.broadcastTvs({ type: "reload", reloadAt });
    return { reloadAt, delivered };
  }
}

// ---------- Helpers ----------

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Sockets we closed ourselves linger in getWebSockets() until the close completes.
function openSockets(ctx, tag) {
  return ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
}

function send(ws, message) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket already closing; its close handler cleans up.
  }
}

function safeClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

// Compares digests so the time taken does not depend on where the strings differ.
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(x, y)
    : base64url(x) === base64url(y);
}

function base64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
