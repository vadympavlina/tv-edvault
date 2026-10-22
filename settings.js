(function () {
  "use strict";

  var SESSION_KEY = "tv-schedule:session";
  var REFRESH_MS = 30 * 1000;
  // A TV checks in every minute; after this long without news it is shown as offline.
  var OFFLINE_AFTER_MS = 3 * 60 * 1000;
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

  function renderNowState(settings) {
    var t = Schedule.now(config.timeZone, clockOffset);
    var on = Schedule.isOn(settings, t.day, t.minutes);
    nowState.classList.toggle("is-on", on);
    if (on) {
      nowState.textContent = "Зараз показується розклад, до " + settings.days[Schedule.DAYS[t.day]].off;
    } else {
      var next = Schedule.nextStart(settings, t.day, t.minutes);
      nowState.textContent = next ? "Зараз чорний екран, увімкнеться " + next : "Зараз чорний екран, увімкнених днів немає";
    }
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind || "";
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-error", kind === "error");
  }

  function summary(settings) {
    return Schedule.DAYS.map(function (day) {
      var d = settings.days[day];
      return SHORT_DAYS[day] + " " + (d.enabled ? d.on + "–" + d.off : "вимк.");
    }).join(" · ");
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

  function renderScreens(screens, serverTime) {
    screensList.textContent = "";
    $("screens-empty").hidden = screens.length > 0;
    screens.forEach(function (screen) {
      var online = serverTime - screen.lastSeen < OFFLINE_AFTER_MS;
      var li = document.createElement("li");
      li.className = "screen" + (online ? " is-online" : "");

      var dot = document.createElement("span");
      dot.className = "screen-dot";
      dot.setAttribute("aria-hidden", "true");

      var main = document.createElement("div");
      main.className = "screen-main";
      var name = document.createElement("span");
      name.className = "screen-name";
      name.textContent = screen.name || "ТВ " + screen.id.slice(0, 4).toUpperCase();
      var meta = document.createElement("span");
      meta.className = "screen-meta";
      var parts = [];
      if (!online) parts.push("не на зв'язку, востаннє " + ago(serverTime - screen.lastSeen));
      else if (screen.state === "schedule")
        parts.push("показує розклад" + (screen.scheduleLoadedAt ? ", оновлено " + ago(Date.now() - screen.scheduleLoadedAt) : ""));
      else if (screen.state === "night") parts.push("чорний екран");
      else if (screen.state === "splash") parts.push("заставка, розклад не запущено");
      if (screen.size) parts.push(screen.size);
      meta.textContent = parts.join(" · ");
      main.appendChild(name);
      main.appendChild(meta);

      var state = document.createElement("span");
      state.className = "screen-state";
      state.textContent = online ? "онлайн" : "офлайн";

      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(state);
      screensList.appendChild(li);
    });
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

  // first: also replace the form with what the server has (later refreshes keep unsaved edits).
  function refresh(first) {
    return api("GET", "/admin")
      .then(function (data) {
        clockOffset = data.serverTime ? data.serverTime - Date.now() : 0;
        renderScreens(data.screens || [], data.serverTime || Date.now());
        renderHistory(data.history || []);
        // Nothing saved on the server yet: start from the hours the TVs use today.
        return (data.settings ? Promise.resolve(Schedule.normalize(data.settings)) : loadStaticSettings()).then(
          function (settings) {
            var current = read();
            var untouched = current && !isDirty(current);
            saved = settings;
            if (first || untouched) fill(settings);
            else onChange();
          }
        );
      })
      .catch(function (error) {
        handleError(error, "Не вдалося отримати дані з сервера.");
      });
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
        setStatus("Збережено. Телевізори застосують новий час протягом хвилини.", "ok");
      })
      .catch(function (error) {
        saving = false;
        onChange();
        handleError(error, "Не вдалося зберегти.");
      });
  }

  function reloadAll() {
    if (!window.confirm("Перезавантажити сторінку на всіх телевізорах? Вони перезапустяться протягом хвилини.")) return;
    var button = $("reload-all");
    button.disabled = true;
    api("POST", "/reload")
      .then(function () {
        setStatus("Команду надіслано. Телевізори перезавантажаться протягом хвилини.", "ok");
      })
      .catch(function (error) {
        handleError(error, "Не вдалося надіслати команду.");
      })
      .then(function () {
        button.disabled = false;
      });
  }

  function start() {
    show("app");
    setStatus("Завантаження…");
    refresh(true).then(function () {
      if (status.textContent === "Завантаження…") setStatus("");
    });
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (document.visibilityState === "visible") refresh(false);
    }, REFRESH_MS);
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

  window.addEventListener("beforeunload", function (event) {
    var current = !appView.hidden && read();
    if (current && isDirty(current)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // Keep "now showing / black until" fresh while the page stays open.
  setInterval(function () {
    if (!appView.hidden) renderNowState(read() || saved);
  }, REFRESH_MS);

  $("name-example").textContent =
    location.href.replace(/settings\.html.*$/, "") + "?name=Хол 1";

  buildWeek();
  if (!apiUrl) show("setup");
  else if (session()) start();
  else show("login");
})();
