'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../analytics.js');
const R = require('../roster-stats.js');
const P = require('../personal-stats.js');
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const sameMean = (actual, values) => values.length ? close(actual, values.reduce((sum, value) => sum + value, 0) / values.length) : assert.equal(actual, null);
const person = (id, name = `Игрок ${id}`) => ({ id, name });
const game = (id, b, players, extra = {}) => ({ id, name: `Турнир ${id}`, date: `2025-01-${String(id).padStart(2, '0')}`,
  included: true, type: 3, typeName: 'Синхрон', rating: { b, inRating: true }, players: players.map(x => typeof x === 'object' ? x : person(x)),
  questionQty: [2], totalQuestions: 2, mask: '10', score: 1, fieldSize: 20, position: 5, ...extra });
const profile = (rows, options) => P.profile(rows, options, A, R);

// Identity is the API ID, not the displayed name. A repeated roster row cannot
// manufacture attendance; unpublished registrations cannot create players.
const rows = [
  game(1, 0, [person(1, 'Анна'), person(2, 'Алексей'), person('2', 'Алексей')], { date: '2024-09-01' }),
  game(2, 1000, [person('1', 'Анна'), person(2, 'Алексей'), person(3, 'Алексей')], { date: '2024-10-01', rating: { b: 1000, inRating: false } }),
  game(3, 2000, [person(1, 'Анна'), person(2, 'Алексей'), person(3, 'Алексей')], { date: '2025-01-01' }),
  game(4, null, [person(1, 'Анна'), person(2, 'Алексей'), person(4, 'Дарья')], { date: '2025-02-01', type: 8, typeName: 'Асинхрон', performance: 99999 }),
  game(5, 9999, [1, 999], { included: false }),
  game(6, 8000, [5, 2], { date: '2025-03-01' }),
  game(7, null, [6], { date: '2025-04-01' })
];
const before = JSON.stringify(rows);
let registry = P.registry(rows, A);
assert.equal(registry.length, 6);
assert.equal(registry.some(p => p.id === '999'), false);
assert.equal(registry.find(p => p.id === '2').games, 5);
assert.equal(registry.filter(p => p.name === 'Алексей').length, 2);
assert.deepEqual(registry.find(p => p.id === '1').years, ['2025', '2024']);
assert.equal(registry.find(p => p.id === '1').firstDate, '2024-09-01');
assert.equal(registry.find(p => p.id === '1').lastDate, '2025-02-01');

// All derived results, teammate pairs and intervals use only the selected
// player's tournaments. The unrelated strong tournament must not leak in.
let p = profile(rows, { playerId: '1' });
assert.equal(p.player.id, '1');
assert.deepEqual(p.games.map(t => t.id), [1, 2, 3, 4]);
assert.equal(p.summary.games, 4);
assert.equal(p.summary.performanceGames, 3);
assert.equal(p.summary.missingPerformanceGames, 1);
assert.equal(p.summary.avgPerformance, 1000);
assert.equal(p.summary.medianPerformance, 1000);
assert.equal(p.best.id, 3);
assert.equal(p.worst.id, 1, 'Observed zero B remains the worst performance');
assert.equal(p.interval.count, 3);
close(p.interval.lower, -1484.137711719546, 1e-6);
close(p.interval.upper, 3484.137711719546, 1e-6);
assert.equal(p.coverage.teamGames, 6);
assert.equal(p.coverage.playerGames, 4);
assert.equal(p.coverage.selectedGames, 4);
assert.equal(p.teammates.some(t => t.id === '1'), false);
const common = p.teammates.find(t => t.id === '2');
assert.equal(common.games, 4);
assert.equal(common.performanceGames, 3);
assert.equal(common.mean, 1000, 'Do not include a teammate tournament without the selected player');
assert.equal(common.median, 1000);
assert.equal(common.lower, p.interval.lower);
assert.equal(common.eligible, true);
assert.deepEqual(p.bestTeammates.map(t => t.id), ['2']);
assert.deepEqual(p.bestTeammates.map(t => t.rank), [1]);
assert.equal(p.teammates.find(t => t.id === '3').eligible, false);
assert.equal(p.teammates.find(t => t.id === '3').mean, 1500);
assert.equal(p.smallSampleTeammates.some(t => t.id === '3'), true);
assert.equal(p.smallSampleTeammates.find(t => t.id === '4').games, 1);
assert.equal(p.smallSampleTeammates.find(t => t.id === '4').performanceGames, 0);
assert.equal(p.smallSampleTeammates.find(t => t.id === '4').mean, null);
assert.equal(p.timeline.find(t => t.id === 1).rosterSize, 2);
assert.equal(p.timeline.find(t => t.id === 4).performance, null);
assert.equal(p.timeline.find(t => t.id === 4).rolling, null);
assert.equal(p.years.find(y => y.year === '2024').mean, 500);
assert.equal(p.years.find(y => y.year === '2025').mean, 2000);
assert.equal(p.formats.find(f => f.id === '8').performanceGames, 0);
assert.equal(p.rosterSizes.reduce((sum, r) => sum + r.games, 0), 4);
assert.equal(p.recent.eligible, false);
assert.equal(p.recent.last, null);
assert.equal(p.recent.delta, null);

