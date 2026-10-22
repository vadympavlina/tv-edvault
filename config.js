// Settings for the TV schedule screen. Any of them can also be overridden per TV with URL
// parameters, e.g.  index.html?name=Хол 1&rooms=186,189&refresh=5&autostart=0
// On/off hours for each weekday are edited on settings.html.
window.TV_CONFIG = {
  // Page that is shown on the TV. `rooms` is appended as ?rooms=...
  scheduleUrl: "https://lb.itstep.org/schedule",
  rooms: "186,189,192,134,92,89,67,1,4,3,68,9,8,66,10,7,6,75,73,70,5,69,72,78,81,180,175",

  // On/off hours, reload requests and the exact time come from the settings server
  // (worker/, its address is written to api-url.js on deploy). TVs ask it every `syncSeconds`.
  // settings.json is the fallback for when the server is missing or has nothing saved yet.
  settingsUrl: "settings.json",
  syncSeconds: 60,

  // Clock used for on/off. Kept explicit because TVs often ship with a wrong time zone.
  timeZone: "Europe/Kyiv",

  // Reload the schedule every N minutes (0 disables). The new page is loaded in the background
  // and swapped in only once it has loaded, so the screen never flashes.
  refreshMinutes: 10,

  // After the button has been pressed once on a TV, later visits (power cut, browser restart)
  // start by themselves after this many seconds. 0 disables auto-start.
  autostartSeconds: 15,
};
