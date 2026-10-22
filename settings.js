(function () {
  "use strict";

  var SESSION_KEY = "tv-schedule:session";
  var CLOCK_MS = 30 * 1000;
  var FALLBACK_REFRESH_MS = 60 * 1000;
  var HIDDEN_DISCONNECT_MS = 2 * 60 * 1000;
  var STEP_MINUTES = 15;
  var SHORT_DAYS = { mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд" };

  var Schedule = window.TVSchedule;
  var config = window.TV_CONFIG || {};
  var apiUrl = String(new URLSearchParams(location.search).get("api") || window.TV_API_URL || "").replace(/\/+$/, "");

  var $ = function (id) {
    return document.getElementById(id);
  };
  var loginView = $("login-view");
  var setupView = $("setup-view");
  var appView = $("app-view");
  var savebar = $("savebar");
  var week = $("week");
  var rowTemplate = $("day-row");
  var nowState = $("now-state");
  var saveButton = $("save");
  var status = $("status");
  var screensList = $("screens");
  var historyList = $("history");

  var saved = Schedule.defaults(); // what the TVs currently use
  var rows = {};
  var saving = false;
  var clockOffset = 0;
  var refreshTimer = null;
  var screens = [];
  var exceptions = []; // special dates in the form (normalized, sorted)
  var override = null; // manual "now" override, applied right away (not part of the form)
  var live = { socket: null, attempt: 0, retry: null, ping: null, pong: null };

  // ---------- Session ----------

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
    loginView.hidden = view !== "login";
    setupView.hidden = view !== "setup";
    appView.hidden = view !== "app";
    savebar.hidden = view !== "app";
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

  function handleError(error, fallback) {
    if (error.status === 401) return signOut("Сесія завершилась, увійдіть ще раз.");
    setStatus(fallback + (navigator.onLine === false ? " Немає інтернету." : " Спробуйте ще раз."), "error");
  }

  // ---------- Week form ----------

  // Selects instead of <input type="time">: the native picker shows AM/PM on some systems.
  function addTimeOptions(select, from, to) {
    for (var m = from; m <= to; m += STEP_MINUTES) {
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
    var today = Schedule.now(config.timeZone).day;
    Schedule.DAYS.forEach(function (day, index) {
      var node = rowTemplate.content.firstElementChild.cloneNode(true);
      var row = {
        node: node,
        enabled: node.querySelector(".day-enabled"),
        on: node.querySelector(".day-on"),
        off: node.querySelector(".day-off"),
        error: node.querySelector(".day-error"),
      };
      node.querySelector(".day-name").textContent = Schedule.DAY_NAMES[day];
      addTimeOptions(row.on, 0, 24 * 60 - STEP_MINUTES);
      addTimeOptions(row.off, STEP_MINUTES, 24 * 60);
      if (index === today) {
        node.classList.add("is-today");
        node.querySelector(".today-badge").hidden = false;
      }
      row.enabled.setAttribute("aria-label", Schedule.DAY_NAMES[day] + ": показувати розклад");
      node.querySelector(".copy").addEventListener("click", function () {
        copyToAll(day);
      });
      [row.enabled, row.on, row.off].forEach(function (input) {
        input.addEventListener("input", onChange);
        input.addEventListener("change", onChange);
      });
      rows[day] = row;
      week.appendChild(node);
    });
  }

  function fill(settings) {
    Schedule.DAYS.forEach(function (day) {
      var d = settings.days[day];
      var row = rows[day];
      row.enabled.checked = d.enabled;
      setTime(row.on, d.on);
      setTime(row.off, d.off);
    });
    exceptions = settings.exceptions.slice();
    renderExceptions();
    onChange();
  }

  // Reads the form; returns null if any enabled day is invalid.
  function read() {
    var result = { days: {} };
    var valid = true;
    Schedule.DAYS.forEach(function (day) {
      var row = rows[day];
      var on = Schedule.parseClock(row.on.value);
      var off = Schedule.parseClock(row.off.value);
      var ok = on !== null && off !== null && on < off;
      var enabled = row.enabled.checked;
      row.node.classList.toggle("is-off", !enabled);
      row.node.classList.toggle("is-invalid", enabled && !ok);
      row.error.hidden = !enabled || ok;
      if (enabled && !ok) valid = false;
      // A switched-off day with a broken range keeps its last saved times.
      result.days[day] = {
        enabled: enabled,
        on: ok ? Schedule.formatClock(on) : saved.days[day].on,
        off: ok ? Schedule.formatClock(off) : saved.days[day].off,
      };
    });
    result.exceptions = exceptions;
    return valid ? result : null;
  }

  function copyToAll(source) {
    var from = rows[source];
    Schedule.DAYS.forEach(function (day) {
      if (day === source) return;
      rows[day].enabled.checked = true;
      setTime(rows[day].on, from.on.value);
      setTime(rows[day].off, from.off.value);
    });
    onChange();
    setStatus("Час " + from.on.value + "–" + from.off.value + " скопійовано на всі дні. Не забудьте зберегти.");
  }

  function isDirty(current) {
    return JSON.stringify(current) !== JSON.stringify(saved);
  }

  function onChange() {
    var current = read();
    renderNowState(current || saved);
    saveButton.disabled = saving || !current || !isDirty(current);
    if (!saving && current && isDirty(current)) setStatus("Є незбережені зміни");
    else if (!saving && current && status.dataset.kind !== "ok") setStatus("");
  }

  // ---------- Now: state and manual override ----------

  function moment() {
    return Schedule.now(config.timeZone, clockOffset);
  }

  function withOverride(settings) {
    return { days: settings.days, exceptions: settings.exceptions, override: override };
  }

  function renderNowState(settings) {
    var t = moment();
    var tz = config.timeZone;
    var effective = withOverride(settings);
    var on = Schedule.isOn(effective, t);
    var change = Schedule.nextChange(effective, t, tz);
    var active = override && override.until > t.ms ? override : null;

    nowState.classList.toggle("is-on", on);
    if (on) {
      nowState.textContent = "Показується розклад" + (change ? ", до " + whenText(change, t) : "");
    } else {
      nowState.textContent =
        "Чорний екран" + (change ? ", розклад увімкнеться " + Schedule.describe(change, t, tz) : ", увімкнень попереду немає");
    }

    var rule = Schedule.ruleFor(settings, t.date);
    var todayException = $("now-exception");
    todayException.hidden = !rule.exception;
    if (rule.exception) {
      todayException.textContent =
        "Сьогодні особливий день" +
        (rule.exception.note ? ": " + rule.exception.note : "") +
        " (" + (rule.exception.enabled ? rule.exception.on + "–" + rule.exception.off : "вимкнено весь день") + ")";
    }

    $("override-active").hidden = !active;
    if (active) {
      $("override-text").textContent =
        (active.mode === "on" ? "Увімкнено вручну" : "Вимкнено вручну") + " до " + whenText(active.until, t);
    }
    // Offer what makes sense from here: switching off while on, switching on while off.
    $("override-off").hidden = !on;
    $("override-on").hidden = on;
  }

  // "18:30" today, otherwise "завтра о 08:00" and so on.
  function whenText(ms, t) {
    var target = Schedule.at(ms, config.timeZone);
    if (target.minutes === 0 && target.date === Schedule.addDays(t.date, 1)) return "опівночі";
    var text = Schedule.describe(ms, t, config.timeZone);
    return target.date === t.date ? text.replace(/^о /, "") : text;
  }

  function overrideUntil(mode, span) {
    var t = moment();
    var tz = config.timeZone;
    if (span === "1h") return t.ms + 60 * 60 * 1000;
    if (span === "2h") return t.ms + 2 * 60 * 60 * 1000;
    if (span === "4h") return t.ms + 4 * 60 * 60 * 1000;
    if (span === "day") return Schedule.toMs(t.date, 24 * 60, tz);
    // "next": until the schedule itself switches on again after its current stretch.
    var base = { days: saved.days, exceptions: saved.exceptions };
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
      var until = overrideUntil(mode, span);
      if (!until) return setStatus("За розкладом увімкнень попереду немає, оберіть інший варіант.", "error");
      body = { mode: mode, until: until };
    }
    if (button) button.disabled = true;
    api("PUT", "/override", body)
      .then(function (data) {
        override = Schedule.normalizeOverride(data.override);
        renderNowState(read() || saved);
        var where = data.delivered ? " Надіслано на " + tvCount(data.delivered) + "." : "";
        setStatus((override ? "Готово." : "Повернули звичайний розклад.") + where, "ok");
      })
      .catch(function (error) {
        handleError(error, "Не вдалося застосувати.");
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  // ---------- Special dates ----------

  function formatRange(e) {
    if (e.from === e.to) return Schedule.formatDate(e.from) + " " + e.from.slice(0, 4);
    var sameYear = e.from.slice(0, 4) === e.to.slice(0, 4);
    return (
      Schedule.formatDate(e.from) +
      (sameYear ? "" : " " + e.from.slice(0, 4)) +
      " – " +
      Schedule.formatDate(e.to) +
      " " +
      e.to.slice(0, 4)
    );
  }

  function renderExceptions() {
    var list = $("exceptions");
    var today = moment().date;
    list.textContent = "";
    $("exceptions-empty").hidden = exceptions.length > 0;
    exceptions.forEach(function (e, index) {
      var li = document.createElement("li");
      var past = e.to < today;
      var current = e.from <= today && today <= e.to;
      li.className = "exception" + (past ? " is-past" : "") + (current ? " is-current" : "");

      var text = document.createElement("div");
      text.className = "exception-text";
      var when = document.createElement("span");
      when.className = "exception-when";
      when.textContent = formatRange(e);
      if (current || past) {
        var badge = document.createElement("span");
        badge.className = "badge" + (current ? " badge-current" : "");
        badge.textContent = current ? "діє зараз" : "минуло";
        when.appendChild(badge);
      }
      var what = document.createElement("span");
      what.className = "exception-what";
      what.textContent = (e.enabled ? e.on + "–" + e.off : "вимкнено весь день") + (e.note ? " · " + e.note : "");
      text.appendChild(when);
      text.appendChild(what);

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-small btn-ghost";
      remove.textContent = "Видалити";
      remove.addEventListener("click", function () {
        exceptions = exceptions.filter(function (_, i) {
          return i !== index;
        });
        renderExceptions();
        onChange();
      });

      li.appendChild(text);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  function addException(event) {
    event.preventDefault();
    var error = $("exception-error");
    var from = $("exception-from").value;
    var to = $("exception-to").value || from;
    var mode = $("exception-mode").value;
    var on = $("exception-on").value;
    var off = $("exception-off").value;
    error.textContent = "";
    if (!Schedule.isDate(from)) return (error.textContent = "Вкажіть дату.");
    if (!Schedule.isDate(to) || to < from) return (error.textContent = "Дата «по» має бути не раніше за «з».");
    if (mode === "hours" && Schedule.parseClock(on) >= Schedule.parseClock(off)) {
      return (error.textContent = "Час вимкнення має бути пізніше за час увімкнення.");
    }
    var entry = { from: from, to: to, enabled: mode === "hours", on: on, off: off, note: $("exception-note").value };
    var next = Schedule.normalize({ days: saved.days, exceptions: exceptions.concat([entry]) }).exceptions;
    exceptions = next;
    renderExceptions();
    onChange();
    $("exception-form").reset();
    setTime($("exception-on"), "10:00");
    setTime($("exception-off"), "16:00");
    $("exception-hours").hidden = true;
    setStatus("Особливий день додано. Натисніть «Зберегти», щоб надіслати на телевізори.");
  }

  function buildExceptionForm() {
    addTimeOptions($("exception-on"), 0, 24 * 60 - STEP_MINUTES);
    addTimeOptions($("exception-off"), STEP_MINUTES, 24 * 60);
    setTime($("exception-on"), "10:00");
    setTime($("exception-off"), "16:00");
    $("exception-mode").addEventListener("change", function () {
      $("exception-hours").hidden = this.value !== "hours";
    });
    $("exception-from").addEventListener("change", function () {
      var to = $("exception-to");
      if (to.value && to.value < this.value) to.value = this.value;
      to.min = this.value;
    });
    $("exception-form").addEventListener("submit", addException);
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind || "";
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-error", kind === "error");
  }

  function summary(settings) {
    var week = Schedule.DAYS.map(function (day) {
      var d = settings.days[day];
      return SHORT_DAYS[day] + " " + (d.enabled ? d.on + "–" + d.off : "вимк.");
    }).join(" · ");
    var n = (settings.exceptions || []).length;
    return n ? week + " · особливих днів: " + n : week;
  }

  // ---------- Screens ----------

  function ago(ms) {
    var min = Math.round(ms / 60000);
    if (min < 1) return "щойно";
    if (min < 60) return min + " хв тому";
    var h = Math.round(min / 60);
    if (h < 24) return h + " год тому";
    return Math.round(h / 24) + " дн тому";
  }

  function screenTitle(screen) {
    return screen.name || "ТВ " + screen.id.slice(0, 4).toUpperCase();
  }

  function renderScreens() {
    var now = Date.now() + clockOffset;
    screensList.textContent = "";
    $("screens-empty").hidden = screens.length > 0;
    screens.forEach(function (screen) {
      var online = !!screen.online;
      var li = document.createElement("li");
      li.className = "screen" + (online ? " is-online" : "") + (online && screen.stale ? " is-warning" : "");

      var dot = document.createElement("span");
      dot.className = "screen-dot";
      dot.setAttribute("aria-hidden", "true");

      var main = document.createElement("div");
      main.className = "screen-main";
      var name = document.createElement("span");
      name.className = "screen-name";
      name.textContent = screenTitle(screen);
      var meta = document.createElement("span");
      meta.className = "screen-meta";
      var parts = [];
      if (!online) {
        parts.push("не на зв'язку, востаннє " + ago(now - screen.lastSeen));
      } else {
        if (screen.state === "schedule") parts.push(screen.stale ? "розклад давно не оновлювався" : "показує розклад");
        else if (screen.state === "night") parts.push("чорний екран");
        else if (screen.state === "splash") parts.push("заставка, розклад не запущено");
        if (screen.transport === "http") parts.push("без постійного з'єднання");
        else if (screen.connectedAt) parts.push("на зв'язку " + duration(now - screen.connectedAt));
      }
      if (screen.size) parts.push(screen.size);
      meta.textContent = parts.join(" · ");
      main.appendChild(name);
      main.appendChild(meta);

      var state = document.createElement("span");
      state.className = "screen-state";
      state.textContent = !online ? "офлайн" : screen.stale ? "увага" : "онлайн";

      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(state);
      if (!online) {
        var forget = document.createElement("button");
        forget.type = "button";
        forget.className = "btn btn-small btn-ghost";
        forget.textContent = "Прибрати";
        forget.title = "Прибрати зі списку. Якщо цей ТВ знову вийде на зв'язок, він з'явиться сам.";
        forget.addEventListener("click", function () {
          forgetScreen(screen, forget);
        });
        li.appendChild(forget);
      }
      screensList.appendChild(li);
    });
    var count = screens.filter(function (s) {
      return s.online;
    }).length;
    $("screens-count").textContent = screens.length ? count + " з " + screens.length + " онлайн" : "";
  }

  function forgetScreen(screen, button) {
    if (!window.confirm("Прибрати «" + screenTitle(screen) + "» зі списку?")) return;
    button.disabled = true;
    api("POST", "/screens/forget", { id: screen.id })
      .then(function (data) {
        screens = data.screens || [];
        renderScreens();
      })
      .catch(function (error) {
        button.disabled = false;
        handleError(error, error.code === "screen_online" ? "Цей телевізор знову на зв'язку." : "Не вдалося прибрати телевізор.");
      });
  }

  function duration(ms) {
    var min = Math.floor(ms / 60000);
    if (min < 1) return "менше хвилини";
    if (min < 60) return min + " хв";
    var h = Math.floor(min / 60);
    if (h < 24) return h + " год " + (min % 60) + " хв";
    return Math.floor(h / 24) + " дн " + (h % 24) + " год";
  }

  // ---------- History ----------

  function formatDate(ms) {
    try {
      return new Intl.DateTimeFormat("uk-UA", {
        timeZone: config.timeZone,
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderHistory(history) {
    historyList.textContent = "";
    $("history-empty").hidden = history.length > 0;
    history.slice(0, 10).forEach(function (entry, index) {
      var li = document.createElement("li");
      li.className = "history-item";
      var text = document.createElement("div");
      text.className = "history-text";
      var when = document.createElement("span");
      when.className = "history-when";
      when.textContent = formatDate(entry.at) + (index === 0 ? " · зараз діє" : "");
      var what = document.createElement("span");
      what.className = "history-what";
      what.textContent = summary(entry.settings);
      text.appendChild(when);
      text.appendChild(what);
      li.appendChild(text);
      if (index > 0) {
        var restore = document.createElement("button");
        restore.type = "button";
        restore.className = "btn btn-small btn-ghost";
        restore.textContent = "Повернути";
        restore.addEventListener("click", function () {
          fill(Schedule.normalize(entry.settings));
          setStatus("Підставлено час від " + formatDate(entry.at) + ". Натисніть «Зберегти», щоб застосувати.");
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        li.appendChild(restore);
      }
      historyList.appendChild(li);
    });
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

  function applyServerTime(serverTime) {
    if (serverTime) clockOffset = serverTime - Date.now();
  }

  // Server settings arrived. The form follows them unless the user is in the middle of an edit.
  function applySettings(settings, force) {
    var current = read();
    var untouched = current && !isDirty(current);
    saved = settings;
    if (force || untouched) fill(settings);
    else onChange();
  }

  // first: also replace the form with what the server has (later updates keep unsaved edits).
  function applyState(data, first) {
    applyServerTime(data.serverTime);
    override = Schedule.normalizeOverride(data.override);
    screens = data.screens || [];
    renderScreens();
    renderHistory(data.history || []);
    // Nothing saved on the server yet: start from the hours the TVs use today.
    return (data.settings ? Promise.resolve(Schedule.normalize(data.settings)) : loadStaticSettings()).then(
      function (settings) {
        applySettings(settings, first);
      }
    );
  }

  function refresh(first) {
    return api("GET", "/admin")
      .then(function (data) {
        return applyState(data, first);
      })
      .catch(function (error) {
        handleError(error, "Не вдалося отримати дані з сервера.");
      });
  }

  // ---------- Live updates ----------

  // A WebSocket brings TV status changes the moment they happen. If it cannot be kept open,
  // the page falls back to asking the server every minute.
  function connectLive() {
    clearTimeout(live.retry);
    var s = session();
    if (!s || !("WebSocket" in window)) return;
    var socket = new WebSocket(apiUrl.replace(/^http/, "ws") + "/admin/ws?token=" + encodeURIComponent(s.token));
    live.socket = socket;

    socket.onopen = function () {
      live.attempt = 0;
      setLive(true);
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
      if (data.type === "state") applyState(data, false);
      else if (data.type === "screens") {
        applyServerTime(data.serverTime);
        screens = data.screens || [];
        renderScreens();
      } else if (data.type === "override") {
        override = Schedule.normalizeOverride(data.override);
        renderNowState(read() || saved);
      } else if (data.type === "settings") {
        renderHistory(data.history || []);
        if (!saving) applySettings(Schedule.normalize(data.settings), false);
      }
    };

    socket.onclose = function (event) {
      if (live.socket !== socket) return; // replaced or stopped on purpose
      live.socket = null;
      clearInterval(live.ping);
      clearTimeout(live.pong);
      setLive(false);
      if (appView.hidden) return; // signed out
      // A rejected token closes the socket before it opens; let an HTTP call sort that out.
      if (!event.wasClean && live.attempt > 2) refresh(false);
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
    setLive(false);
  }

  function setLive(on) {
    $("live").hidden = !on;
  }

  function save() {
    var current = read();
    if (!current || saving) return;
    saving = true;
    saveButton.disabled = true;
    setStatus("Збереження…");
    api("PUT", "/settings", current)
      .then(function (data) {
        saved = Schedule.normalize(data.settings);
        renderHistory(data.history || []);
        saving = false;
        onChange();
        setStatus(
          data.delivered
            ? "Збережено й одразу надіслано на " + tvCount(data.delivered) + "."
            : "Збережено. Телевізори отримають новий час, щойно вийдуть на зв'язок.",
          "ok"
        );
      })
      .catch(function (error) {
        saving = false;
        onChange();
        handleError(error, "Не вдалося зберегти.");
      });
  }

  function reloadAll() {
    if (!window.confirm("Перезавантажити сторінку на всіх телевізорах?")) return;
    var button = $("reload-all");
    button.disabled = true;
    api("POST", "/reload")
      .then(function (data) {
        setStatus(
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

  function tvCount(n) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    var word =
      mod10 === 1 && mod100 !== 11 ? "телевізор" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "телевізори" : "телевізорів";
    return n + " " + word;
  }

  function start() {
    show("app");
    setStatus("Завантаження…");
    refresh(true).then(function () {
      if (status.textContent === "Завантаження…") setStatus("");
    });
    connectLive();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      // Fallback while the live connection is down.
      if (!live.socket && document.visibilityState === "visible") refresh(false);
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
    signOut("");
  });
  saveButton.addEventListener("click", save);
  $("reload-all").addEventListener("click", reloadAll);

  // A forgotten background tab should not keep the server awake: drop the live connection
  // after a while out of sight, and catch up as soon as the page is looked at again.
  var hiddenTimer = null;
  document.addEventListener("visibilitychange", function () {
    if (appView.hidden) return;
    clearTimeout(hiddenTimer);
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(stopLive, HIDDEN_DISCONNECT_MS);
    } else if (!live.socket) {
      live.attempt = 0;
      refresh(false);
      connectLive();
    }
  });

  window.addEventListener("beforeunload", function (event) {
    var current = !appView.hidden && read();
    if (current && isDirty(current)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // Keep "now showing / black until" and the "N min ago" texts fresh while the page stays open.
  setInterval(function () {
    if (appView.hidden) return;
    renderNowState(read() || saved);
    renderScreens();
  }, CLOCK_MS);

  $("name-example").textContent =
    location.href.replace(/settings\.html.*$/, "") + "?name=Хол 1";

  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (chip) {
    chip.addEventListener("click", function () {
      setOverride(chip.dataset.mode, chip.dataset.for, chip);
    });
  });
  $("override-cancel").addEventListener("click", function () {
    setOverride(null, null, this);
  });

  buildWeek();
  buildExceptionForm();
  if (!apiUrl) show("setup");
  else if (session()) start();
  else show("login");
})();
