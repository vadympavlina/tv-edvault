// Connection from a TV to the settings server (worker/).
//
// A WebSocket stays open: the server pushes new hours and reload requests the moment they are
// saved, and sees the TV as online for as long as the socket lives. Every 30 s the TV sends
// "ping"; Cloudflare answers "pong" by itself, so the server sleeps (and costs nothing) between
// real events. A missing pong means the line is dead: close and reconnect with a growing,
// jittered delay. While the socket is down the TV falls back to a plain HTTP check-in every
// few minutes, so hours still arrive even through a proxy that blocks WebSockets.
(function () {
  "use strict";

  var PING_MS = 30 * 1000;
  var PONG_TIMEOUT_MS = 10 * 1000;
  var CONNECT_TIMEOUT_MS = 15 * 1000;
  var RETRY_MIN_MS = 1000;
  var RETRY_MAX_MS = 60 * 1000;
  // Start HTTP check-ins once the socket has been down this long, then repeat at this pace.
  var FALLBACK_AFTER_MS = 20 * 1000;
  var FALLBACK_EVERY_MS = 5 * 60 * 1000;
  // Re-read the server clock now and then; TV clocks drift.
  var TIME_EVERY_MS = 6 * 60 * 60 * 1000;

  function start(options) {
    var apiUrl = options.apiUrl;
    var ws = null;
    var attempt = 0;
    var timers = {};
    var downSince = Date.now();
    var lastFallbackAt = 0;
    var status = options.status();

    function clear(name) {
      clearTimeout(timers[name]);
      clearInterval(timers[name]);
      timers[name] = null;
    }

    function params() {
      var s = options.status();
      var q = {
        id: options.id,
        name: options.name || "",
        state: s.state,
        size: s.size || "",
        startedAt: String(s.startedAt || 0),
      };
      return Object.keys(q)
        .map(function (k) {
          return encodeURIComponent(k) + "=" + encodeURIComponent(q[k]);
        })
        .join("&");
    }

    function connect() {
      clear("retry");
      if (!("WebSocket" in window)) return;
      try {
        ws = new WebSocket(apiUrl.replace(/^http/, "ws") + "/tv/ws?" + params());
      } catch (e) {
        return scheduleRetry();
      }
      var socket = ws;

      // Some networks accept the connection and then never complete it.
      timers.connect = setTimeout(function () {
        if (socket.readyState !== WebSocket.OPEN) drop(socket);
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = function () {
        clear("connect");
        attempt = 0;
        downSince = 0;
        status = options.status();
        // The state rode along in the URL; a stuck schedule has to be reported separately.
        if (status.stale) sendJson(socket, { type: "status", state: status.state, stale: true });
        timers.ping = setInterval(function () {
          ping(socket);
        }, PING_MS);
        timers.time = setInterval(function () {
          sendJson(socket, { type: "time" });
        }, TIME_EVERY_MS);
      };

      socket.onmessage = function (event) {
        if (event.data === "pong") return clear("pong");
        var data;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (data.type && options.on[data.type]) options.on[data.type](data);
      };

      socket.onclose = function () {
        if (socket !== ws) return;
        ws = null;
        ["connect", "ping", "pong", "time"].forEach(clear);
        if (!downSince) downSince = Date.now();
        scheduleRetry();
      };
    }

    function ping(socket) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send("ping");
      clear("pong");
      timers.pong = setTimeout(function () {
        drop(socket); // no answer: the connection is dead even if the browser has not noticed
      }, PONG_TIMEOUT_MS);
    }

    // Close and let onclose schedule the reconnect; some browsers never fire onclose for a
    // socket that died silently, so do the bookkeeping here as well.
    function drop(socket) {
      try {
        socket.close();
      } catch (e) {}
      if (socket.onclose) socket.onclose();
    }

    function scheduleRetry() {
      if (timers.retry) return;
      var delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * Math.pow(2, attempt));
      delay = delay / 2 + Math.random() * (delay / 2); // spread TVs out after an outage
      attempt += 1;
      timers.retry = setTimeout(connect, delay);
    }

    function sendJson(socket, message) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    // Plain HTTP check-in: used before the first socket opens and while it is down.
    function fallback() {
      lastFallbackAt = Date.now();
      var s = options.status();
      return fetch(apiUrl + "/tv", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "text/plain" }, // a "simple" request: no CORS preflight
        body: JSON.stringify({
          id: options.id,
          name: options.name || "",
          state: s.state,
          stale: s.stale,
          size: s.size || "",
          startedAt: s.startedAt || 0,
        }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          options.on.hello(data);
        })
        .catch(function () {
          if (options.on.offline) options.on.offline();
        });
    }

    // Light watchdog: fallback check-ins and an immediate retry when the network returns.
    setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) return;
      var down = Date.now() - downSince;
      if (down >= FALLBACK_AFTER_MS && Date.now() - lastFallbackAt >= FALLBACK_EVERY_MS) fallback();
    }, 5000);

    window.addEventListener("online", function () {
      attempt = 0;
      if (!ws) connect();
    });

    if ("WebSocket" in window) connect();
    else fallback();

    return {
      // Tell the server about a change in what the TV shows.
      status: function () {
        var s = options.status();
        if (s.state === status.state && s.stale === status.stale) return;
        status = s;
        sendJson(ws, { type: "status", state: s.state, stale: s.stale });
      },
    };
  }

  window.TVLink = { start: start };
})();
