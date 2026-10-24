// Air raid alerts from alerts.in.ua (https://devs.alerts.in.ua/), boiled down to what the TV
// needs: is there an alert for *our place* right now, and how serious.
//
// We read /v1/alerts/active.json (all active alerts in the country) and keep only those that
// cover our place: the whole oblast, our raion, or our city/hromada. Alerts elsewhere in the
// oblast are ignored.
//
// Result ("state"):
//   { level: "none" }                                      nothing for us
//   { level: "yellow", kind: "air_raid", since }           early warning: a band at the bottom
//   { level: "red", kind: "air_raid" | "artillery_shelling" | "urban_fights" | "chemical" | "nuclear", since }
//                                                          full screen

const KINDS = ["air_raid", "artillery_shelling", "urban_fights", "chemical", "nuclear"];
// What wins when several alerts are active at once (first = most important).
const RED_ORDER = ["nuclear", "chemical", "urban_fights", "air_raid", "artillery_shelling"];

export const DEFAULT_OBLAST_UID = "5"; // Рівненська область
export const DEFAULT_RAION_UID = "112"; // Рівненський район (the city is in it)
// Location titles that count as "our place" (besides the whole oblast).
export const DEFAULT_PLACES = "^(Рівненський район|(м\\. )?Рівне( .*)?|Рівненська (міська |територіальна )*громада.*)$";

// Bump when the rules below change: a state saved under older rules is then recomputed from a
// full download instead of being kept by a 304 Not Modified.
export const RULES_VERSION = 2;

export const DEFAULT_OBLAST_TITLE = "Рівненська область";

// Is this alert somewhere in our oblast? Not by location_oblast_uid alone: for raions the live
// API puts the raion's own uid there (Рівненський район: location_uid "112",
// location_oblast_uid 112), so the oblast's name in location_oblast counts too.
export function inOblast(alert, oblastUid = DEFAULT_OBLAST_UID, oblastTitle = DEFAULT_OBLAST_TITLE) {
  if (!alert) return false;
  return (
    String(alert.location_oblast_uid ?? "") === String(oblastUid) ||
    String(alert.location_uid ?? "") === String(oblastUid) ||
    String(alert.location_oblast || "").trim() === oblastTitle
  );
}

// Does this alert cover our place?
export function coversUs(alert, oblastUid, places, oblastTitle = DEFAULT_OBLAST_TITLE) {
  if (!inOblast(alert, oblastUid, oblastTitle)) return false;
  if (alert.location_type === "oblast") return true;
  return places.test(String(alert.location_title || "").trim());
}

// Collapse the alerts that cover us into one state.
export function summarize(alerts, oblastUid = DEFAULT_OBLAST_UID, placesPattern = DEFAULT_PLACES) {
  const places = new RegExp(placesPattern);
  const ours = (alerts || []).filter(
    (a) => !a.finished_at && KINDS.includes(a.alert_type) && coversUs(a, oblastUid, places)
  );
  if (!ours.length) return { level: "none" };

  // Air raid alerts carry a level; older records without one are red. Every other kind is
  // shown full screen.
  const isRed = (a) => a.alert_type !== "air_raid" || a.alert_level !== "yellow";
  const red = ours.filter(isRed);
  if (red.length) {
    const kind = RED_ORDER.find((k) => red.some((a) => a.alert_type === k));
    return { level: "red", kind, since: earliest(red.filter((a) => a.alert_type === kind)), places: titles(red) };
  }
  return { level: "yellow", kind: "air_raid", since: earliest(ours), places: titles(ours) };
}

function earliest(alerts) {
  const times = alerts.map((a) => Date.parse(a.started_at)).filter((t) => isFinite(t));
  return times.length ? Math.min(...times) : null;
}

function titles(alerts) {
  return Array.from(new Set(alerts.map((a) => a.location_title).filter(Boolean))).sort();
}

// Every active alert in our oblast, counted or not, so the settings page can show which
// place names the API actually uses (and whether we matched Rivne correctly).
export function oblastPlaces(alerts, oblastUid = DEFAULT_OBLAST_UID, placesPattern = DEFAULT_PLACES) {
  const places = new RegExp(placesPattern);
  const seen = new Map();
  for (const a of alerts || []) {
    if (a.finished_at || !inOblast(a, oblastUid)) continue;
    const title = String(a.location_title || "").trim();
    if (!title || seen.has(title)) continue;
    seen.set(title, { title, type: a.location_type || "", counted: coversUs(a, oblastUid, places) });
  }
  return Array.from(seen.values());
}

// Backup source: the light "IoT" endpoint made for status boards. One character per location
// uid (index = uid): N none, P partly, R red, Y yellow, A active (no level). Air raids only and
// no start time, so it is used only when the main endpoint fails.
export function summarizeIot(text, oblastUid = DEFAULT_OBLAST_UID, raionUid = DEFAULT_RAION_UID) {
  const str = String(text || "");
  const level = (c) => (c === "R" || c === "A" ? "red" : c === "Y" ? "yellow" : null);
  const found = level(str.charAt(Number(oblastUid))) || level(str.charAt(Number(raionUid)));
  return found ? { level: found, kind: "air_raid", since: null } : { level: "none" };
}

export function sameState(a, b) {
  return (
    !!a && !!b && a.level === b.level && (a.kind || null) === (b.kind || null) && (a.since || null) === (b.since || null)
  );
}

function apiBase(env) {
  return String(env.ALERTS_API_URL || "https://api.alerts.in.ua").replace(/\/+$/, "");
}

// One poll of the backup endpoint. Keeps the start time of the alert we already know about.
export async function fetchIotState(env, previous) {
  const response = await fetch(apiBase(env) + "/v2/iot/active_air_raid_alerts.json", {
    headers: { Authorization: "Bearer " + env.ALERTS_TOKEN, Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error("alerts.in.ua (iot) answered " + response.status);
    error.status = response.status;
    throw error;
  }
  const state = summarizeIot(await response.json(), env.ALERT_OBLAST_UID || DEFAULT_OBLAST_UID, env.ALERT_RAION_UID || DEFAULT_RAION_UID);
  if (state.level !== "none") {
    const before = previous && previous.state;
    state.since = before && before.level !== "none" && before.since ? before.since : Date.now();
  }
  return state;
}

// One poll. `previous` is what the last poll stored ({ state, lastModified }).
// Returns { state, places, lastModified, status } or throws with .status on failure.
export async function fetchState(env, previous) {
  const base = apiBase(env);
  const headers = { Authorization: "Bearer " + env.ALERTS_TOKEN, Accept: "application/json" };
  // Only download when something changed (the API answers 304 otherwise).
  if (previous && previous.state && previous.lastModified && previous.rules === RULES_VERSION) {
    headers["If-Modified-Since"] = previous.lastModified;
  }

  const response = await fetch(base + "/v1/alerts/active.json", { headers });
  if (response.status === 304) return { state: previous.state, places: null, lastModified: previous.lastModified, status: 304 };
  if (!response.ok) {
    const error = new Error("alerts.in.ua answered " + response.status);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const oblastUid = env.ALERT_OBLAST_UID || DEFAULT_OBLAST_UID;
  const pattern = env.ALERT_PLACES || DEFAULT_PLACES;
  return {
    state: summarize(data.alerts, oblastUid, pattern),
    places: oblastPlaces(data.alerts, oblastUid, pattern),
    lastModified: response.headers.get("Last-Modified") || null,
    status: response.status,
  };
}
