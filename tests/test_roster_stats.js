'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../roster-stats.js');
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const players = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Игрок ${i + 1}` }));
const game = (id, size, performance, extra) => ({ id, name: `Турнир ${id}`, date: '2026-11-01', players: players(size), performance, ...extra });
const summarize = rows => R.summarize(rows, { performance: t => t.performance });

// Known Student-t intervals, rather than normal/percentile intervals. With two
// games there is one degree of freedom and uncertainty is deliberately wide.
let stats = R.meanInterval([1000, 2000]);
close(stats.mean, 1500); close(stats.sd, Math.sqrt(500000)); close(stats.se, 500);
close(stats.lower, -4853.102368216048, 1e-6); close(stats.upper, 7853.102368216048, 1e-6);
stats = R.meanInterval([2, 4, 6, 8, 10]);
close(stats.mean, 6); close(stats.sd, Math.sqrt(10));
close(stats.lower, 2.073513677044878, 1e-8); close(stats.upper, 9.926486322955123, 1e-8);
stats = R.meanInterval(Array.from({ length: 55 }, (_, i) => i + 1));
close((stats.upper - stats.mean) / stats.se, 2.004879288188057, 1e-8);
assert.equal(R.meanInterval([1500]).mean, 1500);
assert.equal(R.meanInterval([1500]).lower, null);
assert.equal(R.meanInterval([1500]).sd, null);
assert.equal(R.meanInterval([]).mean, null);
assert.equal(R.meanInterval([]).upper, null);
assert.equal(R.meanInterval([500, 500, 500]).lower, 500);
assert.equal(R.meanInterval([500, 500, 500]).upper, 500);
assert.equal(R.meanInterval([null, undefined, '', true, '600', NaN, Infinity, -Infinity]).count, 0);
close(R.meanInterval([10, null, 20, NaN]).mean, 15);
assert.throws(() => R.meanInterval([], { confidence: 1 }), RangeError);
assert.throws(() => R.meanInterval([], { confidence: 0 }), RangeError);
assert.throws(() => R.meanInterval([], { confidence: NaN }), RangeError);
assert.ok(R.meanInterval([10, 20, 30], { confidence: .99 }).lower < R.meanInterval([10, 20, 30]).lower);

// Each tournament gets equal weight even when package lengths differ. Missing
// performance is not zero; excluded games and unknown rosters stay auditable.
const rows = [game(1, 3, 1000, { totalQuestions: 36 }), game(2, 3, 3000, { totalQuestions: 90 }),
  game(3, 3, null), game(4, 4, 4000), game(5, 7, 7000), game(6, 6, 9999, { included: false }),
  game(7, 0, 2000), game(8, 5, NaN), game(9, 5, Infinity)];
const before = JSON.stringify(rows);
const result = summarize(rows), groups = result.groups;
assert.deepEqual(groups.map(g => g.size), [1, 2, 3, 4, 5, 6, 7]);
assert.equal(result.totalGames, 8); assert.equal(result.excludedGames, 1);
assert.equal(result.unknownRosterGames, 1); assert.equal(result.knownRosterGames, 7);
assert.equal(result.performanceGames, 5); assert.equal(result.groupedPerformanceGames, 4);
assert.equal(result.missingPerformanceGames, 3);
const three = groups.find(g => g.size === 3);
assert.equal(three.games, 3); assert.equal(three.count, 2); assert.equal(three.missingPerformance, 1);
assert.equal(three.mean, 2000); assert.equal(three.median, 2000);
assert.deepEqual(three.individualGames.map(g => g.id), [1, 2]);
assert.equal(groups.find(g => g.size === 4).lower, null);
assert.equal(groups.find(g => g.size === 5).mean, null);
assert.equal(groups.find(g => g.size === 1).count, 0);
assert.equal(JSON.stringify(rows), before);
assert.throws(() => R.summarize(rows), TypeError);
assert.deepEqual(summarize([]).groups.map(g => g.size), [1, 2, 3, 4, 5, 6]);
assert.equal(summarize([]).totalGames, 0);

// A seventh roster member must not be silently capped at six. Duplicated API
// IDs cannot manufacture an extra participant, but unidentifiable rows are not
// assumed absent. Empty players means no reliable roster, not solo play.
assert.equal(R.rosterSize(game(1, 7, 1)), 7);
assert.equal(R.rosterSize({ players: [{ id: 1 }, { id: 1 }, { id: 2 }] }), 2);
assert.equal(R.rosterSize({ players: [{ name: ' Анна  Иванова ' }, 'анна иванова'] }), 1);
assert.equal(R.rosterSize({ players: [{ id: 1, name: 'А' }, { id: 2, name: 'А' }] }), 2);
assert.equal(R.rosterSize({ players: [{ id: 1 }, {}] }), null);
assert.equal(R.rosterSize({ players: [] }), null);
assert.equal(R.rosterSize({}), null);

// The browser API works offline without CommonJS or a DOM.
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../roster-stats.js'), 'utf8'), context);
assert.equal(typeof context.window.SamuraiRosterStats.summarize, 'function');
assert.equal(context.window.SamuraiRosterStats.meanInterval([1, 3]).mean, 2);

console.log('roster statistics: Student-t references, missing data, roster sizes and browser export passed');
