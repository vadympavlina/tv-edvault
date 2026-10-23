(function () {
  "use strict";

  var STORAGE_KEY = "tv-schedule:launched";
  var SETTINGS_CACHE_KEY = "tv-schedule:settings";
  var OVERRIDE_CACHE_KEY = "tv-schedule:override";
  var SHELL_RELOAD_KEY = "tv-schedule:shell-reload";
  var STATIC_SETTINGS_EVERY_MS = 5 * 60 * 1000;
  var STALE_MIN_MS = 30 * 60 * 1000;
  var SCREEN_ID_KEY = "tv-schedule:screen-id";
  var Schedule = window.TVSchedule;
  var TICK_MS = 15 * 1000;
  var LOAD_TIMEOUT_MS = 60 * 1000;
  // Give the schedule's own scripts a moment to render before swapping it in.
  var SETTLE_MS = 1200;
  var SPLASH_MAX_WAIT_MS = 12 * 1000;
  var NIGHT_HINT_MS = 5000;
  var PROBE_TIMEOUT_MS = 8000;
  var NET_RETRY_MS = 30 * 1000;

  var config = readConfig();
  // Inside the shell (index.html) fullscreen, keep-awake and restarts belong to it.
  var shell = (function () {
    try {
      return window.parent !== window && window.parent.TVShell ? window.parent.TVShell : null;
    } catch (e) {
      return null; // not our page around us
    }
  })();

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
  var settings = cached(SETTINGS_CACHE_KEY, Schedule.normalize, Schedule.defaults());
  var override = cached(OVERRIDE_CACHE_KEY, Schedule.normalizeOverride, null);
  var link = null;
  var probing = false;
  var waitingNet = false;
  var stale = false; // the schedule has not refreshed for a long time
  var dayStartedAt = 0;
  var clockOffset = 0; // server time minus this TV's clock
  var knownReloadAt = null;
  var scheduleShownAt = 0;
  var startedAt = Date.now();

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
      apiUrl: String(pick("api", window.TV_API_URL || "")).replace(/\/+$/, ""),
      screenName: pick("name", ""),
      settingsUrl: base.settingsUrl || "settings.json",
      timeZone: pick("tz", base.timeZone),
      refreshMinutes: toNumber(pick("refresh", base.refreshMinutes), 10),
      autostartSeconds: toNumber(pick("autostart", base.autostartSeconds), 15),
      // Testing only: pretend the clock shows this day/time, e.g. ?day=sat&time=21:30
      fakeTime: params.has("time") ? parseClock(params.get("time"), null) : null,
      fakeDay: params.has("day") ? Schedule.DAYS.indexOf(params.get("day")) : -1,
      // Set by the shell when it swaps in a fresh copy: start straight away, no splash.
      resume: params.get("resume") === "1",
      shiftPixels: toNumber(pick("shift", base.shiftPixels), 4),
      shiftMinutes: Math.max(1, toNumber(base.shiftMinutes, 4)),
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
    var t = Schedule.now(config.timeZone, clockOffset);
    if (config.fakeDay !== -1) t.day = config.fakeDay;
    if (config.fakeTime !== null) t.minutes = config.fakeTime;
    return t;
  }

  // Saved settings plus the manual "now" override from the settings page.
  function effective() {
    return { days: settings.days, exceptions: settings.exceptions, override: override };
  }

  function isDaytime(t) {
    return Schedule.isOn(effective(), t);
  }

  // ---------- Settings sync ----------

  function cached(key, normalize, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) {}
    return fallback;
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function applySettings(raw) {
    settings = Schedule.normalize(raw);
    store(SETTINGS_CACHE_KEY, settings);
    tick();
  }

  function applyOverride(raw) {
    override = Schedule.normalizeOverride(raw);
    store(OVERRIDE_CACHE_KEY, override);
    tick();
  }

  function screenId() {
    try {
      var id = localStorage.getItem(SCREEN_ID_KEY);
      if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        localStorage.setItem(SCREEN_ID_KEY, id);
      }
      return id;
    } catch (e) {
      return "";
    }
  }

  // What this TV shows, for the settings page's list of screens.
  function status() {
    return {
      state: !running ? "splash" : isNight ? "night" : "schedule",
      stale: stale,
      loadedAt: scheduleShownAt, // when the schedule on screen was last (re)loaded
      size: window.screen ? screen.width + "×" + screen.height : "",
      startedAt: startedAt,
    };
  }

  function setServerTime(serverTime) {
    if (serverTime) clockOffset = serverTime - Date.now();
  }

  // A reload asked for before this page loaded is history; only a newer one counts.
  function checkReload(reloadAt) {
    reloadAt = reloadAt || 0;
    if (knownReloadAt === null) knownReloadAt = reloadAt;
    else if (reloadAt > knownReloadAt) {
      knownReloadAt = reloadAt;
      restart();
    }
  }

  // The shell swaps in a fresh copy without leaving fullscreen; on our own, reload the page.
  function restart() {
    if (shell) shell.restartApp();
    else location.reload();
  }

  // Tell the shell this copy has something to show, so it can be swapped in.
  var readySent = false;
  function signalReady() {
    if (readySent || !shell) return;
    readySent = true;
    shell.ready(window);
  }

  // Hours, reload requests and the exact time from the settings server (see link.js); without
  // a server, re-read the static settings.json now and then.
  function connect() {
    if (!window.fetch) return;
    if (!config.apiUrl) {
      loadStaticSettings();
      setInterval(loadStaticSettings, STATIC_SETTINGS_EVERY_MS);
      return;
    }
    link = window.TVLink.start({
      apiUrl: config.apiUrl,
      id: screenId(),
      name: config.screenName,
      status: status,
      on: {
        hello: function (data) {
          setServerTime(data.serverTime);
          checkReload(data.reloadAt);
          applyOverride(data.override);
          if (data.settings) applySettings(data.settings);
          else loadStaticSettings(); // server has nothing saved yet
        },
        settings: function (data) {
          setServerTime(data.serverTime);
          applyOverride(data.override);
          if (data.settings) applySettings(data.settings);
        },
        reload: function (data) {
          checkReload(data.reloadAt);
        },
        // This one TV was asked to restart from the settings page.
        restart: restart,
        time: function (data) {
          setServerTime(data.serverTime);
        },
        offline: loadStaticSettings,
      },
    });
  }

  function reportStatus() {
    if (link) link.status();
  }

  function loadStaticSettings() {
    var url = config.settingsUrl + (config.settingsUrl.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(applySettings)
      .catch(function () {});
  }

  // ---------- Keep the screen awake ----------

  function keepAwake() {
    if (shell) return shell.keepAwake();
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
    if (shell) return shell.enterFullscreen(); // the key press counts for the shell too
    var el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      var req = el.requestFullscreen
        ? el.requestFullscreen({ navigationUI: "hide" })
        : el.webkitRequestFullscreen && el.webkitRequestFullscreen();
      if (req && req.catch) req.catch(function () {});
    } catch (e) {}
  }

  // A shell from before shell-core.js cannot update itself. Reload the whole page once, while
  // the screen is black anyway; from then on the shell updates on the fly.
  function replaceOldShell() {
    if (!shell || shell.apiVersion) return;
    try {
      var last = Number(localStorage.getItem(SHELL_RELOAD_KEY)) || 0;
      if (Date.now() - last < 12 * 60 * 60 * 1000) return;
      localStorage.setItem(SHELL_RELOAD_KEY, String(Date.now()));
      window.parent.location.reload();
    } catch (e) {}
  }

  // ---------- Burn-in protection ----------

  // The schedule stays on screen for hours. Every few minutes the whole picture drifts to the
  // next spot on a small circle, so no pixel shows exactly the same thing all day. The move
  // takes a minute (styles.css), far too slow to notice.
  var SHIFT_SPOTS = [
    [0, 0],
    [1, -1],
    [2, 0],
    [1, 1],
    [0, 2],
    [-1, 1],
    [-2, 0],
    [-1, -1],
    [0, -2],
  ];
  var shiftIndex = 0;

  function startShift() {
    var px = config.shiftPixels;
    if (!px) return;
    setInterval(function () {
      shiftIndex = (shiftIndex + 1) % SHIFT_SPOTS.length;
      var spot = SHIFT_SPOTS[shiftIndex];
      document.documentElement.style.setProperty("--shift-x", (spot[0] * px) / 2 + "px");
      document.documentElement.style.setProperty("--shift-y", (spot[1] * px) / 2 + "px");
    }, config.shiftMinutes * 60 * 1000);
  }

  // ---------- Schedule frames ----------

  // Load the schedule, but only after checking its site answers at all: otherwise the browser
  // would put its own error page on screen (after a power cut the router often comes back
  // later than the TV). Until then the old page stays, or the splash says it is waiting.
  function loadSchedule() {
    if (pendingFrame || probing) return;
    lastLoadAt = Date.now();
    probing = true;
    reachable().then(function (ok) {
      probing = false;
      if (!running || isNight) return;
      setWaiting(!ok);
      if (ok) startLoad();
      else if (activeFrame && config.refreshMinutes > 0) {
        // Keep the page on screen and try again soon instead of a full refresh interval later.
        lastLoadAt = Date.now() - config.refreshMinutes * 60 * 1000 + NET_RETRY_MS;
      }
    });
  }

  function reachable() {
    if (navigator.onLine === false) return Promise.resolve(false);
    var origin;
    try {
      origin = new URL(scheduleSrc(), location.href).origin;
    } catch (e) {
      return Promise.resolve(true);
    }
    // An opaque no-cors answer is enough: any HTTP response means the site is reachable.
    var probe = fetch(origin + "/favicon.ico?t=" + Date.now(), { mode: "no-cors", cache: "no-store" }).then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        resolve(false);
      }, PROBE_TIMEOUT_MS);
    });
    return Promise.race([probe, timeout]);
  }

  function setWaiting(on) {
    if (waitingNet === on) return;
    waitingNet = on;
    if (!splashDone) note.textContent = on ? "Немає зв'язку з сайтом розкладу. Чекаємо на інтернет…" : "Завантаження розкладу…";
  }

  function startLoad() {
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
    scheduleShownAt = Date.now();
    frame.classList.add("is-active");
    if (previous && previous !== frame) {
      previous.classList.remove("is-active");
      blank(previous);
    }
    finishSplash();
    signalReady();
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

    var day = isDaytime(now());
    if (!day && isNight !== true) {
      isNight = true;
      body.classList.add("is-night");
      clearSchedule();
      finishSplash();
      signalReady();
    } else if (day && isNight !== false) {
      isNight = false;
      dayStartedAt = Date.now();
      // Stay black until the fresh schedule is ready, then reveal it.
      loadSchedule();
      whenShown(function () {
        body.classList.remove("is-night");
      });
    } else if (day && !activeFrame) {
      // Nothing on screen yet (no network so far): keep trying.
      if (!pendingFrame && Date.now() - lastLoadAt >= NET_RETRY_MS) loadSchedule();
    } else if (day && config.refreshMinutes > 0) {
      if (Date.now() - lastLoadAt >= config.refreshMinutes * 60 * 1000) loadSchedule();
    }

    if (isNight) replaceOldShell();

    // Flag a schedule that has not loaded for a long while (site down, network gone).
    var lastGood = Math.max(scheduleShownAt, dayStartedAt);
    var limit = config.refreshMinutes > 0 ? Math.max(STALE_MIN_MS, 3 * config.refreshMinutes * 60 * 1000) : STALE_MIN_MS;
    stale = !isNight && (config.refreshMinutes > 0 || !activeFrame) && Date.now() - lastGood > limit;
    reportStatus();
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
    var next = Schedule.nextStart(effective(), t, config.timeZone);
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

    setTimeout(function () {
      if (!waitingNet) finishSplash(); // while waiting for the network the splash says so
    }, SPLASH_MAX_WAIT_MS);
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

  window.TVApp = {
    userInput: onUserInput,
    isRunning: function () {
      return running;
    },
  };

  // Start the invisible video as early as the browser allows; it is muted, so autoplay is permitted.
  keepAwake();
  startShift();

  // Offline start (sw.js). The shell registers it too, but a TV keeps its shell for good while
  // the app inside gets updated, so the app makes sure.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  if (config.resume) {
    // A fresh copy swapped in by the shell: the old one was already running. Launch before
    // connecting, so the server never hears "splash" from it.
    splash.setAttribute("hidden", "");
    splashDone = true;
    launch();
    connect();
    return;
  }

  connect();

  // Let the intro animation finish before offering the button to the remote's OK key.
  setTimeout(function () {
    splash.classList.remove("is-intro");
    if (!running) button.focus({ preventScroll: true });
    if (!running && config.autostartSeconds > 0 && wasLaunchedBefore()) {
      startCountdown(config.autostartSeconds);
    }
  }, 2200);
})();