// The year/type filters apply to history, pairs and every KPI together. Empty
// periods retain the player's identity and lifetime registry, without fallback.
p = profile(rows, { playerId: 1, year: 2025, type: 3 });
assert.deepEqual(p.games.map(t => t.id), [3]);
assert.equal(p.summary.avgPerformance, 2000);
assert.equal(p.teammates.find(t => t.id === '2').games, 1);
assert.equal(p.bestTeammates.length, 0);
assert.equal(p.interval.lower, null, 'One game cannot establish a Student-t interval');
p = profile(rows, { playerId: 1, year: 2023 });
assert.equal(p.player.name, 'Анна');
assert.equal(p.games.length, 0);
assert.equal(p.summary.avgPerformance, null);
assert.equal(p.best, null);
assert.deepEqual(p.teammates, []);
assert.equal(p.players.length, registry.length);
assert.equal(p.coverage.playerGames, 4);
assert.deepEqual(p.availableYears, ['2025', '2024']);
p = profile(rows, { playerId: 6 });
assert.equal(p.summary.games, 1);
assert.equal(p.summary.performanceGames, 0);
assert.equal(p.interval.mean, null);
assert.equal(p.best, null);
assert.equal(p.worst, null);
assert.equal(p.timeline[0].performance, null);
p = profile(rows, { playerId: 'unknown' });
assert.equal(p.player, null);
assert.equal(p.games.length, 0);
assert.equal(profile([], {}).player, null);
assert.equal(profile([], {}).recent.delta, null);
assert.equal(JSON.stringify(rows), before, 'Statistics leave source records untouched');
for (const b of ['1000', true, -1, Infinity, NaN, undefined]) {
  const invalid = profile([game(1, b, [1], { performance: 99999 })], { playerId: 1 });
  assert.equal(invalid.summary.performanceGames, 0);
  assert.equal(invalid.summary.avgPerformance, null);
  assert.equal(invalid.interval.mean, null);
  assert.equal(invalid.best, null);
}

// A strict minimum of rated shared games controls the ranking, rather than a
// high score from one game, or three registrations with no official B.
const teamRows = [game(1, 100, [1, 2, 3]), game(2, 200, [1, 2, 3]), game(3, 300, [1, 2, 4]),
  game(4, 9000, [1, 5]), game(5, null, [1, 4]), game(6, null, [1, 4])];
p = profile(teamRows, { playerId: 1 });
assert.deepEqual(p.bestTeammates.map(t => t.id), ['2']);
assert.equal(p.teammates.find(t => t.id === '4').eligible, false);
assert.equal(p.teammates.find(t => t.id === '4').games, 3);
assert.equal(p.teammates.find(t => t.id === '4').performanceGames, 1);
assert.deepEqual(profile(teamRows, { playerId: 1, minCommonGames: 2 }).bestTeammates.map(t => t.id), ['2', '3']);

