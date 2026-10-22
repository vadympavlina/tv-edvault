// The shell around the TV app (index.html -> app.html in an iframe).
//
// A browser leaves fullscreen whenever the page reloads, and only a key press can bring it
// back. So the shell is the page that stays: it holds fullscreen and the keep-awake video, and
// replaces the app inside it instead of reloading itself. A fresh copy of the app loads
// underneath the visible one and is raised only once it reports ready (schedule on screen or
// night mode on), so the swap is invisible. This happens:
//   - after a deploy (version.json changed),
//   - every night at `nightlyRestart`, to clear whatever the TV browser has piled up,
//   - when the settings page asks every TV to reload.
(function () {
  "use strict";

  var VERSION_EVERY_MS = 10 * 60 * 1000;
  var CLOCK_EVERY_MS = 30 * 1000;
  // A fresh copy that is not ready by then is thrown away; the old one keeps running.
  var READY_TIMEOUT_MS = 90 * 1000;
  var RETRY_AFTER_FAIL_MS = 15 * 60 * 1000;

  var config = window.TV_CONFIG || {};
  var Schedule = window.TVSchedule;
  var keepalive = document.getElementById("keepalive");
  var nightlyAt = Schedule.parseClock(config.nightlyRestart || "");

  var active = null; // iframe on screen
  var pending = null; // fresh copy loading underneath
  var pendingTimer = null;
  var version = null; // deployed version the active app came from
  var wakeLock = null;
  var lastFailAt = 0;
  var lastMinutes = null;

  // ---------- App frames ----------

  function appUrl(resume, v) {
    var params = new URLSearchParams(location.search);
    if (resume) params.set("resume", "1");
    if (v) params.set("v", v);
    var query = params.toString();
    return "app.html" + (query ? "?" + query : "");
  }

  function createFrame(src, isPending) {
    var frame = document.createElement("iframe");
    frame.className = "app" + (isPending ? " is-pending" : "");
    frame.title = "Розклад";
    frame.setAttribute("allow", "fullscreen; autoplay; screen-wake-lock");
    frame.src = src;
    frame.addEventListener("load", function () {
      if (frame === active) focusApp();
    });
    document.body.appendChild(frame);
    return frame;
  }

  function appOf(frame) {
    try {
      return frame && frame.contentWindow && frame.contentWindow.TVApp;
    } catch (e) {
      return null;
    }
  }

  function focusApp() {
    try {
      active.contentWindow.focus();
    } catch (e) {}
  }

  // Load a fresh copy of the app (already running, so it skips the splash) and swap it in
  // once it is ready.
  function restartApp(reason, v) {
    if (pending) return;
    var app = appOf(active);
    // Nobody has pressed "start" yet: a plain reload costs nothing.
    if (!app || !app.isRunning()) {
      active.src = appUrl(false, v || version);
      if (v) version = v;
      return;
    }
    pending = createFrame(appUrl(true, v || version), true);
    pending.dataset.version = v || version || "";
    pending.dataset.reason = reason;
    pendingTimer = setTimeout(function () {
      // Never got ready (network down, broken deploy): keep the old app.
      discardPending();
      lastFailAt = Date.now();
    }, READY_TIMEOUT_MS);
  }

  function discardPending() {
    clearTimeout(pendingTimer);
    if (pending) pending.remove();
    pending = null;
  }

  // Called by the fresh app once it has something to show.
  function ready(win) {
    if (!pending || pending.contentWindow !== win) return;
    clearTimeout(pendingTimer);
    var old = active;
    active = pending;
    pending = null;
    if (active.dataset.version) version = active.dataset.version;
    active.classList.remove("is-pending");
    focusApp();
    // Let the new copy paint on top before the old one goes away.
    setTimeout(function () {
      if (old) old.remove();
    }, 1000);
  }

  // ---------- Fullscreen & keep awake (used by the app) ----------

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
          setTimeout(keepAwake, 1000);
        });
      })
      .catch(function () {});
  }

  // ---------- Triggers ----------

  // version.json is written on deploy; without it (local runs) there is nothing to compare.
  function checkVersion() {
    if (!window.fetch) return;
    fetch("version.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var latest = data && data.version;
        if (!latest) return;
        if (version === null) version = latest;
        else if (latest !== version && Date.now() - lastFailAt > RETRY_AFTER_FAIL_MS) restartApp("deploy", latest);
      })
      .catch(function () {});
  }

  // Nightly restart: fire once when the clock passes `nightlyRestart`.
  function checkClock() {
    keepAwake();
    if (nightlyAt === null) return;
    var minutes = Schedule.now(config.timeZone).minutes;
    var prev = lastMinutes;
    lastMinutes = minutes;
    if (prev === null || prev === minutes) return;
    var crossed = minutes > prev ? prev < nightlyAt && nightlyAt <= minutes : nightlyAt > prev || nightlyAt <= minutes;
    if (crossed) restartApp("nightly");
  }

  // Keys and clicks that land on the shell instead of the app (focus lost) still count.
  function forwardInput() {
    var app = appOf(active);
    focusApp();
    if (app) app.userInput();
  }

  // ---------- Boot ----------

  window.TVShell = {
    enterFullscreen: enterFullscreen,
    keepAwake: keepAwake,
    ready: ready,
    restartApp: function () {
      restartApp("request");
    },
  };

  document.addEventListener("keydown", forwardInput);
  document.addEventListener("pointerdown", forwardInput);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") keepAwake();
  });

  // Save the site in the browser so a TV can start it without network (sw.js).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  active = createFrame(appUrl(false, null), false);
  keepAwake();
  checkVersion();
  setInterval(checkVersion, VERSION_EVERY_MS);
  setInterval(checkClock, CLOCK_EVERY_MS);
})();
