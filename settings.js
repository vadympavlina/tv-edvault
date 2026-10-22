// Settings page for the TV schedule screens.
//
// Saved settings (week + special dates) are edited as a draft and sent with "Зберегти"; the
// manual "now" override, TV names and restarts apply at once. A WebSocket to the settings
// server keeps TV status and changes made elsewhere live; without it the page polls.
(function () {
  "use strict";

  var SESSION_KEY = "tv-schedule:session";
  var TAB_KEY = "tv-schedule:tab";
  var CLOCK_MS = 30 * 1000;
  var FALLBACK_REFRESH_MS = 60 * 1000;
  var HIDDEN_DISCONNECT_MS = 2 * 60 * 1000;
  var TOAST_MS = 5000;
  var STEP = 15; // minutes
  var DAY_MIN = 24 * 60;
  var SHORT_DAYS = { mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд" };
  var MONTHS = [
    "Січень",
    "Лютий",
    "Березень",
    "Квітень",
    "Травень",
    "Червень",
    "Липень",
    "Серпень",
    "Вересень",
    "Жовтень",
    "Листопад",
    "Грудень",
  ];

  var Schedule = window.TVSchedule;
  var config = window.TV_CONFIG || {};
  var tz = config.timeZone;
  var apiUrl = String(new URLSearchParams(location.search).get("api") || window.TV_API_URL || "").replace(/\/+$/, "");

  function $(id) {
    return document.getElementById(id);
  }

  var state = {
    saved: Schedule.defaults(), // what the TVs use
    draft: Schedule.defaults(), // what the form shows
    override: null,
    screens: [],
    history: [],
    clockOffset: 0,
    saving: false,
    loaded: false,
    tab: "week",
    calMonth: null, // "YYYY-MM"
    editing: -1, // index of the special date in the form, -1 = new
  };
  var rows = {};
  var refreshTimer = null;
  var toastTimer = null;
  var live = { socket: null, attempt: 0, retry: null, ping: null, pong: null };

  // ---------- Helpers ----------

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function moment() {
    return Schedule.now(tz, state.clockOffset);
  }

  function effective(settings) {
    return { days: settings.days, exceptions: settings.exceptions, override: state.override };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function tvCount(n) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    var word =
      mod10 === 1 && mod100 !== 11
        ? "телевізор"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "телевізори"
        : "телевізорів";
    return n + " " + word;
  }

  function ago(ms) {
    var min = Math.round(ms / 60000);
    if (min < 1) return "щойно";
    if (min < 60) return min + " хв тому";
    var h = Math.round(min / 60);
    if (h < 24) return h + " год тому";
    return Math.round(h / 24) + " дн тому";
  }

  function duration(ms) {
    var min = Math.floor(ms / 60000);
    if (min < 1) return "менше хвилини";
    if (min < 60) return min + " хв";
    var h = Math.floor(min / 60);
    if (h < 24) return h + " год" + (min % 60 ? " " + (min % 60) + " хв" : "");
    return Math.floor(h / 24) + " дн " + (h % 24) + " год";
  }

  // "18:30" today, "опівночі", otherwise "завтра о 08:00" and so on.
  function whenText(ms, t) {
    var target = Schedule.at(ms, tz);
    if (target.minutes === 0 && target.date === Schedule.addDays(t.date, 1)) return "опівночі";
    var text = Schedule.describe(ms, t, tz);
    return target.date === t.date ? text.replace(/^о /, "") : text;
  }

  function rangeText(e) {
    var year = function (d) {
      return d.slice(0, 4);
    };
    if (e.from === e.to) return Schedule.formatDate(e.from) + " " + year(e.from);
    return (
      Schedule.formatDate(e.from) +
      (year(e.from) === year(e.to) ? "" : " " + year(e.from)) +
      " – " +
      Schedule.formatDate(e.to) +
      " " +
      year(e.to)
    );
  }

  // "14–18:30" for the narrow calendar cells.
  function compactHours(rule) {
    return rule.on.replace(/:00$/, "") + "–" + rule.off.replace(/:00$/, "");
  }

  function hoursText(rule) {
    return rule.enabled ? rule.on + "–" + rule.off : "вимкнено";
  }

  function summary(settings) {
    var week = Schedule.DAYS.map(function (day) {
      var d = settings.days[day];
      return SHORT_DAYS[day] + " " + (d.enabled ? d.on + "–" + d.off : "вимк.");
    }).join(" · ");
    var n = (settings.exceptions || []).length;
    return n ? week + " · особливих днів: " + n : week;
  }

  function toast(text, kind) {
    var node = $("toast");
    node.textContent = text;
    node.className = "toast" + (kind ? " is-" + kind : "");
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.hidden = true;
    }, kind === "error" ? TOAST_MS * 2 : TOAST_MS);
  }

  // ---------- Session & views ----------

  function session() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      return s && s.expires > Date.now() ? s : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(value) {
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  function show(view) {
    $("login-view").hidden = view !== "login";
    $("setup-view").hidden = view !== "setup";
    $("app-view").hidden = view !== "app";
  }

  function signOut(message) {
    clearInterval(refreshTimer);
    stopLive();
    setSession(null);
    show("login");
    $("login-error").textContent = message || "";
    $("password").focus();
  }

  // ---------- Server ----------

  function api(method, path, body) {
    var s = session();
    var headers = { "Content-Type": "application/json" };
    if (s) headers.Authorization = "Bearer " + s.token;
    return fetch(apiUrl + path, {
      method: method,
      cache: "no-store",
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (res.ok) return data;
          var error = new Error(data.error || "HTTP " + res.status);
          error.status = res.status;
          error.code = data.error;
          throw error;
        });
    });
  }

  function handleError(error, message) {
    if (error.status === 401) return signOut("Сесія завершилась, увійдіть ще раз.");
    toast(message + (navigator.onLine === false ? " Немає інтернету." : " Спробуйте ще раз."), "error");
  }

  // ---------- Draft ----------

  function isDirty() {
    return JSON.stringify(state.draft) !== JSON.stringify(state.saved);
  }

  function weekValid() {
    return Schedule.DAYS.every(function (day) {
      var d = state.draft.days[day];
      return !d.enabled || Schedule.parseClock(d.on) < Schedule.parseClock(d.off);
    });
  }

  // Something in the draft changed: redraw what depends on it.
  function changed() {
    renderWeek();
    renderNow();
    renderDates();
    renderSavebar();
  }

  function renderSavebar() {
    var dirty = state.loaded && isDirty();
    $("savebar").hidden = !dirty;
    document.body.classList.toggle("has-savebar", dirty);
    var valid = weekValid();
    $("save").disabled = state.saving || !valid;
    $("savebar-text").textContent = !valid
      ? "Виправте час: вимкнення має бути пізніше за увімкнення"
      : state.saving
      ? "Збереження…"
      : "Є незбережені зміни";
  }

  // New settings from the server. The draft follows unless it holds unsaved edits.
  function receiveSettings(settings) {
    var hadEdits = state.loaded && isDirty();
    state.saved = settings;
    if (!hadEdits) state.draft = clone(settings);
    state.loaded = true;
    changed();
  }

  // ---------- Now ----------

  function renderNow() {
    var t = moment();
    var settings = effective(state.draft);
    var on = Schedule.isOn(settings, t);
    var change = Schedule.nextChange(settings, t, tz);
    var active = state.override && state.override.until > t.ms ? state.override : null;

    $("now-card").classList.toggle("is-on", on);
    $("now-title").textContent = on ? "Розклад" + (change ? " · до " + whenText(change, t) : "") : "Чорний екран";
    if (on) {
      var after = change ? Schedule.nextChange(settings, Schedule.at(change, tz), tz) : null;
      $("now-sub").textContent = after ? "Далі чорний екран, розклад знову " + Schedule.describe(after, t, tz) : "";
    } else {
      $("now-sub").textContent = change
        ? "Розклад увімкнеться " + Schedule.describe(change, t, tz)
        : "Увімкнень попереду немає";
    }

    var rule = Schedule.ruleFor(state.draft, t.date);
    $("now-exception").hidden = !rule.exception;
    if (rule.exception) {
      $("now-exception").textContent =
        "Сьогодні особливий день" + (rule.exception.note ? ": " + rule.exception.note : "") + " · " + hoursText(rule.exception);
    }

    $("override-active").hidden = !active;
    if (active) {
      $("override-text").textContent = (active.mode === "on" ? "Увімкнено вручну" : "Вимкнено вручну") + " до " + whenText(active.until, t);
    }
    $("override-off").hidden = !on;
    $("override-on").hidden = on;
  }

  function overrideUntil(span) {
    var t = moment();
    if (span === "1h") return t.ms + 60 * 60 * 1000;
    if (span === "2h") return t.ms + 2 * 60 * 60 * 1000;
    if (span === "4h") return t.ms + 4 * 60 * 60 * 1000;
    if (span === "day") return Schedule.toMs(t.date, DAY_MIN, tz);
    // "next": until the saved schedule itself switches on again after its current stretch.
    var base = { days: state.saved.days, exceptions: state.saved.exceptions };
    var from = t;
    if (Schedule.isOn(base, t)) {
      var end = Schedule.nextChange(base, t, tz);
      if (end === null) return null;
      from = Schedule.at(end, tz);
    }
    return Schedule.nextChange(base, from, tz);
  }

  function setOverride(mode, span, button) {
    var body = { mode: null };
    if (mode) {
      var until = overrideUntil(span);
      if (!until) return toast("За розкладом увімкнень попереду немає, оберіть інший варіант.", "error");
      body = { mode: mode, until: until };
    }
    if (button) button.disabled = true;
    api("PUT", "/override", body)
      .then(function (data) {
        state.override = Schedule.normalizeOverride(data.override);
        renderNow();
        var where = data.delivered ? " Надіслано на " + tvCount(data.delivered) + "." : "";
        toast((state.override ? "Готово." : "Повернули звичайний розклад.") + where, "ok");
      })
      .catch(function (error) {
        handleError(error, "Не вдалося застосувати.");
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  // ---------- Week ----------

  // Selects instead of <input type="time">: the native picker shows AM/PM on some systems.
  function addTimeOptions(select, from, to) {
    for (var m = from; m <= to; m += STEP) {
      var label = Schedule.formatClock(m);
      select.add(new Option(label, label));
    }
  }

  // A time saved earlier may sit between steps; keep it selectable.
  function setTime(select, value) {
    var exists = Array.prototype.some.call(select.options, function (o) {
      return o.value === value;
    });
    if (!exists) {
      var minutes = Schedule.parseClock(value);
      var before = Array.prototype.find.call(select.options, function (o) {
        return Schedule.parseClock(o.value) > minutes;
      });
      select.add(new Option(value, value), before || null);
    }
    select.value = value;
  }

  function buildWeek() {
    Schedule.DAYS.forEach(function (day) {
      var node = $("day-row").content.firstElementChild.cloneNode(true);
      var row = {
        node: node,
        enabled: node.querySelector(".day-enabled"),
        on: node.querySelector(".day-on"),
        off: node.querySelector(".day-off"),
        track: node.querySelector(".track"),
        bar: node.querySelector(".bar"),
        label: node.querySelector(".bar-label"),
        now: node.querySelector(".now-line"),
        note: node.querySelector(".day-note"),
        error: node.querySelector(".day-error"),
      };
      node.querySelector(".day-name").textContent = Schedule.DAY_NAMES[day];
      row.enabled.setAttribute("aria-label", Schedule.DAY_NAMES[day] + ": показувати розклад");
      addTimeOptions(row.on, 0, DAY_MIN - STEP);
      addTimeOptions(row.off, STEP, DAY_MIN);

      row.enabled.addEventListener("change", function () {
        state.draft.days[day].enabled = row.enabled.checked;
        changed();
      });
      row.on.addEventListener("change", function () {
        state.draft.days[day].on = row.on.value;
        changed();
      });
      row.off.addEventListener("change", function () {
        state.draft.days[day].off = row.off.value;
        changed();
      });
      node.querySelector(".copy").addEventListener("click", function () {
        copyToAll(day);
      });
      enableDrag(day, row);

      rows[day] = row;
      $("week").appendChild(node);
    });
  }

  // Drag the bar to move the window, its ends to change on/off; snaps to 15 minutes.
  function enableDrag(day, row) {
    var drag = null;

    function minutesAt(clientX) {
      var box = row.track.getBoundingClientRect();
      var ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      return Math.round((ratio * DAY_MIN) / STEP) * STEP;
    }

    row.track.addEventListener("pointerdown", function (event) {
      var d = state.draft.days[day];
      if (event.button !== 0) return;
      var at = minutesAt(event.clientX);
      var on = Schedule.parseClock(d.on);
      var off = Schedule.parseClock(d.off);
      var target = event.target;
      if (!d.enabled) {
        // Click on an empty track of a day off: switch it on around that time.
        d.enabled = true;
        on = Math.min(at, DAY_MIN - 4 * 60);
        off = on + 4 * 60;
        d.on = Schedule.formatClock(on);
        d.off = Schedule.formatClock(off);
        changed();
        return;
      }
      var mode = target.classList.contains("handle-start")
        ? "start"
        : target.classList.contains("handle-end")
        ? "end"
        : target.closest(".bar")
        ? "move"
        : Math.abs(at - on) < Math.abs(at - off)
        ? "start"
        : "end";
      drag = { mode: mode, startAt: at, on: on, off: off };
      row.track.setPointerCapture(event.pointerId);
      row.node.classList.add("is-dragging");
      event.preventDefault();
      apply(at);
    });

    function apply(at) {
      var d = state.draft.days[day];
      var on = drag.on;
      var off = drag.off;
      if (drag.mode === "start") on = Math.min(at, off - STEP);
      else if (drag.mode === "end") off = Math.max(at, on + STEP);
      else {
        var shift = at - drag.startAt;
        shift = Math.max(-on, Math.min(DAY_MIN - off, shift));
        on += shift;
        off += shift;
      }
      d.on = Schedule.formatClock(on);
      d.off = Schedule.formatClock(off);
      changed();
    }

    row.track.addEventListener("pointermove", function (event) {
      if (drag) apply(minutesAt(event.clientX));
    });
    function end() {
      drag = null;
      row.node.classList.remove("is-dragging");
    }
    row.track.addEventListener("pointerup", end);
    row.track.addEventListener("pointercancel", end);
  }

  function renderWeek() {
    var t = moment();
    // This week's dates, so a special date in it can be pointed out on its weekday row.
    var monday = Schedule.addDays(t.date, -t.day);
    Schedule.DAYS.forEach(function (day, index) {
      var d = state.draft.days[day];
      var row = rows[day];
      var on = Schedule.parseClock(d.on);
      var off = Schedule.parseClock(d.off);
      var valid = on < off;

      row.enabled.checked = d.enabled;
      setTime(row.on, d.on);
      setTime(row.off, d.off);
      row.node.classList.toggle("is-off", !d.enabled);
      row.node.classList.toggle("is-invalid", d.enabled && !valid);
      row.node.classList.toggle("is-today", index === t.day);
      row.error.hidden = !d.enabled || valid;

      row.bar.hidden = !d.enabled || !valid;
      row.bar.style.left = (on / DAY_MIN) * 100 + "%";
      row.bar.style.width = ((off - on) / DAY_MIN) * 100 + "%";
      row.label.textContent = d.on + "–" + d.off;
      row.bar.classList.toggle("is-narrow", off - on < 150);

      row.now.hidden = index !== t.day;
      row.now.style.left = (t.minutes / DAY_MIN) * 100 + "%";

      var date = Schedule.addDays(monday, index);
      var rule = Schedule.ruleFor(state.draft, date);
      row.note.hidden = !rule.exception;
      if (rule.exception) {
        row.note.textContent =
          "Цього тижня " + Schedule.formatDate(date) + ": " + (rule.exception.note || "особливий день") + " · " + hoursText(rule.exception);
      }
    });
  }

  function copyToAll(source) {
    var from = state.draft.days[source];
    Schedule.DAYS.forEach(function (day) {
      if (day !== source) state.draft.days[day] = { enabled: true, on: from.on, off: from.off };
    });
    changed();
    toast("Час " + from.on + "–" + from.off + " скопійовано на всі дні. Не забудьте зберегти.");
  }

  // ---------- Special dates ----------

  function renderDates() {
    var count = state.draft.exceptions.filter(function (e) {
      return e.to >= moment().date;
    }).length;
    $("dates-count").hidden = !count;
    $("dates-count").textContent = count;
    renderCalendar();
    renderExceptions();
  }

  function renderCalendar() {
    var t = moment();
    if (!state.calMonth) state.calMonth = t.date.slice(0, 7);
    var parts = state.calMonth.split("-");
    var first = state.calMonth + "-01";
    var start = Schedule.addDays(first, -((new Date(Date.UTC(+parts[0], +parts[1] - 1, 1)).getUTCDay() + 6) % 7));
    var grid = $("cal-grid");
    $("cal-title").textContent = MONTHS[+parts[1] - 1] + " " + parts[0];
    grid.textContent = "";
    Schedule.DAYS.forEach(function (day) {
      grid.appendChild(el("span", "cal-wd", SHORT_DAYS[day]));
    });
    var editing = state.editing >= 0 ? state.draft.exceptions[state.editing] : null;
    for (var i = 0; i < 42; i++) {
      var date = Schedule.addDays(start, i);
      if (i >= 35 && date.slice(0, 7) !== state.calMonth) break; // no empty sixth row
      var rule = Schedule.ruleFor(state.draft, date);
      var cell = el("button", "cal-day");
      cell.type = "button";
      cell.dataset.date = date;
      if (date.slice(0, 7) !== state.calMonth) cell.classList.add("is-outside");
      if (date === t.date) cell.classList.add("is-today");
      if (date < t.date) cell.classList.add("is-past");
      if (rule.exception) cell.classList.add("is-exception");
      else if (!rule.enabled) cell.classList.add("is-off");
      if (editing && editing.from <= date && date <= editing.to) cell.classList.add("is-selected");
      cell.appendChild(el("span", "cal-num", String(Number(date.slice(8)))));
      cell.appendChild(el("span", "cal-hours", rule.enabled ? compactHours(rule) : "—"));
      cell.title =
        Schedule.formatDate(date) + ": " + hoursText(rule) + (rule.exception && rule.exception.note ? " · " + rule.exception.note : "");
      grid.appendChild(cell);
    }
  }

  function renderExceptions() {
    var list = $("exceptions");
    var today = moment().date;
    list.textContent = "";
    var items = state.draft.exceptions
      .map(function (e, index) {
        return { e: e, index: index };
      })
      // Upcoming first, then what already ended (newest first).
      .sort(function (a, b) {
        var pa = a.e.to < today;
        var pb = b.e.to < today;
        if (pa !== pb) return pa ? 1 : -1;
        return pa ? (a.e.to < b.e.to ? 1 : -1) : a.e.from < b.e.from ? -1 : 1;
      });
    $("exceptions-empty").hidden = items.length > 0;
    items.forEach(function (item) {
      var e = item.e;
      var past = e.to < today;
      var current = e.from <= today && today <= e.to;
      var li = el("li", "exception" + (past ? " is-past" : "") + (item.index === state.editing ? " is-editing" : ""));
      var text = el("button", "exception-text");
      text.type = "button";
      text.title = "Змінити";
      var when = el("span", "exception-when", rangeText(e));
      if (current) when.appendChild(el("span", "badge badge-current", "діє зараз"));
      else if (past) when.appendChild(el("span", "badge", "минуло"));
      text.appendChild(when);
      text.appendChild(el("span", "exception-what", hoursText(e) + (e.note ? " · " + e.note : "")));
      text.addEventListener("click", function () {
        openExceptionForm(item.index);
      });
      var remove = el("button", "icon-btn danger", "✕");
      remove.type = "button";
      remove.title = "Видалити";
      remove.setAttribute("aria-label", "Видалити " + rangeText(e));
      remove.addEventListener("click", function () {
        state.draft.exceptions.splice(item.index, 1);
        if (state.editing === item.index) closeExceptionForm();
        else if (state.editing > item.index) state.editing -= 1;
        changed();
        toast("Видалено. Натисніть «Зберегти», щоб застосувати.");
      });
      li.appendChild(text);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  function exceptionMode() {
    var checked = document.querySelector('input[name="exception-mode"]:checked');
    return checked ? checked.value : "off";
  }

  function setExceptionMode(mode) {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="exception-mode"]'), function (input) {
      input.checked = input.value === mode;
    });
    $("exception-hours").hidden = mode !== "hours";
  }

  // index -1: a new special date (optionally starting on `date`).
  function openExceptionForm(index, date) {
    var e = index >= 0 ? state.draft.exceptions[index] : null;
    state.editing = index;
    $("exception-form").hidden = false;
    $("exception-new").hidden = true;
    $("exception-form-title").textContent = e ? "Змінити особливий день" : "Новий особливий день";
    $("exception-submit").textContent = e ? "Оновити" : "Додати";
    $("exception-from").value = e ? e.from : date || moment().date;
    $("exception-to").value = e && e.to !== e.from ? e.to : "";
    $("exception-to").min = $("exception-from").value;
    setExceptionMode(e && e.enabled ? "hours" : "off");
    setTime($("exception-on"), e ? e.on : "10:00");
    setTime($("exception-off"), e ? e.off : "16:00");
    $("exception-note").value = e ? e.note : "";
    $("exception-error").textContent = "";
    if (e) state.calMonth = e.from.slice(0, 7);
    renderDates();
    $("exception-form").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function closeExceptionForm() {
    state.editing = -1;
    $("exception-form").hidden = true;
    $("exception-new").hidden = false;
    renderDates();
  }

  function submitException(event) {
    event.preventDefault();
    var error = $("exception-error");
    var from = $("exception-from").value;
    var to = $("exception-to").value || from;
    var mode = exceptionMode();
    var on = $("exception-on").value;
    var off = $("exception-off").value;
    error.textContent = "";
    if (!Schedule.isDate(from)) return (error.textContent = "Вкажіть дату.");
    if (!Schedule.isDate(to) || to < from) return (error.textContent = "Дата «по» має бути не раніше за «з».");
    if (mode === "hours" && Schedule.parseClock(on) >= Schedule.parseClock(off)) {
      return (error.textContent = "Час вимкнення має бути пізніше за час увімкнення.");
    }
    var entry = { from: from, to: to, enabled: mode === "hours", on: on, off: off, note: $("exception-note").value };
    var list = state.draft.exceptions.slice();
    var updating = state.editing >= 0;
    if (updating) list[state.editing] = entry;
    else list.push(entry);
    state.draft.exceptions = Schedule.normalize({ days: state.draft.days, exceptions: list }).exceptions;
    closeExceptionForm();
    changed();
    toast((updating ? "Оновлено." : "Додано.") + " Натисніть «Зберегти», щоб надіслати на телевізори.");
  }

  function buildDates() {
    addTimeOptions($("exception-on"), 0, DAY_MIN - STEP);
    addTimeOptions($("exception-off"), STEP, DAY_MIN);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="exception-mode"]'), function (input) {
      input.addEventListener("change", function () {
        setExceptionMode(exceptionMode());
      });
    });
    $("exception-from").addEventListener("change", function () {
      var to = $("exception-to");
      if (to.value && to.value < this.value) to.value = this.value;
      to.min = this.value;
    });
    $("exception-form").addEventListener("submit", submitException);
    $("exception-cancel").addEventListener("click", closeExceptionForm);
    $("exception-new").addEventListener("click", function () {
      openExceptionForm(-1);
    });
    $("cal-prev").addEventListener("click", function () {
      shiftMonth(-1);
    });
    $("cal-next").addEventListener("click", function () {
      shiftMonth(1);
    });
    $("cal-grid").addEventListener("click", function (event) {
      var cell = event.target.closest(".cal-day");
      if (!cell) return;
      var date = cell.dataset.date;
      var index = -1;
      state.draft.exceptions.forEach(function (e, i) {
        if (e.from <= date && date <= e.to && index === -1) index = i;
      });
      // An existing special date opens for editing; another day starts a new one there.
      openExceptionForm(index, date);
    });
  }

  function shiftMonth(n) {
    var p = state.calMonth.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1 + n, 1));
    state.calMonth = d.toISOString().slice(0, 7);
    renderCalendar();
  }

  // ---------- Screens ----------

  function screenTitle(screen) {
    return screen.label || screen.name || "ТВ " + screen.id.slice(0, 4).toUpperCase();
  }

  // Problems first: offline, then stuck schedules, then the rest by name.
  function sortedScreens() {
    var rank = function (s) {
      return !s.online ? 0 : s.stale ? 1 : 2;
    };
    return state.screens.slice().sort(function (a, b) {
      return rank(a) - rank(b) || screenTitle(a).localeCompare(screenTitle(b), "uk");
    });
  }

  // `brief`: only what the TV shows, for the short list at the top.
  function screenDetails(screen, now, brief) {
    if (!screen.online) return "не на зв'язку, востаннє " + ago(now - screen.lastSeen);
    var parts = [];
    if (screen.state === "schedule") parts.push(screen.stale ? "розклад давно не оновлювався" : "показує розклад");
    else if (screen.state === "night") parts.push("чорний екран");
    else if (screen.state === "splash") parts.push("заставка, розклад не запущено");
    if (brief) return parts.join(" · ");
    if (screen.transport === "http") parts.push("без постійного з'єднання");
    else if (screen.connectedAt) parts.push("на зв'язку " + duration(now - screen.connectedAt));
    return parts.join(" · ");
  }

  function screenClass(screen) {
    return "screen" + (screen.online ? " is-online" : "") + (screen.online && screen.stale ? " is-warning" : "");
  }

  function renderScreens() {
    var now = Date.now() + state.clockOffset;
    var list = sortedScreens();
    var online = list.filter(function (s) {
      return s.online;
    }).length;
    var problems = list.length - list.filter(function (s) {
      return s.online && !s.stale;
    }).length;

    $("online-count").textContent = list.length ? online + " з " + list.length + " онлайн" : "немає ТВ";
    $("online-pill").className = "pill" + (list.length && !problems ? " is-ok" : problems ? " is-warning" : "");
    $("screens-count").hidden = !list.length;
    $("screens-count").textContent = online + "/" + list.length;

    // At a glance: up to four, problems first.
    var glance = $("glance-list");
    glance.textContent = "";
    $("glance-empty").hidden = list.length > 0;
    $("glance-all").hidden = list.length <= 4;
    $("glance-all").textContent = "Усі телевізори (" + list.length + ") →";
    list.slice(0, 4).forEach(function (screen) {
      var li = el("li", screenClass(screen));
      li.appendChild(el("span", "screen-dot"));
      var main = el("div", "screen-main");
      main.appendChild(el("span", "screen-name", screenTitle(screen)));
      main.appendChild(el("span", "screen-meta", screenDetails(screen, now, true)));
      li.appendChild(main);
      if (screen.online && screen.transport !== "http") li.appendChild(reloadButton(screen, true));
      glance.appendChild(li);
    });

    // Full list
    var full = $("screens");
    full.textContent = "";
    $("screens-empty").hidden = list.length > 0;
    list.forEach(function (screen) {
      var li = el("li", screenClass(screen));
      li.appendChild(el("span", "screen-dot"));
      var main = el("div", "screen-main");
      var name = el("span", "screen-name", screenTitle(screen));
      main.appendChild(name);
      var meta = screenDetails(screen, now) + (screen.size ? " · " + screen.size : "");
      main.appendChild(el("span", "screen-meta", meta));
      li.appendChild(main);

      var actions = el("div", "screen-actions");
      var rename = el("button", "btn btn-small btn-ghost", "Перейменувати");
      rename.type = "button";
      rename.addEventListener("click", function () {
        startRename(screen, li, name);
      });
      actions.appendChild(rename);
      if (screen.online && screen.transport !== "http") actions.appendChild(reloadButton(screen, false));
      if (!screen.online) {
        var forget = el("button", "btn btn-small btn-ghost", "Прибрати");
        forget.type = "button";
        forget.title = "Прибрати зі списку. Якщо цей ТВ знову вийде на зв'язок, він з'явиться сам.";
        forget.addEventListener("click", function () {
          forgetScreen(screen, forget);
        });
        actions.appendChild(forget);
      }
      li.appendChild(actions);
      full.appendChild(li);
    });
  }

  function reloadButton(screen, compact) {
    var button = el("button", compact ? "icon-btn" : "btn btn-small btn-ghost", compact ? "⟳" : "Перезавантажити");
    button.type = "button";
    button.title = "Перезавантажити «" + screenTitle(screen) + "»";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", function () {
      button.disabled = true;
      api("POST", "/screens/reload", { id: screen.id })
        .then(function (data) {
          toast(data.delivered ? "«" + screenTitle(screen) + "» перезавантажується." : "Цей ТВ зараз не на зв'язку.", data.delivered ? "ok" : "");
        })
        .catch(function (error) {
          handleError(error, "Не вдалося перезавантажити.");
        })
        .then(function () {
          button.disabled = false;
        });
    });
    return button;
  }

  function startRename(screen, li, nameNode) {
    var form = el("form", "rename");
    var input = el("input");
    input.type = "text";
    input.maxLength = 60;
    input.value = screen.label || screen.name || "";
    input.placeholder = "Наприклад: Хол 1 поверх";
    input.setAttribute("aria-label", "Нова назва");
    var ok = el("button", "btn btn-small btn-primary", "Зберегти");
    ok.type = "submit";
    var cancel = el("button", "btn btn-small btn-ghost", "Скасувати");
    cancel.type = "button";
    form.appendChild(input);
    form.appendChild(ok);
    form.appendChild(cancel);
    nameNode.replaceWith(form);
    li.classList.add("is-renaming");
    input.focus();
    input.select();
    cancel.addEventListener("click", renderScreens);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      ok.disabled = true;
      api("POST", "/screens/rename", { id: screen.id, label: input.value })
        .then(function (data) {
          state.screens = data.screens || state.screens;
          renderScreens();
          toast("Назву змінено.", "ok");
        })
        .catch(function (error) {
          ok.disabled = false;
          handleError(error, "Не вдалося перейменувати.");
        });
    });
  }

  function forgetScreen(screen, button) {
    if (!window.confirm("Прибрати «" + screenTitle(screen) + "» зі списку?")) return;
    button.disabled = true;
    api("POST", "/screens/forget", { id: screen.id })
      .then(function (data) {
        state.screens = data.screens || [];
        renderScreens();
      })
      .catch(function (error) {
        button.disabled = false;
        handleError(error, error.code === "screen_online" ? "Цей телевізор знову на зв'язку." : "Не вдалося прибрати телевізор.");
      });
  }

  function reloadAll() {
    if (!window.confirm("Перезавантажити сторінку на всіх телевізорах?")) return;
    var button = $("reload-all");
    button.disabled = true;
    api("POST", "/reload")
      .then(function (data) {
        toast(
          data.delivered
            ? "Перезавантажуємо " + tvCount(data.delivered) + "."
            : "Команду збережено. Телевізори перезавантажаться, щойно вийдуть на зв'язок.",
          "ok"
        );
      })
      .catch(function (error) {
        handleError(error, "Не вдалося надіслати команду.");
      })
      .then(function () {
        button.disabled = false;
      });
  }

  // ---------- History ----------

  function formatStamp(ms) {
    try {
      return new Intl.DateTimeFormat("uk-UA", {
        timeZone: tz,
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderHistory() {
    var list = $("history");
    list.textContent = "";
    $("history-empty").hidden = state.history.length > 0;
    state.history.slice(0, 15).forEach(function (entry, index) {
      var li = el("li", "history-item");
      var text = el("div", "history-text");
      text.appendChild(el("span", "history-when", formatStamp(entry.at) + (index === 0 ? " · зараз діє" : "")));
      text.appendChild(el("span", "history-what", summary(entry.settings)));
      li.appendChild(text);
      if (index > 0) {
        var restore = el("button", "btn btn-small btn-ghost", "Повернути");
        restore.type = "button";
        restore.addEventListener("click", function () {
          state.draft = clone(Schedule.normalize(entry.settings));
          changed();
          showTab("week");
          toast("Підставлено налаштування від " + formatStamp(entry.at) + ". Натисніть «Зберегти», щоб застосувати.");
        });
        li.appendChild(restore);
      }
      list.appendChild(li);
    });
  }

  // ---------- Tabs ----------

  function showTab(name) {
    state.tab = name;
    try {
      localStorage.setItem(TAB_KEY, name);
    } catch (e) {}
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      var on = tab.dataset.tab === name;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      $("panel-" + tab.dataset.tab).hidden = !on;
    });
  }

  function buildTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        showTab(tab.dataset.tab);
      });
      // Arrow keys move between tabs, as screen readers expect.
      tab.addEventListener("keydown", function (event) {
        var step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        var next = tabs[(i + step + tabs.length) % tabs.length];
        showTab(next.dataset.tab);
        next.focus();
      });
    });
    var saved = null;
    try {
      saved = localStorage.getItem(TAB_KEY);
    } catch (e) {}
    showTab($("panel-" + saved) ? saved : "week");
  }

  // ---------- Loading & saving ----------

  function loadStaticSettings() {
    return fetch((config.settingsUrl || "settings.json") + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(Schedule.normalize)
      .catch(Schedule.defaults);
  }

  function applyState(data) {
    if (data.serverTime) state.clockOffset = data.serverTime - Date.now();
    state.override = Schedule.normalizeOverride(data.override);
    state.screens = data.screens || [];
    state.history = data.history || [];
    renderScreens();
    renderHistory();
    // Nothing saved on the server yet: start from the hours the TVs use today.
    return (data.settings ? Promise.resolve(Schedule.normalize(data.settings)) : loadStaticSettings()).then(receiveSettings);
  }

  function refresh() {
    return api("GET", "/admin")
      .then(applyState)
      .catch(function (error) {
        handleError(error, "Не вдалося отримати дані з сервера.");
      });
  }

  function save() {
    if (state.saving || !weekValid()) return;
    state.saving = true;
    renderSavebar();
    api("PUT", "/settings", state.draft)
      .then(function (data) {
        state.saving = false;
        state.history = data.history || state.history;
        var settings = Schedule.normalize(data.settings);
        state.saved = settings;
        state.draft = clone(settings);
        changed();
        renderHistory();
        toast(
          data.delivered
            ? "Збережено й одразу надіслано на " + tvCount(data.delivered) + "."
            : "Збережено. Телевізори отримають зміни, щойно вийдуть на зв'язок.",
          "ok"
        );
      })
      .catch(function (error) {
        state.saving = false;
        renderSavebar();
        handleError(error, "Не вдалося зберегти.");
      });
  }

  function discard() {
    state.draft = clone(state.saved);
    closeExceptionForm();
    changed();
    toast("Зміни скасовано.");
  }

  // ---------- Live updates ----------

  // A WebSocket brings TV status and changes made elsewhere the moment they happen. If it
  // cannot be kept open, the page falls back to asking the server every minute.
  function connectLive() {
    clearTimeout(live.retry);
    var s = session();
    if (!s || !("WebSocket" in window)) return;
    var socket = new WebSocket(apiUrl.replace(/^http/, "ws") + "/admin/ws?token=" + encodeURIComponent(s.token));
    live.socket = socket;

    socket.onopen = function () {
      live.attempt = 0;
      $("live").hidden = false;
      live.ping = setInterval(function () {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send("ping");
        clearTimeout(live.pong);
        live.pong = setTimeout(function () {
          socket.close();
        }, 10000);
      }, 30000);
    };

    socket.onmessage = function (event) {
      if (event.data === "pong") return clearTimeout(live.pong);
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (data.type === "state") applyState(data);
      else if (data.type === "screens") {
        if (data.serverTime) state.clockOffset = data.serverTime - Date.now();
        state.screens = data.screens || [];
        if (!document.querySelector(".rename")) renderScreens(); // do not wipe a name being typed
      } else if (data.type === "override") {
        state.override = Schedule.normalizeOverride(data.override);
        renderNow();
      } else if (data.type === "settings") {
        state.history = data.history || state.history;
        renderHistory();
        if (!state.saving) {
          var hadEdits = isDirty();
          receiveSettings(Schedule.normalize(data.settings));
          if (hadEdits) toast("Хтось інший щойно зберіг налаштування. Ваші незбережені зміни лишилися.");
        }
      }
    };

    socket.onclose = function (event) {
      if (live.socket !== socket) return; // replaced or stopped on purpose
      live.socket = null;
      clearInterval(live.ping);
      clearTimeout(live.pong);
      $("live").hidden = true;
      if ($("app-view").hidden) return; // signed out
      // A rejected token closes the socket before it opens; let an HTTP call sort that out.
      if (!event.wasClean && live.attempt > 2) refresh();
      var delay = Math.min(60000, 1000 * Math.pow(2, live.attempt));
      live.attempt += 1;
      live.retry = setTimeout(connectLive, delay / 2 + Math.random() * (delay / 2));
    };
  }

  function stopLive() {
    clearTimeout(live.retry);
    clearInterval(live.ping);
    clearTimeout(live.pong);
    var socket = live.socket;
    live.socket = null;
    if (socket) socket.close();
    $("live").hidden = true;
  }

  function start() {
    show("app");
    refresh();
    connectLive();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      // Fallback while the live connection is down.
      if (!live.socket && document.visibilityState === "visible") refresh();
    }, FALLBACK_REFRESH_MS);
  }

  // ---------- Events ----------

  $("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = $("login-button");
    var error = $("login-error");
    button.disabled = true;
    error.textContent = "";
    api("POST", "/login", { password: $("password").value })
      .then(function (data) {
        setSession({ token: data.token, expires: data.expires });
        $("password").value = "";
        start();
      })
      .catch(function (e) {
        error.textContent =
          e.code === "wrong_password"
            ? "Неправильний пароль."
            : e.code === "too_many_attempts"
            ? "Забагато спроб. Зачекайте 15 хвилин."
            : e.code === "password_not_set"
            ? "На сервері ще не задано пароль."
            : "Сервер недоступний. Перевірте інтернет і спробуйте ще раз.";
      })
      .then(function () {
        button.disabled = false;
      });
  });

  $("logout").addEventListener("click", function () {
    if (isDirty() && !window.confirm("Є незбережені зміни. Все одно вийти?")) return;
    signOut("");
  });
  $("save").addEventListener("click", save);
  $("discard").addEventListener("click", discard);
  $("reload-all").addEventListener("click", reloadAll);
  $("glance-all").addEventListener("click", function () {
    showTab("screens");
    document.querySelector(".tabs-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("override-cancel").addEventListener("click", function () {
    setOverride(null, null, this);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (chip) {
    chip.addEventListener("click", function () {
      setOverride(chip.dataset.mode, chip.dataset.for, chip);
    });
  });
  $("preset-weekdays").addEventListener("click", function () {
    var mon = state.draft.days.mon;
    ["tue", "wed", "thu", "fri"].forEach(function (day) {
      state.draft.days[day] = { enabled: mon.enabled, on: mon.on, off: mon.off };
    });
    changed();
    toast("Вівторок–п'ятниця тепер як понеділок. Не забудьте зберегти.");
  });
  $("preset-weekend-off").addEventListener("click", function () {
    state.draft.days.sat.enabled = false;
    state.draft.days.sun.enabled = false;
    changed();
    toast("Субота й неділя вимкнені. Не забудьте зберегти.");
  });

  // A forgotten background tab should not keep the server awake: drop the live connection
  // after a while out of sight, and catch up as soon as the page is looked at again.
  var hiddenTimer = null;
  document.addEventListener("visibilitychange", function () {
    if ($("app-view").hidden) return;
    clearTimeout(hiddenTimer);
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(stopLive, HIDDEN_DISCONNECT_MS);
    } else if (!live.socket) {
      live.attempt = 0;
      refresh();
      connectLive();
    }
  });

  window.addEventListener("beforeunload", function (event) {
    if (!$("app-view").hidden && isDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // Keep "now", the time line and "N min ago" texts fresh while the page stays open.
  setInterval(function () {
    if ($("app-view").hidden) return;
    renderNow();
    renderWeek();
    if (!document.querySelector(".rename")) renderScreens();
  }, CLOCK_MS);

  $("name-example").textContent = location.href.replace(/settings\.html.*$/, "") + "?name=Хол 1";

  buildWeek();
  buildDates();
  buildTabs();
  changed();
  if (!apiUrl) show("setup");
  else if (session()) start();
  else show("login");
})();
