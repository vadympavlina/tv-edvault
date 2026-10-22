// Weekly on/off hours shared by the TV page and the settings page.
// settings.json shape:
//   { "days": { "mon": { "enabled": true, "on": "08:00", "off": "20:00" }, ..., "sun": { "enabled": false, ... } } }
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
  var DEFAULT_ON = "08:00";
  var DEFAULT_OFF = "20:00";

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

  function defaults() {
    var days = {};
    DAYS.forEach(function (day) {
      days[day] = { enabled: true, on: DEFAULT_ON, off: DEFAULT_OFF };
    });
    return { days: days };
  }

  // Anything missing or broken falls back to the defaults, so a bad file never blanks the TVs.
  function normalize(raw) {
    var result = defaults();
    var days = raw && raw.days;
    if (!days || typeof days !== "object") return result;
    DAYS.forEach(function (day) {
      var d = days[day];
      if (!d || typeof d !== "object") return;
      var on = parseClock(d.on);
      var off = parseClock(d.off);
      var valid = on !== null && off !== null && on < off;
      result.days[day] = {
        enabled: d.enabled !== false && valid,
        on: valid ? formatClock(on) : DEFAULT_ON,
        off: valid ? formatClock(off) : DEFAULT_OFF,
      };
    });
    return result;
  }

  // dayIndex: 0 = Monday … 6 = Sunday.
  function isOn(settings, dayIndex, minutes) {
    var d = settings.days[DAYS[dayIndex]];
    return d.enabled && minutes >= parseClock(d.on) && minutes < parseClock(d.off);
  }

  // Human text for when the schedule comes back, e.g. "о 08:00", "завтра о 08:00", "у понеділок о 09:00".
  function nextStart(settings, dayIndex, minutes) {
    for (var i = 0; i < 8; i++) {
      var idx = (dayIndex + i) % 7;
      var d = settings.days[DAYS[idx]];
      if (!d.enabled) continue;
      if (i === 0 && minutes >= parseClock(d.on)) continue;
      var when = i === 0 ? "" : i === 1 ? "завтра " : DAY_NAMES_AT[DAYS[idx]] + " ";
      return when + "о " + d.on;
    }
    return null;
  }

  var WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  var formats = {};

  // Current { day: 0 = Monday … 6 = Sunday, minutes since midnight } in the given time zone.
  // Falls back to the device clock if the browser does not know the zone.
  function now(timeZone) {
    var date = new Date();
    var day = (date.getDay() + 6) % 7;
    var h = date.getHours();
    var m = date.getMinutes();
    if (!(timeZone in formats)) {
      try {
        formats[timeZone] = new Intl.DateTimeFormat("en-GB", {
          timeZone: timeZone || undefined,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
      } catch (e) {
        formats[timeZone] = null;
      }
    }
    var format = formats[timeZone];
    if (format && format.formatToParts) {
      format.formatToParts(date).forEach(function (part) {
        if (part.type === "weekday" && part.value in WEEKDAYS) day = WEEKDAYS[part.value];
        if (part.type === "hour") h = Number(part.value) % 24;
        if (part.type === "minute") m = Number(part.value);
      });
    }
    return { day: day, minutes: h * 60 + m };
  }

  window.TVSchedule = {
    now: now,
    DAYS: DAYS,
    DAY_NAMES: DAY_NAMES,
    parseClock: parseClock,
    formatClock: formatClock,
    defaults: defaults,
    normalize: normalize,
    isOn: isOn,
    nextStart: nextStart,
  };
})();
