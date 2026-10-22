(function () {
  "use strict";

  var TOKEN_KEY = "tv-schedule:github-token";
  var PUBLISH_POLL_MS = 5000;
  var PUBLISH_TIMEOUT_MS = 4 * 60 * 1000;

  var Schedule = window.TVSchedule;
  var config = window.TV_CONFIG || {};
  var repo = config.github || {};
  var apiUrl = "https://api.github.com/repos/" + repo.owner + "/" + repo.repo + "/contents/" + repo.path;

  var week = document.getElementById("week");
  var rowTemplate = document.getElementById("day-row");
  var nowState = document.getElementById("now-state");
  var saveButton = document.getElementById("save");
  var status = document.getElementById("status");
  var accessOff = document.getElementById("access-off");
  var accessOn = document.getElementById("access-on");
  var tokenForm = document.getElementById("token-form");
  var tokenInput = document.getElementById("token");
  var forgetButton = document.getElementById("forget");

  var saved = Schedule.defaults(); // what is in the repository
  var rows = {};
  var saving = false;

  // ---------- Token ----------

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
    renderAccess();
  }

  function renderAccess() {
    var has = !!getToken();
    accessOff.hidden = has;
    accessOn.hidden = !has;
    updateSaveButton();
  }

  // ---------- Week form ----------

  var STEP_MINUTES = 15;

  // Selects instead of <input type="time">: the native picker shows AM/PM on some systems.
  function addTimeOptions(select, from, to) {
    for (var m = from; m <= to; m += STEP_MINUTES) {
      var label = Schedule.formatClock(m);
      select.add(new Option(label, label));
    }
  }

  // A time typed into settings.json by hand may sit between steps; keep it selectable.
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
      // A switched-off day with half-typed times keeps its last saved times.
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
    updateSaveButton();
    if (!saving && current && isDirty(current)) setStatus("Є незбережені зміни");
    else if (!saving && current) setStatus("");
  }

  function updateSaveButton() {
    var current = read();
    saveButton.disabled = saving || !current || !isDirty(current) || !getToken();
  }

  function renderNowState(settings) {
    var t = Schedule.now(config.timeZone);
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
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-error", kind === "error");
  }

  // ---------- GitHub ----------

  function api(method, body) {
    var url = apiUrl + (method === "GET" ? "?ref=" + encodeURIComponent(repo.branch) + "&t=" + Date.now() : "");
    return fetch(url, {
      method: method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + getToken(),
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (res.ok) return res.json();
      var error = new Error("HTTP " + res.status);
      error.status = res.status;
      throw error;
    });
  }

  function decode(base64) {
    var bytes = Uint8Array.from(atob(base64.replace(/\s/g, "")), function (c) {
      return c.charCodeAt(0);
    });
    return new TextDecoder().decode(bytes);
  }

  function encode(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    bytes.forEach(function (b) {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }

  function describeError(error) {
    if (error.status === 401) return "Токен недійсний або прострочений. Натисніть «Вийти» і введіть новий.";
    if (error.status === 403 || error.status === 404)
      return "У токена немає доступу на запис до репозиторію " + repo.repo + " (потрібно Contents: Read and write).";
    if (error.status === 409 || error.status === 422) return "Файл щойно змінили в іншому місці. Спробуйте зберегти ще раз.";
    return "Не вдалося зберегти (" + (error.message || "помилка мережі") + "). Перевірте інтернет і спробуйте ще раз.";
  }

  function summary(settings) {
    var short = { mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд" };
    return Schedule.DAYS.map(function (day) {
      var d = settings.days[day];
      return short[day] + " " + (d.enabled ? d.on + "–" + d.off : "вимк.");
    }).join(", ");
  }

  function save() {
    var current = read();
    if (!current || saving) return;
    saving = true;
    updateSaveButton();
    setStatus("Збереження…");

    var text = JSON.stringify(current, null, 2) + "\n";
    // Always fetch the latest sha right before writing, so an edit from another browser is not lost silently.
    api("GET")
      .then(function (file) {
        return api("PUT", {
          message: "Час роботи ТВ: " + summary(current),
          content: encode(text),
          sha: file.sha,
          branch: repo.branch,
        });
      })
      .then(function () {
        saved = current;
        setStatus("Збережено. Публікуємо на сайті…");
        return waitForPublish(current);
      })
      .then(function (published) {
        setStatus(
          published
            ? "Готово. Телевізори застосують новий час протягом " + (config.settingsRefreshMinutes || 2) + " хв."
            : "Збережено. Публікація триває довше звичайного, телевізори підхоплять зміни трохи пізніше.",
          "ok"
        );
      })
      .catch(function (error) {
        setStatus(describeError(error), "error");
      })
      .then(function () {
        saving = false;
        updateSaveButton();
      });
  }

  // Waits until the published settings.json (what TVs read) matches what was saved.
  function waitForPublish(expected) {
    var started = Date.now();
    var want = JSON.stringify(expected);
    return new Promise(function (resolve) {
      function poll() {
        fetchPublished()
          .then(function (published) {
            if (JSON.stringify(published) === want) resolve(true);
            else retry();
          })
          .catch(retry);
      }
      function retry() {
        if (Date.now() - started > PUBLISH_TIMEOUT_MS) resolve(false);
        else setTimeout(poll, PUBLISH_POLL_MS);
      }
      poll();
    });
  }

  function fetchPublished() {
    return fetch(config.settingsUrl + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(Schedule.normalize);
  }

  // Prefer the repository copy (always the newest); fall back to the published file.
  function loadInitial() {
    setStatus("Завантаження…");
    var source = getToken()
      ? api("GET").then(function (file) {
          return Schedule.normalize(JSON.parse(decode(file.content)));
        })
      : Promise.reject();
    return source
      .catch(fetchPublished)
      .then(function (settings) {
        saved = settings;
        fill(settings);
        setStatus("");
      })
      .catch(function () {
        fill(saved);
        setStatus("Не вдалося завантажити поточні налаштування, показано стандартні 08:00–20:00.", "error");
      });
  }

  // ---------- Events ----------

  tokenForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = tokenInput.value.trim();
    if (!value) return;
    tokenInput.value = "";
    setToken(value);
    setStatus("Перевіряємо доступ…");
    api("GET")
      .then(function () {
        setStatus("Доступ працює.", "ok");
        updateSaveButton();
      })
      .catch(function (error) {
        setToken("");
        setStatus(describeError(error), "error");
      });
  });

  forgetButton.addEventListener("click", function () {
    setToken("");
    setStatus("Доступ видалено з цього браузера.");
  });

  saveButton.addEventListener("click", save);

  window.addEventListener("beforeunload", function (event) {
    var current = read();
    if (current && isDirty(current)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // Keep "now showing / black until" fresh while the page stays open.
  setInterval(function () {
    renderNowState(read() || saved);
  }, 30 * 1000);

  buildWeek();
  renderAccess();
  loadInitial();
})();
