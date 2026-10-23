// The working part of the shell (see shell.js): runs the app in an iframe and swaps in a fresh
// copy of it after a deploy, every night at `nightlyRestart` and on request. A fresh copy loads
// underneath the visible one and is raised only once it reports ready (schedule on screen or
// night mode on), so the swap is invisible.
//
// This file itself is replaced on the fly after a deploy: shell.js loads the new version,
// stops this one (which hands over the app frame) and starts the new one. The page never
// reloads, so the TV never leaves fullscreen.
(function () {
  "use strict";

  var VERSION_EVERY_MS = 10 * 60 * 1000;
  var CLOCK_EVERY_MS = 30 * 1000;
  // A fresh copy that is not ready by then is thrown away; the old one keeps running.
  var READY_TIMEOUT_MS = 90 * 1000;
  var RETRY_AFTER_FAIL_MS = 15 * 60 * 1000;

  var shell = window.TVShell;
  var config = window.TV_CONFIG || {};
  var Schedule = window.TVSchedule;
  var nightlyAt = Schedule.parseClock(config.nightlyRestart || "");
  var loadedAs = (function () {
    try {
      return new URL(document.currentScript.src).searchParams.get("v");
    } catch (e) {
      return null;
    }
  })();

  var active = null; // iframe on screen
  var pending = null; // fresh copy loading underneath
  var pendingTimer = null;
  var version = null; // deployed version the active app came from
  var lastFailAt = 0;
  var lastMinutes = null;
  var timers = [];

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
        if (latest === version || Date.now() - lastFailAt < RETRY_AFTER_FAIL_MS) return;
        // A deploy: first take the new shell code (it carries on from here and swaps the app);
        // if it cannot be loaded, at least bring in the new app.
        if (latest !== loadedAs && shell.upgrade) {
          shell.upgrade(latest, function () {
            restartApp("deploy", latest);
          });
        } else {
          restartApp("deploy", latest);
        }
      })
      .catch(function () {});
  }

  // Nightly restart: fire once when the clock passes `nightlyRestart`.
  function checkClock() {
    shell.keepAwake();
    if (nightlyAt === null) return;
    var minutes = Schedule.now(config.timeZone).minutes;
    var prev = lastMinutes;
    lastMinutes = minutes;
    if (prev === null || prev === minutes) return;
    var crossed = minutes > prev ? prev < nightlyAt && nightlyAt <= minutes : nightlyAt > prev || nightlyAt <= minutes;
    if (crossed) restartApp("nightly");
  }

  // ---------- Life cycle (called by shell.js) ----------

  shell.install(
    {
      // `state` comes from the previous shell code, if any.
      start: function (state) {
        if (state && state.active && state.active.isConnected) {
          active = state.active;
          version = state.version;
          lastMinutes = state.lastMinutes;
          lastFailAt = state.lastFailAt || 0;
        } else {
          active = createFrame(appUrl(false, null), false);
        }
        timers.push(setInterval(checkVersion, VERSION_EVERY_MS));
        timers.push(setInterval(checkClock, CLOCK_EVERY_MS));
        checkVersion();
      },
      // Stop everything and hand over what the next shell code needs.
      stop: function () {
        timers.forEach(clearInterval);
        timers = [];
        discardPending();
        return { active: active, version: version, lastMinutes: lastMinutes, lastFailAt: lastFailAt };
      },
      ready: ready,
      restartApp: function () {
        restartApp("request");
      },
      forwardInput: function () {
        var app = appOf(active);
        focusApp();
        if (app) app.userInput();
      },
    },
    loadedAs
  );
})();
