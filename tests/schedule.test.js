// Run: node tests/schedule.test.js  (also runs in CI before every deploy)
require('../schedule.js');
const S = globalThis.TVSchedule, TZ = 'Europe/Kyiv';
const assert = require('assert');
const kyiv = (iso) => Date.parse(iso + '+03:00'); // EEST until 25 Oct 2026
// at / toMs round trip, incl. DST change (25 Oct 2026 04:00 EEST -> 03:00 EET)
const m = S.at(kyiv('2026-10-22T15:30:00'), TZ);
assert.deepStrictEqual([m.date, m.day, m.minutes], ['2026-10-22', 3, 930]);
assert.strictEqual(S.toMs('2026-10-22', 930, TZ), kyiv('2026-10-22T15:30:00'));
assert.strictEqual(S.toMs('2026-10-26', 8*60, TZ), Date.parse('2026-10-26T08:00:00+02:00'));
assert.strictEqual(S.toMs('2026-10-25', 1440, TZ), Date.parse('2026-10-26T00:00:00+02:00'));
const set = S.normalize({ days: { mon:{enabled:true,on:'14:00',off:'18:30'}, tue:{enabled:true,on:'14:00',off:'18:30'}, wed:{enabled:true,on:'14:00',off:'18:30'}, thu:{enabled:true,on:'14:00',off:'18:30'}, fri:{enabled:true,on:'14:00',off:'18:30'}, sat:{enabled:true,on:'08:00',off:'18:00'}, sun:{enabled:false,on:'08:00',off:'18:00'} },
  exceptions: [ {from:'2026-10-23', to:'2026-10-23', enabled:false, note:'Свято'}, {from:'2026-12-20', to:'2027-01-10', enabled:false, note:'Канікули'}, {from:'2026-12-28', to:'2026-12-28', enabled:true, on:'10:00', off:'12:00', note:'Олімпіада'}, {from:'bad'} ] });
assert.strictEqual(set.exceptions.length, 3);
// Thursday 15:30 on
assert.strictEqual(S.isOn(set, m), true);
// Friday 23rd is a holiday -> off; next start = Saturday 08:00
const fri = S.at(kyiv('2026-10-23T15:00:00'), TZ);
assert.strictEqual(S.isOn(set, fri), false);
assert.strictEqual(S.nextStart(set, fri, TZ), 'завтра о 08:00');
// Thursday evening: next change is Sat 08:00 (Fri off)
const thuEve = S.at(kyiv('2026-10-22T19:00:00'), TZ);
assert.strictEqual(S.nextStart(set, thuEve, TZ), 'у суботу о 08:00');
// on now -> nextChange is today's off
assert.strictEqual(S.nextChange(set, m, TZ), kyiv('2026-10-22T18:30:00'));
// Holidays: 21 Dec off; 28 Dec special 10-12 wins over the range
const dec21 = S.at(Date.parse('2026-12-21T15:00:00+02:00'), TZ);
assert.strictEqual(S.isOn(set, dec21), false);
assert.strictEqual(S.nextStart(set, dec21, TZ), '28 грудня о 10:00');
assert.strictEqual(S.isOn(set, S.at(Date.parse('2026-12-28T11:00:00+02:00'), TZ)), true);
// override: force off while on, until +1h
const o = { ...set, override: S.normalizeOverride({ mode: 'off', until: m.ms + 3600e3 }) };
assert.strictEqual(S.isOn(o, m), false);
assert.strictEqual(S.nextStart(o, m, TZ), 'о 16:30');
// override on during night until 2h later; next change = until
const o2 = { ...set, override: { mode: 'on', until: thuEve.ms + 7200e3 } };
assert.strictEqual(S.isOn(o2, thuEve), true);
assert.strictEqual(S.nextChange(o2, thuEve, TZ), thuEve.ms + 7200e3);
// expired override ignored
assert.strictEqual(S.isOn({ ...set, override: { mode: 'off', until: m.ms - 1 } }, m), true);
// prune
const p = S.pruneExceptions(S.normalize(set), '2027-03-20', 60);
assert.deepStrictEqual(p.exceptions.map(e=>e.note), []);
assert.strictEqual(S.pruneExceptions(S.normalize(set), '2027-02-01', 60).exceptions.length, 2);
console.log('schedule.js: all assertions passed');