// The two trend windows are non-overlapping, fully populated observations of
// B. Unrated tournaments between them do not turn into zeros or partial fives.
const trendRows = Array.from({ length: 12 }, (_, i) => game(i + 1, (i + 1) * 100, [1, 2]));
trendRows.splice(6, 0, game(50, null, [1, 2], { date: '2025-01-06T12:00:00' }));
p = profile(trendRows.slice().reverse(), { playerId: 1 });
assert.equal(p.recent.eligible, true);
assert.equal(p.recent.ratedGames, 12);
assert.equal(p.recent.missingPerformanceGames, 1);
assert.deepEqual(p.recent.last.ids, [8, 9, 10, 11, 12]);
assert.deepEqual(p.recent.previous.ids, [3, 4, 5, 6, 7]);
assert.equal(p.recent.last.count, 5);
assert.equal(p.recent.previous.count, 5);
assert.equal(p.recent.last.mean, 1000);
assert.equal(p.recent.previous.mean, 500);
assert.equal(p.recent.delta, 500);
assert.equal(p.timeline.find(t => t.id === 5).rolling, 300);
assert.equal(p.timeline.find(t => t.id === 50).rolling, null);
assert.equal(p.timeline.find(t => t.id === 7).rolling, 500);
p = profile(trendRows.filter(t => t.id <= 9), { playerId: 1 });
assert.equal(p.recent.last.count, 5);
assert.equal(p.recent.previous, null);
assert.equal(p.recent.delta, null);
assert.equal(p.recent.eligible, false);

// Dependencies are explicit; missing CI support degrades to absent bounds,
// rather than a made-up interval. UMD exposes the same pure API in the browser.
p = P.profile(rows, { playerId: 1 }, A);
assert.equal(p.interval.mean, 1000);
assert.equal(p.interval.lower, null);
assert.equal(p.interval.method, 'unavailable');
assert.throws(() => P.profile(rows, {}), TypeError);
assert.throws(() => P.registry(rows), TypeError);
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../personal-stats.js'), 'utf8'), context);
assert.equal(typeof context.window.SamuraiPersonalStats.profile, 'function');
assert.equal(context.window.SamuraiPersonalStats.profile(rows, { playerId: 1 }, A, R).summary.avgPerformance, 1000);

// Independently audit every real player and shared roster against source
// snapshot rows; reference values use numeric rating.b directly, not the API
// accessor being tested. This remains valid after future data refreshes.
const snapshot = require('../data/dashboard.json');
const published = snapshot.tournaments.filter(t => t.included !== false);
const idsOf = t => Array.from(new Set((t.players || []).map(p => String(p.id))));
const allIds = Array.from(new Set(published.flatMap(idsOf)));
registry = P.registry(snapshot.tournaments, A);
assert.ok(published.length >= 50);
assert.ok(allIds.length >= 20);
assert.deepEqual(registry.map(p => p.id).sort(), allIds.slice().sort());
let sharedPairs = 0;
for (const id of allIds) {
  const expected = published.filter(t => idsOf(t).includes(id)).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const performance = expected.map(t => t.rating && t.rating.b).filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  p = profile(snapshot.tournaments, { playerId: id });
  assert.equal(p.summary.games, expected.length);
  assert.equal(p.summary.performanceGames, performance.length);
  sameMean(p.summary.avgPerformance, performance);
  assert.deepEqual(p.games.map(t => t.id), expected.map(t => t.id));
  assert.equal(p.years.reduce((n, y) => n + y.games, 0), expected.length);
  assert.equal(p.formats.reduce((n, f) => n + f.games, 0), expected.length);
  assert.equal(p.rosterSizes.reduce((n, r) => n + r.games, 0), expected.length);
  for (const teammate of p.teammates) {
    assert.notEqual(teammate.id, id);
    const shared = expected.filter(t => idsOf(t).includes(teammate.id));
    const sharedB = shared.map(t => t.rating && t.rating.b).filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    assert.equal(teammate.games, shared.length);
    assert.equal(teammate.performanceGames, sharedB.length);
    sameMean(teammate.mean, sharedB);
    assert.equal(teammate.eligible, sharedB.length >= 3);
    sharedPairs++;
  }
  assert.ok(p.bestTeammates.every((t, index, list) => index === 0 || list[index - 1].mean >= t.mean));
  assert.equal(p.recent.eligible, performance.length >= 10);
}
console.log(`personal statistics: scoped B, CI, identity, empty periods, trend windows and ${allIds.length} real players / ${sharedPairs} shared roster checks passed`);
