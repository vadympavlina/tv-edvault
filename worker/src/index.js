// Settings server for the TV schedule screens (Cloudflare Worker + one Durable Object).
//
//   POST /tv              TV heartbeat; returns settings, reload marker and server time   (public)
//   POST /login           { password } -> { token, expires }
//   GET  /admin           settings, history, screens, reload marker                       (token)
//   PUT  /settings        { days } -> saves, appends history                               (token)
//   POST /reload          asks every TV to reload the page                                 (token)
//
// ADMIN_PASSWORD is a Worker secret. Sessions are HMAC-signed with a key derived from it,
// so changing the password signs everybody out.
import "../../schedule.js";

const Schedule = globalThis.TVSchedule;

const SESSION_DAYS = 30;
const HISTORY_LIMIT = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
// Heartbeats arrive every minute; only persist a screen when something changed or this often.
const SCREEN_PERSIST_MS = 10 * 60 * 1000;
const SCREEN_FORGET_MS = 30 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const hub = env.HUB.get(env.HUB.idFromName("main"));
    const response = await hub.fetch(request);
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
    this.screens = null; // id -> screen, loaded lazily
    this.persistedAt = new Map(); // id -> last time written to storage
    this.failures = new Map(); // ip -> { count, since }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = request.method + " " + url.pathname;
    try {
      switch (route) {
        case "POST /tv":
          return json(await this.heartbeat(request));
        case "POST /login":
          return await this.login(request);
        case "GET /admin":
          await this.authorize(request);
          return json(await this.adminState());
        case "PUT /settings":
          await this.authorize(request);
          return json(await this.saveSettings(request));
        case "POST /reload":
          await this.authorize(request);
          return json(await this.requestReload());
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

  // ---------- TVs ----------

  async heartbeat(request) {
    const body = await readJson(request);
    const id = cleanText(body.id, 40);
    if (id) await this.touchScreen(id, body, request);
    const [settings, reloadAt] = await Promise.all([
      this.ctx.storage.get("settings"),
      this.ctx.storage.get("reloadAt"),
    ]);
    return { settings: settings || null, reloadAt: reloadAt || 0, serverTime: Date.now() };
  }

  async loadScreens() {
    if (this.screens) return this.screens;
    const stored = await this.ctx.storage.list({ prefix: "screen:" });
    this.screens = new Map();
    const now = Date.now();
    for (const [key, screen] of stored) {
      if (now - screen.lastSeen > SCREEN_FORGET_MS) {
        await this.ctx.storage.delete(key);
      } else {
        this.screens.set(screen.id, screen);
        this.persistedAt.set(screen.id, screen.lastSeen);
      }
    }
    return this.screens;
  }

  async touchScreen(id, body, request) {
    const screens = await this.loadScreens();
    const previous = screens.get(id);
    const screen = {
      id,
      name: cleanText(body.name, 60) || (previous && previous.name) || "",
      state: ["schedule", "night", "splash"].includes(body.state) ? body.state : "unknown",
      scheduleLoadedAt: Number(body.scheduleLoadedAt) || 0,
      startedAt: Number(body.startedAt) || 0,
      size: cleanText(body.size, 20),
      ip: request.headers.get("CF-Connecting-IP") || "",
      lastSeen: Date.now(),
    };
    screens.set(id, screen);

    const changed =
      !previous ||
      previous.state !== screen.state ||
      previous.name !== screen.name ||
      previous.startedAt !== screen.startedAt;
    const stale = screen.lastSeen - (this.persistedAt.get(id) || 0) >= SCREEN_PERSIST_MS;
    if (changed || stale) {
      this.persistedAt.set(id, screen.lastSeen);
      await this.ctx.storage.put("screen:" + id, screen);
    }
  }

  // ---------- Admin ----------

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

  async authorize(request) {
    const header = request.headers.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const [expires, signature] = token.split(".");
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
    const [settings, history, reloadAt, screens] = await Promise.all([
      this.ctx.storage.get("settings"),
      this.ctx.storage.get("history"),
      this.ctx.storage.get("reloadAt"),
      this.loadScreens(),
    ]);
    return {
      settings: settings || null,
      history: history || [],
      reloadAt: reloadAt || 0,
      screens: Array.from(screens.values()).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
      serverTime: Date.now(),
    };
  }

  async saveSettings(request) {
    const body = await readJson(request);
    if (!body || typeof body.days !== "object") throw new HttpError(400, "bad_settings");
    const settings = Schedule.normalize(body);
    const history = (await this.ctx.storage.get("history")) || [];
    history.unshift({ at: Date.now(), settings });
    await this.ctx.storage.put({ settings, history: history.slice(0, HISTORY_LIMIT) });
    return { settings, history: history.slice(0, HISTORY_LIMIT) };
  }

  async requestReload() {
    const reloadAt = Date.now();
    await this.ctx.storage.put("reloadAt", reloadAt);
    return { reloadAt };
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
