// Service worker: lets a TV start the app even when the network is not up yet (after a power
// cut the router often boots later than the TV). Without it the browser would show its own
// error page and stay there.
//
// Pages and scripts of this site: network first (a deploy shows up at once), the saved copy
// when the network fails or is too slow. Everything else (the schedule site, the settings
// server) is left alone. VERSION and PRECACHE are filled in on deploy.
var VERSION = "dev";
var PRECACHE = [];
var CACHE = "tv-schedule-" + VERSION;
var NETWORK_TIMEOUT_MS = 6000;
// Always live: an old answer would hide a deploy.
var NEVER_CACHE = /\/version\.json$/;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        // One missing file must not stop the rest from being saved.
        return Promise.all(
          PRECACHE.map(function (url) {
            return cache.add(new Request(url, { cache: "reload" })).catch(function () {});
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key.indexOf("tv-schedule-") === 0 && key !== CACHE) return caches.delete(key);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;
  event.respondWith(networkFirst(request, event));
});

function networkFirst(request, event) {
  var network = fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      event.waitUntil(
        caches.open(CACHE).then(function (cache) {
          return cache.put(request, copy);
        })
      );
    }
    return response;
  });

  return new Promise(function (resolve, reject) {
    var settled = false;
    function fromCache() {
      return fromCacheOrFail(request).then(function (cached) {
        if (cached && !settled) {
          settled = true;
          resolve(cached);
        }
        return cached;
      });
    }
    // A slow network: answer from the saved copy, the network still refreshes it.
    var timer = setTimeout(fromCache, NETWORK_TIMEOUT_MS);
    network.then(
      function (response) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(response);
        }
      },
      function (error) {
        clearTimeout(timer);
        fromCache().then(function (cached) {
          if (!cached && !settled) {
            settled = true;
            reject(error);
          }
        });
      }
    );
  });
}

// Exact match first; then the same file with any query (pages carry ?name=…, scripts ?v=…).
function fromCacheOrFail(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return cache.match(request, { ignoreSearch: true }).then(function (loose) {
        if (loose) return loose;
        // A bare "/" navigation and "/index.html" are the same page.
        if (request.mode === "navigate") {
          return cache.match("index.html", { ignoreSearch: true }).then(function (index) {
            return new URL(request.url).pathname.endsWith("/") ? index : null;
          });
        }
        return null;
      });
    });
  });
}
