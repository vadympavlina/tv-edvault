// The shell around the TV app (index.html; the app itself is app.html in an iframe).
//
// A browser leaves fullscreen whenever the page reloads, and only a key press can bring it
// back. So this page never reloads: it holds fullscreen and the keep-awake video, and replaces
// what runs inside it instead. Kept deliberately small and stable; the working part lives in
// shell-core.js, which is swapped on the fly after a deploy (see `upgrade`).
(function () {
  "use strict";

  var keepalive = document.getElementById("keepalive");
  var core = null;
  var coreVersion = null;
  var wakeLock = null;

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

  // Called by shell-core.js when it loads: stop the running core and let the new one carry on
  // with its app frame.
  function install(next, version) {
    var state = null;
    if (core) {
      try {
        state = core.stop();
      } catch (e) {}
    }
    core = next;
    coreVersion = version;
    core.start(state);
  }

  // Load shell-core.js of a newer deploy. `onFail` runs if it cannot be loaded.
  function upgrade(version, onFail) {
    if (version === coreVersion) return;
    var script = document.createElement("script");
    script.src = "shell-core.js?v=" + encodeURIComponent(version);
    script.onload = function () {
      script.remove();
    };
    script.onerror = function () {
      script.remove();
      if (onFail) onFail();
    };
    document.head.appendChild(script);
  }

  // Used by the app inside (app.js) and by shell-core.js.
  window.TVShell = {
    apiVersion: 2,
    install: install,
    upgrade: upgrade,
    enterFullscreen: enterFullscreen,
    keepAwake: keepAwake,
    ready: function (win) {
      if (core) core.ready(win);
    },
    restartApp: function () {
      if (core) core.restartApp();
    },
  };

  // Keys and clicks that land on the shell instead of the app (focus lost) still count.
  function forwardInput() {
    if (core) core.forwardInput();
  }
  document.addEventListener("keydown", forwardInput);
  document.addEventListener("pointerdown", forwardInput);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") keepAwake();
  });

  // Save the site in the browser so a TV can start it without network (sw.js).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  keepAwake();
})();
