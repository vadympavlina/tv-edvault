(function () {
  "use strict";

  var STORAGE_KEY = "tv-schedule:launched";
  var SETTINGS_CACHE_KEY = "tv-schedule:settings";
  var Schedule = window.TVSchedule;
  var TICK_MS = 15 * 1000;
  var LOAD_TIMEOUT_MS = 60 * 1000;
  // Give the schedule's own scripts a moment to render before swapping it in.
  var SETTLE_MS = 1200;
  var SPLASH_MAX_WAIT_MS = 12 * 1000;
  var NIGHT_HINT_MS = 5000;

  var config = readConfig();

  var body = document.body;
  var splash = document.getElementById("splash");
  var button = document.getElementById("launch");
  var note = document.getElementById("launch-note");
  var night = document.getElementById("night");
  var nightClock = document.getElementById("night-clock");
  var nightText = document.getElementById("night-text");
  var keepalive = document.getElementById("keepalive");
  var frames = Array.prototype.slice.call(document.querySelectorAll(".frame"));

  var running = false;
  var isNight = null;
  var activeFrame = null;
  var pendingFrame = null;
  var pendingTimer = null;
  var lastLoadAt = 0;
  var wakeLock = null;
  var countdownTimer = null;
  var nightHintTimer = null;
  var splashDone = false;
  var settings = cachedSettings();
  var settingsLoadedAt = 0;

  // ---------- Config ----------

  function readConfig() {
    var base = window.TV_CONFIG || {};
    var params = new URLSearchParams(location.search);
    function pick(name, fallback) {
      return params.has(name) ? params.get(name) : fallback;
    }
    return {
      scheduleUrl: pick("url", base.scheduleUrl),
      rooms: pick("rooms", base.rooms),
      settingsUrl: pick("settings", base.settingsUrl || "settings.json"),
      settingsRefreshMinutes: toNumber(base.settingsRefreshMinutes, 2),
      timeZone: pick("tz", base.timeZone),
      refreshMinutes: toNumber(pick("refresh", base.refreshMinutes), 10),
      autostartSeconds: toNumber(pick("autostart", base.autostartSeconds), 15),
      // Testing only: pretend the clock shows this day/time, e.g. ?day=sat&time=21:30
      fakeTime: params.has("time") ? parseClock(params.get("time"), null) : null,
      fakeDay: params.has("day") ? Schedule.DAYS.indexOf(params.get("day")) : -1,
    };
  }

  function parseClock(value, fallback) {
    var m = /^(\d{1,2}):?(\d{2})$/.exec(String(value || "").trim());
    if (!m) return fallback;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (h > 24 || min > 59) return fallback;
    return h * 60 + min;
  }

  function toNumber(value, fallback) {
    var n = Number(value);
    return isFinite(n) && n >= 0 ? n : fallback;
  }

  function scheduleSrc() {
    var url = config.scheduleUrl;
    if (config.rooms) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "rooms=" + config.rooms;
    }
    return url;
  }

  // ---------- Time ----------

  function now() {
    var t = Schedule.now(config.timeZone);
    if (config.fakeDay !== -1) t.day = config.fakeDay;
    if (config.fakeTime !== null) t.minutes = config.fakeTime;
    return t;
  }

  function isDaytime(t) {
    return Schedule.isOn(settings, t.day, t.minutes);
  }

  // ---------- Weekly hours (settings.json) ----------

  function cachedSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_CACHE_KEY);
      if (raw) return Schedule.normalize(JSON.parse(raw));
    } catch (e) {}
    return Schedule.defaults();
  }

  // Re-read settings.json; on any failure keep the last known hours.
  function loadSettings() {
    settingsLoadedAt = Date.now();
    if (!window.fetch) return;
    var url = config.settingsUrl + (config.settingsUrl.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (raw) {
        settings = Schedule.normalize(raw);
        try {
          localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
        } catch (e) {}
        tick();
      })
      .catch(function () {});
  }

  // ---------- Keep the screen awake ----------

  function keepAwake() {
    var playing = keepalive.play();
    if (playing && playing.catch) playing.catch(function () {});

    if (!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible") return;
    navigator.wakeLock
      .request("screen")
      .then(function (lock) {
        wakeLock = lock;
        lock.addEventListener("release", function () {
          wakeLock = null;
          if (running) setTimeout(keepAwake, 1000);
        });
      })
      .catch(function () {});
  }

  function enterFullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      var req = el.requestFullscreen
        ? el.requestFullscreen({ navigationUI: "hide" })
        : el.webkitRequestFullscreen && el.webkitRequestFullscreen();
      if (req && req.catch) req.catch(function () {});
    } catch (e) {}
  }

  // ---------- Schedule frames ----------

  function loadSchedule() {
    if (pendingFrame) return;
    if (activeFrame && navigator.onLine === false) return; // keep what is on screen while offline

    var frame = frames[0] === activeFrame ? frames[1] : frames[0];
    pendingFrame = frame;
    lastLoadAt = Date.now();

    frame.onload = function () {
      if (pendingFrame !== frame) return;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        showFrame(frame);
      }, SETTLE_MS);
    };

    pendingTimer = setTimeout(function () {
      if (pendingFrame !== frame) return;
      // Never loaded. If nothing is on screen yet, show whatever arrived; otherwise keep the old page.
      if (!activeFrame) {
        showFrame(frame);
      } else {
        pendingFrame = null;
        blank(frame);
      }
    }, LOAD_TIMEOUT_MS);

    frame.src = scheduleSrc();
  }

  function showFrame(frame) {
    if (pendingFrame !== frame || isNight) return;
    pendingFrame = null;
    var previous = activeFrame;
    activeFrame = frame;
    frame.classList.add("is-active");
    if (previous && previous !== frame) {
      previous.classList.remove("is-active");
      blank(previous);
    }
    finishSplash();
  }

  function blank(frame) {
    frame.onload = null;
    frame.classList.remove("is-active");
    frame.src = "about:blank";
  }

  function clearSchedule() {
    clearTimeout(pendingTimer);
    pendingFrame = null;
    activeFrame = null;
    frames.forEach(blank);
  }

  // ---------- Day / night ----------

  function tick() {
    if (!running) return;
    keepAwake();

    if (Date.now() - settingsLoadedAt >= config.settingsRefreshMinutes * 60 * 1000) loadSettings();

    var day = isDaytime(now());
    if (!day && isNight !== true) {
      isNight = true;
      body.classList.add("is-night");
      clearSchedule();
      finishSplash();
    } else if (day && isNight !== false) {
      isNight = false;
      // Stay black until the fresh schedule is ready, then reveal it.
      loadSchedule();
      whenShown(function () {
        body.classList.remove("is-night");
      });
    } else if (day && config.refreshMinutes > 0) {
      if (Date.now() - lastLoadAt >= config.refreshMinutes * 60 * 1000) loadSchedule();
    }
  }

  function whenShown(callback) {
    var started = Date.now();
    (function wait() {
      if (activeFrame || Date.now() - started > LOAD_TIMEOUT_MS) return callback();
      setTimeout(wait, 250);
    })();
  }

  function showNightHint() {
    var t = now();
    var next = Schedule.nextStart(settings, t.day, t.minutes);
    nightClock.textContent = Schedule.formatClock(t.minutes);
    nightText.textContent = next ? "Розклад увімкнеться " + next : "";
    night.classList.add("show-hint");
    clearTimeout(nightHintTimer);
    nightHintTimer = setTimeout(function () {
      night.classList.remove("show-hint");
    }, NIGHT_HINT_MS);
  }

  // ---------- Splash ----------

  function launch() {
    if (running) return;
    running = true;
    stopCountdown();
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (e) {}

    enterFullscreen();
    keepAwake();

    splash.classList.add("is-launching");
    note.textContent = "Завантаження розкладу…";
    button.disabled = true;
    body.classList.add("is-running");

    setTimeout(finishSplash, SPLASH_MAX_WAIT_MS);
    tick();
    setInterval(tick, TICK_MS);
  }

  function finishSplash() {
    if (splashDone || !running) return;
    splashDone = true;
    splash.classList.add("is-gone");
    setTimeout(function () {
      splash.setAttribute("hidden", "");
    }, 1000);
  }

  function startCountdown(seconds) {
    var left = Math.ceil(seconds);
    splash.style.setProperty("--countdown", seconds + "s");
    splash.classList.add("is-counting");
    var render = function () {
      note.textContent = "Автозапуск через " + left + " с";
    };
    render();
    countdownTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        launch();
      } else {
        render();
      }
    }, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    splash.classList.remove("is-counting");
  }

  function wasLaunchedBefore() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  // ---------- Events ----------

  button.addEventListener("click", launch);

  // Any key or tap once running: re-enter fullscreen (needs a user gesture) and, at night,
  // briefly show when the schedule comes back.
  function onUserInput() {
    if (!running) return;
    enterFullscreen();
    keepAwake();
    if (isNight) showNightHint();
  }
  document.addEventListener("keydown", onUserInput);
  document.addEventListener("pointerdown", onUserInput);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && running) tick();
  });

  window.addEventListener("online", function () {
    if (running && !isNight) loadSchedule();
  });

  // ---------- Boot ----------

  // Start the invisible video as early as the browser allows; it is muted, so autoplay is permitted.
  keepAwake();
  loadSettings();

  // Let the intro animation finish before offering the button to the remote's OK key.
  setTimeout(function () {
    splash.classList.remove("is-intro");
    if (!running) button.focus({ preventScroll: true });
    if (!running && config.autostartSeconds > 0 && wasLaunchedBefore()) {
      startCountdown(config.autostartSeconds);
    }
  }, 2200);
})();
