// Run: node tests/alerts.test.mjs  (also runs in CI before every deploy)
import assert from "node:assert";
import { summarize, sameState, summarizeIot, oblastPlaces, combine, oblastRecords } from "../worker/src/alerts.js";

const alert = (over) => ({
  location_type: "oblast",
  location_uid: "5",
  location_oblast_uid: "5",
  location_title: "Рівненська область",
  alert_type: "air_raid",
  alert_level: "red",
  started_at: "2026-10-23T10:00:00.000Z",
  finished_at: null,
  ...over,
});

// Nothing at all.
assert.deepStrictEqual(summarize([]), { level: "none" });

// Oblast-wide red air raid covers Rivne.
let s = summarize([alert()]);
assert.strictEqual(s.level, "red");
assert.strictEqual(s.kind, "air_raid");
assert.strictEqual(s.since, Date.parse("2026-10-23T10:00:00.000Z"));

// Yellow (early warning) for the oblast.
assert.strictEqual(summarize([alert({ alert_level: "yellow" })]).level, "yellow");

// Another oblast: ignored.
assert.strictEqual(summarize([alert({ location_uid: "8", location_oblast_uid: "8", location_title: "Волинська область" })]).level, "none");

// Another raion / hromada in our oblast: ignored.
assert.strictEqual(summarize([alert({ location_type: "raion", location_uid: "70", location_title: "Сарненський район" })]).level, "none");
assert.strictEqual(summarize([alert({ location_type: "hromada", location_uid: "900", location_title: "Здолбунівська міська громада" })]).level, "none");

// Our raion, our city, our hromada: counted.
assert.strictEqual(summarize([alert({ location_type: "raion", location_uid: "71", location_title: "Рівненський район" })]).level, "red");
assert.strictEqual(summarize([alert({ location_type: "city", location_uid: "901", location_title: "м. Рівне" })]).level, "red");
assert.strictEqual(summarize([alert({ location_type: "hromada", location_uid: "902", location_title: "Рівненська міська територіальна громада" })]).level, "red");

assert.strictEqual(summarize([alert({ location_type: "city", location_uid: "903", location_title: "м. Рівне та Рівненська територіальна громада" })]).level, "red");
assert.strictEqual(summarize([alert({ location_type: "hromada", location_uid: "904", location_title: "Рівненська громада" })]).level, "red");

// Finished alerts do not count.
assert.strictEqual(summarize([alert({ finished_at: "2026-10-23T11:00:00.000Z" })]).level, "none");

// Red wins over yellow; other kinds are full screen and win over an air raid when more serious.
s = summarize([alert({ alert_level: "yellow" }), alert({ alert_type: "chemical", alert_level: undefined, started_at: "2026-10-23T10:30:00.000Z" })]);
assert.deepStrictEqual([s.level, s.kind], ["red", "chemical"]);
s = summarize([alert({ alert_type: "artillery_shelling" }), alert({ started_at: "2026-10-23T09:00:00.000Z" })]);
assert.deepStrictEqual([s.level, s.kind, s.since], ["red", "air_raid", Date.parse("2026-10-23T09:00:00.000Z")]);

// Air raid without a level (older records) is red; unknown alert types are ignored.
assert.strictEqual(summarize([alert({ alert_level: undefined })]).level, "red");
assert.strictEqual(summarize([alert({ alert_type: "something_new" })]).level, "none");

// Comparing states.
assert.ok(sameState({ level: "none" }, { level: "none" }));
assert.ok(!sameState({ level: "none" }, { level: "red", kind: "air_raid", since: 1 }));
assert.ok(!sameState({ level: "red", kind: "air_raid", since: 1 }, { level: "red", kind: "air_raid", since: 2 }));

