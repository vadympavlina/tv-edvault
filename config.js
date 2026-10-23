// Settings for the TV schedule screen. Any of them can also be overridden per TV with URL
// parameters, e.g.  index.html?name=Хол 1&rooms=186,189&refresh=5&autostart=0
// On/off hours for each weekday are edited on settings.html.
window.TV_CONFIG = {
  // Page that is shown on the TV. `rooms` is appended as ?rooms=...
  scheduleUrl: "https://lb.itstep.org/schedule",
  rooms: "186,189,192,134,92,89,67,1,4,3,68,9,8,66,10,7,6,75,73,70,5,69,72,78,81,180,175",

  // On/off hours, reload requests and the exact time are pushed by the settings server over a
  // WebSocket (worker/, link.js; its address is written to api-url.js on deploy).
  // settings.json is the fallback for when the server is missing or has nothing saved yet.
  settingsUrl: "settings.json",

  // Clock used for on/off. Kept explicit because TVs often ship with a wrong time zone.
  timeZone: "Europe/Kyiv",

  // Reload the schedule every N minutes (0 disables). The new page is loaded in the background
  // and swapped in only once it has loaded, so the screen never flashes.
  refreshMinutes: 10,

  // Every night at this time the app is swapped for a fresh copy (clears what the TV browser
  // piles up over a day). Pick a time when the screen is black anyway. "" disables.
  nightlyRestart: "03:00",

  // Burn-in protection: the picture drifts by up to this many pixels, one small step every
  // `shiftMinutes`. 0 disables.
  shiftPixels: 4,
  shiftMinutes: 4,

  // While the screen is black, the animated logo shows up on its own every N minutes for about
  // 10 seconds. 0 disables.
  nightLogoMinutes: 15,

  // Air raid alerts: the place named on the alert screen. Which alerts count is decided by the
  // settings server (worker/src/alerts.js).
  alertPlace: "м. Рівне",

  // After the button has been pressed once on a TV, later visits (power cut, browser restart)
  // start by themselves after this many seconds. 0 disables auto-start.
  autostartSeconds: 15,
};
