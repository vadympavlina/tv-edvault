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
// Location titles that count as "our place" (besides the whole oblast).
export const DEFAULT_PLACES = "^(Рівненський район|(м\\. )?Рівне( .*)?|Рівненська (міська |територіальна )*громада.*)$";

// Does this alert cover our place?
export function coversUs(alert, oblastUid, places) {
  if (!alert || String(alert.location_oblast_uid || "") !== String(oblastUid)) {
    // An oblast-wide alert may carry its uid only in location_uid.
    if (!(alert && alert.location_type === "oblast" && String(alert.location_uid) === String(oblastUid))) return false;
  }
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

export function sameState(a, b) {
  return (
    !!a && !!b && a.level === b.level && (a.kind || null) === (b.kind || null) && (a.since || null) === (b.since || null)
  );
}

// One poll. `previous` is what the last poll stored ({ state, lastModified }).
// Returns { state, lastModified, status } or throws with .status on failure.
export async function fetchState(env, previous) {
  const base = String(env.ALERTS_API_URL || "https://api.alerts.in.ua").replace(/\/+$/, "");
  const headers = { Authorization: "Bearer " + env.ALERTS_TOKEN, Accept: "application/json" };
  // Only download when something changed (the API answers 304 otherwise).
  if (previous && previous.state && previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;

  const response = await fetch(base + "/v1/alerts/active.json", { headers });
  if (response.status === 304) return { state: previous.state, lastModified: previous.lastModified, status: 304 };
  if (!response.ok) {
    const error = new Error("alerts.in.ua answered " + response.status);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return {
    state: summarize(data.alerts, env.ALERT_OBLAST_UID || DEFAULT_OBLAST_UID, env.ALERT_PLACES || DEFAULT_PLACES),
    lastModified: response.headers.get("Last-Modified") || null,
    status: response.status,
  };
}
