(function () {
  "use strict";

  var STORAGE_KEY = "tv-schedule:launched";
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
      on: parseClock(pick("on", base.on), 8 * 60),
      off: parseClock(pick("off", base.off), 20 * 60),
      timeZone: pick("tz", base.timeZone),
      refreshMinutes: toNumber(pick("refresh", base.refreshMinutes), 10),
      autostartSeconds: toNumber(pick("autostart", base.autostartSeconds), 15),
      // Testing only: pretend the clock shows this time, e.g. ?time=21:30
      fakeTime: params.has("time") ? parseClock(params.get("time"), null) : null,
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

  function formatClock(minutes) {
    var h = Math.floor(minutes / 60) % 24;
    var m = minutes % 60;
    return pad(h) + ":" + pad(m);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function scheduleSrc() {
    var url = config.scheduleUrl;
    if (config.rooms) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "rooms=" + config.rooms;
    }
    return url;
  }

  // ---------- Time ----------

  var clockFormat = (function () {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: config.timeZone || undefined,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch (e) {
      // Unknown time zone on an old TV browser: fall back to the device clock.
      return null;
    }
  })();

  function minutesNow() {
    if (config.fakeTime !== null) return config.fakeTime;
    var now = new Date();
    if (clockFormat && clockFormat.formatToParts) {
      var h = 0;
      var m = 0;
      clockFormat.formatToParts(now).forEach(function (part) {
        if (part.type === "hour") h = Number(part.value) % 24;
        if (part.type === "minute") m = Number(part.value);
      });
      return h * 60 + m;
    }
    return now.getHours() * 60 + now.getMinutes();
  }

  function isDaytime(minutes) {
    if (config.on === config.off) return true;
    if (config.on < config.off) return minutes >= config.on && minutes < config.off;
    // Window that crosses midnight, e.g. on=20:00 off=02:00.
    return minutes >= config.on || minutes < config.off;
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

    var day = isDaytime(minutesNow());
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
    nightClock.textContent = formatClock(minutesNow());
    nightText.textContent = "Розклад увімкнеться о " + formatClock(config.on);
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

  // Let the intro animation finish before offering the button to the remote's OK key.
  setTimeout(function () {
    splash.classList.remove("is-intro");
    if (!running) button.focus({ preventScroll: true });
    if (!running && config.autostartSeconds > 0 && wasLaunchedBefore()) {
      startCountdown(config.autostartSeconds);
    }
  }, 2200);
})();