// Real records from the live API (24.10.2026): raions carry their own uid in
// location_oblast_uid and the oblast only by name.
const live = (over) => ({
  location_type: "raion",
  location_oblast: "Рівненська область",
  alert_type: "air_raid",
  alert_level: "yellow",
  started_at: "2026-10-24T06:57:22.186Z",
  finished_at: null,
  ...over,
});
s = summarize([
  live({ location_title: "Рівненський район", location_uid: "112", location_oblast_uid: 112 }),
  live({ location_title: "Сарненський район", location_uid: "113", location_oblast_uid: 113 }),
]);
assert.deepStrictEqual([s.level, s.since, s.places], ["yellow", Date.parse("2026-10-24T06:57:22.186Z"), ["Рівненський район"]]);
assert.strictEqual(
  summarize([live({ location_title: "Сарненський район", location_uid: "113", location_oblast_uid: 113 })]).level,
  "none"
);
assert.strictEqual(
  summarize([live({ location_title: "Луцький район", location_uid: "40", location_oblast_uid: 40, location_oblast: "Волинська область" })]).level,
  "none"
);
assert.deepStrictEqual(
  oblastPlaces([live({ location_title: "Рівненський район", location_uid: "112", location_oblast_uid: 112 })]).map((p) => p.counted),
  [true]
);

// Backup IoT string: index = location uid (5 = oblast, 112 = Rivne raion).
const iot = (marks) => {
  const chars = [" "].concat(Array(200).fill("N"));
  for (const uid in marks) chars[uid] = marks[uid];
  return chars.join("");
};
assert.strictEqual(summarizeIot(iot({})).level, "none");
assert.strictEqual(summarizeIot(iot({ 5: "R" })).level, "red");
assert.strictEqual(summarizeIot(iot({ 5: "A" })).level, "red");
assert.strictEqual(summarizeIot(iot({ 5: "Y" })).level, "yellow");
assert.strictEqual(summarizeIot(iot({ 5: "P", 112: "R" })).level, "red");
assert.strictEqual(summarizeIot(iot({ 5: "P", 113: "R" })).level, "none"); // Сарненський район
assert.strictEqual(summarizeIot(iot({ 8: "R" })).level, "none"); // another oblast
assert.strictEqual(summarizeIot("").level, "none");

// Place names in our oblast, marked whether they count.
const seen = oblastPlaces([
  alert({ location_type: "city", location_uid: "901", location_title: "м. Рівне" }),
  alert({ location_type: "raion", location_uid: "70", location_title: "Сарненський район" }),
  alert({ location_type: "raion", location_uid: "70", location_title: "Сарненський район" }),
  alert({ location_uid: "8", location_oblast_uid: "8", location_title: "Волинська область" }),
  alert({ location_type: "city", location_uid: "905", location_title: "м. Дубно", finished_at: "2026-10-23T11:00:00.000Z" }),
]);
assert.deepStrictEqual(seen.map((p) => [p.title, p.counted]), [["м. Рівне", true], ["Сарненський район", false]]);

// Cross-check: the light endpoint wins only when it says more.
const none = { level: "none" };
const red = { level: "red", kind: "chemical", since: 1 };
let c = combine(none, { level: "yellow", kind: "air_raid", since: 50 }, null);
assert.deepStrictEqual([c.state.level, c.state.since, c.source, c.disagree], ["yellow", 50, "iot", true]);
c = combine(none, { level: "yellow", kind: "air_raid", since: 90 }, { level: "yellow", since: 50 });
assert.strictEqual(c.state.since, 50); // keeps the start time it already had
c = combine(red, { level: "yellow", kind: "air_raid", since: 50 }, null);
assert.deepStrictEqual([c.state, c.source, c.disagree], [red, "api", false]);
c = combine({ level: "red", kind: "air_raid", since: 5 }, none, null); // e.g. a city-only alert
assert.deepStrictEqual([c.state.level, c.disagree], ["red", false]);
assert.strictEqual(combine(none, null, null).state, none); // light endpoint failed

// Records for "check now".
const rec = oblastRecords([
  live({ location_title: "Рівненський район", location_uid: "112", location_oblast_uid: 112, threats: [{ source_message: "Дронова загроза (жовтий рівень)" }] }),
  live({ location_title: "Сарненський район", location_uid: "113", location_oblast_uid: 113 }),
  alert({ location_uid: "8", location_oblast_uid: "8", location_title: "Волинська область" }),
]);
assert.deepStrictEqual(rec.map((r) => [r.title, r.counted, r.threats.length]), [["Рівненський район", true, 1], ["Сарненський район", false, 0]]);

console.log("alerts.js: all assertions passed");
