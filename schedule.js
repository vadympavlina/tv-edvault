// When the TVs show the schedule. Shared by the TV app, the shell, the settings page and the
// Cloudflare Worker.
//
// Settings shape:
//   {
//     "days": { "mon": { "enabled": true, "on": "08:00", "off": "20:00" }, ..., "sun": { ... } },
//     "exceptions": [   // special dates, they win over the week
//       { "from": "2026-12-25", "to": "2026-12-25", "enabled": false, "on": "08:00", "off": "20:00", "note": "Різдво" }
//     ]
//   }
// Plus, kept apart from the saved settings, a manual override that wins over everything:
//   { "mode": "on" | "off", "until": <epoch ms> }
//
// Times of day are wall-clock times in the configured time zone; a "moment" is
// { ms, date: "YYYY-MM-DD", day: 0 = Monday … 6 = Sunday, minutes since midnight }.
(function () {
  "use strict";

  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var DAY_NAMES = {
    mon: "Понеділок",
    tue: "Вівторок",
    wed: "Середа",
    thu: "Четвер",
    fri: "П'ятниця",
    sat: "Субота",
    sun: "Неділя",
  };
  // Accusative form for "у понеділок о 08:00".
  var DAY_NAMES_AT = {
    mon: "у понеділок",
    tue: "у вівторок",
    wed: "у середу",
    thu: "у четвер",
    fri: "у п'ятницю",
    sat: "у суботу",
    sun: "у неділю",
  };
  var MONTHS_GEN = [
    "січня",
    "лютого",
    "березня",
    "квітня",
    "травня",
    "червня",
    "липня",
    "серпня",
    "вересня",
    "жовтня",
    "листопада",
    "грудня",
  ];
  var DEFAULT_ON = "08:00";
  var DEFAULT_OFF = "20:00";
  var MAX_EXCEPTIONS = 100;
  var DAY_MS = 24 * 60 * 60 * 1000;
  // How far ahead to look for the next change (long holidays included).
  var LOOKAHEAD_DAYS = 120;

  // ---------- Clock strings ----------

  function parseClock(value) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
    return h * 60 + min;
  }

  function formatClock(minutes) {
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function isDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  // "2026-12-25" + 3 days -> "2026-12-28" (pure calendar arithmetic, no time zones involved).
  function addDays(date, n) {
    var p = date.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return d.toISOString().slice(0, 10);
  }

  function weekdayOf(date) {
    var p = date.split("-");
    return (new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() + 6) % 7;
  }

  // ---------- Time zones ----------

  var formats = {};

  function formatFor(timeZone) {
    if (!(timeZone in formats)) {
      try {
        formats[timeZone] = new Intl.DateTimeFormat("en-GB", {
          timeZone: timeZone || undefined,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        });
      } catch (e) {
        formats[timeZone] = null; // unknown zone on an old browser: use the device clock
      }
    }
    return formats[timeZone];
  }

  // The moment `ms` as seen on a wall clock in `timeZone`.
  function at(ms, timeZone) {
    var date = new Date(ms);
    var y = date.getFullYear();
    var mo = date.getMonth() + 1;
    var d = date.getDate();
    var h = date.getHours();
    var mi = date.getMinutes();
    var format = formatFor(timeZone);
    if (format && format.formatToParts) {
      format.formatToParts(date).forEach(function (part) {
        var v = Number(part.value);
        if (part.type === "year") y = v;
        else if (part.type === "month") mo = v;
        else if (part.type === "day") d = v;
        else if (part.type === "hour") h = v % 24;
        else if (part.type === "minute") mi = v;
      });
    }
    var iso = y + "-" + (mo < 10 ? "0" : "") + mo + "-" + (d < 10 ? "0" : "") + d;
    return { ms: ms, date: iso, day: weekdayOf(iso), minutes: h * 60 + mi };
  }

  // `offsetMs` corrects a TV whose own clock is wrong (server time minus device time).
  function now(timeZone, offsetMs) {
    return at(Date.now() + (offsetMs || 0), timeZone);
  }

  // Epoch ms of wall-clock `minutes` on `date` in `timeZone` (minutes may be 1440 = next midnight).
  function toMs(date, minutes, timeZone) {
    var p = date.split("-");
    var guess = Date.UTC(+p[0], +p[1] - 1, +p[2]) + minutes * 60000;
    // Shift by the zone's offset at that moment; twice, to settle across a DST change.
    for (var i = 0; i < 2; i++) {
      var seen = at(guess, timeZone);
      var sp = seen.date.split("-");
      var seenAsUtc = Date.UTC(+sp[0], +sp[1] - 1, +sp[2]) + seen.minutes * 60000;
      var wanted = Date.UTC(+p[0], +p[1] - 1, +p[2]) + minutes * 60000;
      guess += wanted - seenAsUtc;
    }
    return guess;
  }

  // ---------- Settings ----------

  function defaults() {
    var days = {};
    DAYS.forEach(function (day) {
      days[day] = { enabled: true, on: DEFAULT_ON, off: DEFAULT_OFF };
    });
    return { days: days, exceptions: [] };
  }

  // One day's rule from raw input; null if the times are broken.
  function cleanRule(d) {
    var on = parseClock(d.on);
    var off = parseClock(d.off);
    if (on === null || off === null || on >= off) return null;
    return { enabled: d.enabled !== false, on: formatClock(on), off: formatClock(off) };
  }

  // Anything missing or broken falls back to the defaults, so a bad file never blanks the TVs.
  function normalize(raw) {
    var result = defaults();
    var days = raw && raw.days;
    if (days && typeof days === "object") {
      DAYS.forEach(function (day) {
        var d = days[day];
        if (!d || typeof d !== "object") return;
        var rule = cleanRule(d);
        result.days[day] = rule || { enabled: false, on: DEFAULT_ON, off: DEFAULT_OFF };
      });
    }
    var list = raw && Array.isArray(raw.exceptions) ? raw.exceptions : [];
    list.slice(0, MAX_EXCEPTIONS).forEach(function (e) {
      if (!e || !isDate(e.from)) return;
      var to = isDate(e.to) && e.to >= e.from ? e.to : e.from;
      var enabled = e.enabled === true;
      var rule = cleanRule({ enabled: true, on: e.on, off: e.off });
      if (enabled && !rule) return; // "different hours" without valid hours means nothing
      result.exceptions.push({
        from: e.from,
        to: to,
        enabled: enabled,
        on: rule ? rule.on : DEFAULT_ON,
        off: rule ? rule.off : DEFAULT_OFF,
        note: typeof e.note === "string" ? e.note.trim().slice(0, 80) : "",
      });
    });
    result.exceptions.sort(function (a, b) {
      return a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
    });
    return result;
  }

  // Drop special dates that ended more than `keepDays` before `today`.
  function pruneExceptions(settings, today, keepDays) {
    var limit = addDays(today, -keepDays);
    settings.exceptions = settings.exceptions.filter(function (e) {
      return e.to >= limit;
    });
    return settings;
  }

  function normalizeOverride(raw) {
    if (!raw || (raw.mode !== "on" && raw.mode !== "off")) return null;
    var until = Number(raw.until);
    if (!isFinite(until) || until <= 0) return null;
    return { mode: raw.mode, until: until };
  }

  // The special date covering `date`, if any; the shortest range wins (most specific).
  function exceptionFor(settings, date) {
    var best = null;
    (settings.exceptions || []).forEach(function (e) {
      if (e.from <= date && date <= e.to) {
        if (!best || daysBetween(e) <= daysBetween(best)) best = e;
      }
    });
    return best;
  }

  function daysBetween(e) {
    return (Date.parse(e.to) - Date.parse(e.from)) / DAY_MS;
  }

  // The rule in force on `date`: { enabled, on, off, exception? }.
  function ruleFor(settings, date) {
    var e = exceptionFor(settings, date);
    if (e) return { enabled: e.enabled, on: e.on, off: e.off, exception: e };
    return settings.days[DAYS[weekdayOf(date)]];
  }

  function activeOverride(settings, moment) {
    var o = settings.override;
    return o && moment.ms < o.until ? o : null;
  }

  // Is the schedule on screen at `moment`?
  function isOn(settings, moment) {
    var o = activeOverride(settings, moment);
    if (o) return o.mode === "on";
    var rule = ruleFor(settings, moment.date);
    return rule.enabled && moment.minutes >= parseClock(rule.on) && moment.minutes < parseClock(rule.off);
  }

  // Epoch ms of the next moment the on/off state flips, or null if it never does in the
  // look-ahead window.
  function nextChange(settings, moment, timeZone) {
    var current = isOn(settings, moment);
    var candidates = [];
    var o = activeOverride(settings, moment);
    if (o) candidates.push(o.until);
    for (var i = 0; i <= LOOKAHEAD_DAYS; i++) {
      var date = addDays(moment.date, i);
      var rule = ruleFor(settings, date);
      if (rule.enabled) {
        candidates.push(toMs(date, parseClock(rule.on), timeZone));
        candidates.push(toMs(date, parseClock(rule.off), timeZone));
      } else {
        candidates.push(toMs(date, 0, timeZone)); // a day off can end an "on" stretch
      }
    }
    candidates.sort(function (a, b) {
      return a - b;
    });
    for (var j = 0; j < candidates.length; j++) {
      var c = candidates[j];
      if (c <= moment.ms) continue;
      if (isOn(settings, at(c, timeZone)) !== current) return c;
    }
    return null;
  }

  // "о 08:00", "завтра о 08:00", "у понеділок о 09:00", "25 грудня о 08:00".
  function describe(ms, moment, timeZone) {
    var target = at(ms, timeZone);
    var clock = "о " + formatClock(target.minutes);
    if (target.date === moment.date) return clock;
    if (target.date === addDays(moment.date, 1)) return "завтра " + clock;
    if (target.date <= addDays(moment.date, 6)) return DAY_NAMES_AT[DAYS[target.day]] + " " + clock;
    return formatDate(target.date) + " " + clock;
  }

  // "25 грудня"
  function formatDate(date) {
    var p = date.split("-");
    return Number(p[2]) + " " + MONTHS_GEN[Number(p[1]) - 1];
  }

  // Kept for the night screen: when the schedule comes back, as text, or null.
  function nextStart(settings, moment, timeZone) {
    if (isOn(settings, moment)) return null;
    var ms = nextChange(settings, moment, timeZone);
    return ms === null ? null : describe(ms, moment, timeZone);
  }

  // Also loaded by the Cloudflare Worker (worker/), where there is no `window`.
  (typeof window !== "undefined" ? window : globalThis).TVSchedule = {
    DAYS: DAYS,
    DAY_NAMES: DAY_NAMES,
    parseClock: parseClock,
    formatClock: formatClock,
    formatDate: formatDate,
    isDate: isDate,
    addDays: addDays,
    at: at,
    now: now,
    toMs: toMs,
    defaults: defaults,
    normalize: normalize,
    normalizeOverride: normalizeOverride,
    pruneExceptions: pruneExceptions,
    ruleFor: ruleFor,
    isOn: isOn,
    nextChange: nextChange,
    nextStart: nextStart,
    describe: describe,
  };
})();
