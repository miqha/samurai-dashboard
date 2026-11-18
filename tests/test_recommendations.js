'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../recommendations-core.js');
const near = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const now = '2026-11-07T12:00:00Z';
const active = { id: 100, name: 'Открытый', type: { id: 3, name: 'Синхрон' }, dateStart: '2026-11-07T15:00:00+03:00', dateEnd: '2026-11-08T15:00:00+03:00', questionQty: { 1: 12, 2: 12, 3: 12 }, trueDL: 4 };

// Start is inclusive, end exclusive, offset is respected exactly.
assert.equal(R.availability(active, now).status, 'active');
assert.equal(R.availability(active, '2026-11-07T11:59:59Z').status, 'upcoming');
assert.equal(R.availability(active, '2026-11-08T12:00:00Z').status, 'expired');
assert.equal(R.availability({ ...active, cancelled: true }, now).status, 'cancelled');
assert.equal(R.availability({ ...active, dateEnd: null }, now).status, 'unknown');
assert.equal(R.availability({ ...active, dateEnd: active.dateStart }, now).status, 'unknown');
assert.equal(R.availability({ ...active, dateRequestsAllowedTo: now }, now).registrationClosed, true);
assert.equal(R.availability({ ...active, dateRequestsAllowedTo: null }, now).registrationDeadlineKnown, false);
assert.equal(R.availability({ ...active, dateDownloadQuestionsTo: now }, now).downloadClosed, true);
assert.equal(R.availability({ ...active, dateDownloadQuestionsTo: now, dateDownloadQuestionsFrom: '2026-01-01' }, now).downloadable, false);
near(R.availability(active, now).daysRemaining, 1);
assert.equal(R.totalQuestions(active), 36);
assert.equal(R.totalQuestions({ questionQty: [12, 12, null] }), 24);
assert.equal(R.totalQuestions({}), null);

// Unknown and annulled answers do not turn into failures or denominator rows.
assert.deepEqual(R.answers({ totalQuestions: 6, mask: '10?X10', canceledQuestions: [2] }), { takes: 2, questions: 3, source: 'mask' });
assert.equal(R.answers({ totalQuestions: 36, mask: '', score: null }).questions, 0);
assert.equal(R.answers({ totalQuestions: 36, mask: '', score: 0, included: true }).questions, 36);
assert.equal(R.answers({ totalQuestions: 36, mask: '', score: 12, included: false }).questions, 0);

const history = Array.from({ length: 18 }, (_, i) => {
  const value = 1 + i * 0.35;
  const taken = Math.round(36 / (1 + Math.exp((value - 4.1) / 1.3)));
  return { id: i + 1, name: 'Игра ' + i, date: `2026-${String(Math.floor(i / 3) + 1).padStart(2, '0')}-${String(i % 3 + 1).padStart(2, '0')}`, included: true, resultsAvailable: true, score: taken, totalQuestions: 36, mask: '1'.repeat(taken) + '0'.repeat(36 - taken), trueDL: value, difficultyForecast: 1 + value * 0.9 };
});
const model = R.buildModel(history, null);
assert.equal(model.ready, true);
assert.equal(model.models.trueDL.games, 18);
assert.equal(model.models.trueDL.questions, 648);
assert.ok(model.models.trueDL.level > 3.7 && model.models.trueDL.level < 4.5);
assert.ok(R.classify(2, model).predictedTakeRate > R.classify(6, model).predictedTakeRate);
assert.equal(R.classify(4, model).fit, 'balanced');
assert.equal(R.classify(null, model).fit, 'unrated');
assert.equal(R.classify(-1, model).fit, 'unrated');
assert.equal(R.classify(11, model).fit, 'unrated');
assert.equal(R.buildModel([], null).ready, false);
assert.equal(R.buildModel(history.slice(0, 5), null).models.trueDL.ready, false);
assert.equal(R.buildModel(history.map(row => ({ ...row, trueDL: 4 })), null).models.trueDL.ready, false);
assert.equal(R.buildModel(history.map(row => ({ ...row, included: false })), null).ready, false);

// Forecast is fitted on its own scale. It is not used as if measured trueDL.
const forecasts = history.map(row => ({ ...row, trueDL: null }));
const forecastModel = R.buildModel(forecasts, null);
assert.equal(forecastModel.models.trueDL.ready, false);
assert.equal(forecastModel.models.difficultyForecast.ready, true);
assert.equal(R.classify(4, forecastModel).predictedTakeRate, null);

const catalog = { complete: true, fetchedAt: now, tournaments: [
  active,
  { ...active, id: 101, name: 'Неизвестная сложность', trueDL: null },
  { ...active, id: 102, name: 'Только прогноз', trueDL: null, difficultyForecast: 4 },
  { ...active, id: 103, name: 'Очный', type: 2 },
  { ...active, id: 104, name: 'Строго синхронный', type: { id: 6 } },
  { ...active, id: 105, name: 'Асинхрон', type: 8 },
  { ...active, id: 106, name: 'Заявки закрыты', dateRequestsAllowedTo: '2026-11-06T00:00:00Z' },
  { ...active, id: 107, name: 'Будущий', dateStart: '2026-11-08T00:00:00Z' },
  { ...active, id: 108, name: 'Отмена', isCanceled: true },
  { ...active, id: 109, name: 'Иностранный', languages: ['en'] },
  { ...active, id: 110, name: 'Уже сыгран' },
  { ...active, id: 111, name: 'Есть в регистрации' },
  { ...active, id: 111, name: 'Дубликат' }
] };
const own = [...history,
  { ...active, id: 110, included: true, resultsAvailable: true, score: 0, mask: '0'.repeat(36) },
  { ...active, id: 111, included: false, exclusionReason: 'unpublished', resultsAvailable: true, score: null, mask: '' }
];
const ranked = R.rank(catalog, own, null, { now });
assert.deepEqual(ranked.active.map(row => row.id).sort(), [100, 101, 102, 104, 105, 106]);
assert.equal(ranked.active.some(row => row.id === 110 || row.id === 111), false);
assert.equal(ranked.planned.length, 1);
assert.equal(ranked.planned[0].id, 111);
assert.equal(ranked.offline[0].id, 103);
assert.equal(ranked.upcoming[0].id, 107);
assert.equal(ranked.suggested.some(row => row.id === 106), false);
assert.equal(ranked.active.find(row => row.id === 101).predictedTakeRate, null);
assert.equal(ranked.active.find(row => row.id === 102).difficulty.kind, 'difficultyForecast');
assert.equal(ranked.active.find(row => row.id === 100).difficulty.kind, 'trueDL');
assert.equal(ranked.active.find(row => row.id === 106).eligible, false);
assert.equal(ranked.summary.registrationClosed, 1);
assert.equal(ranked.summary.catalogComplete, true);
assert.throws(() => R.rank(catalog, history, null, { now: 'bad date' }), TypeError);
assert.throws(() => R.rank(catalog, history, null, { now, targetMin: .9, targetMax: .1 }), RangeError);

// A registered future tournament remains in the plan, not in suggestions.
const futurePlanned = R.rank({ tournaments: [{ ...active, id: 111, dateStart: '2026-11-08T00:00:00Z' }] }, own, null, { now });
assert.equal(futurePlanned.planned.length, 1);
assert.equal(futurePlanned.upcoming.length, 0);

// Metadata links preserve multiple packets; the same pack is never duplicated.
assert.deepEqual(R.gotQuestionsUrls([6995, 6995, { id: 20 }, null, 'bad', true, { id: true }]), ['https://gotquestions.online/pack/6995', 'https://gotquestions.online/pack/20']);
const archived = R.rank({ tournaments: [{ ...active, archive: true }] }, history, null, { now });
assert.equal(archived.active[0].availability.archived, true);
assert.equal(archived.active[0].eligible, false);
assert.equal(archived.suggested.length, 0);
const downloadClosed = R.rank({ tournaments: [{ ...active, dateDownloadQuestionsTo: now }] }, history, null, { now });
assert.equal(downloadClosed.active[0].availability.downloadClosed, true);
assert.equal(downloadClosed.active[0].eligible, false);
assert.equal(downloadClosed.suggested.length, 0);

// Different tournament IDs may reuse one packet. Shared GotQuestions IDs are
// affirmative evidence; a format-only name difference is an explicit warning.
const duplicateHistory = [...history, { ...active, id: 13452, name: 'Крафтик №7 (синхрон)', included: false, score: null, resultsAvailable: false, gotQuestionsTags: [12345] }];
const possible = R.rank({ tournaments: [{ ...active, id: 13453, name: 'Крафтик №7 (асинхрон)' }] }, duplicateHistory, null, { now });
assert.equal(possible.active.length, 1);
assert.equal(possible.active[0].possibleDuplicate, true);
assert.equal(possible.active[0].confirmedDuplicate, false);
assert.equal(possible.active[0].duplicateEvidence[0].id, 13452);
assert.equal(possible.active[0].duplicateEvidence[0].kind, 'normalized-name');
assert.equal(possible.suggested.length, 0);
const exactDuplicate = R.rank({ tournaments: [{ ...active, id: 13453, name: 'Совсем другое имя', gotQuestionsTags: [12345] }] }, duplicateHistory, null, { now });
assert.equal(exactDuplicate.active.length, 0);
assert.equal(exactDuplicate.duplicates.length, 1);
assert.equal(exactDuplicate.duplicates[0].confirmedDuplicate, true);
assert.equal(exactDuplicate.duplicates[0].duplicateEvidence[0].packetIds[0], 12345);
assert.notEqual(R.packageBaseName('Крафтик №7 (парный асинхрон)'), R.packageBaseName('Крафтик №7 (синхрон)'));
const overlap = R.rank({ tournaments: [{ ...active, id: 13453, name: 'Название отличается' }] }, duplicateHistory, null, { now,
  intersections: { tournaments: [{ id: 13452, relatedIds: [13453] }] } });
assert.equal(overlap.active.length, 0);
assert.equal(overlap.intersections[0].knownIntersection, true);
assert.equal(overlap.intersections[0].confirmedDuplicate, false);
assert.equal(overlap.intersections[0].intersectionEvidence[0].id, 13452);
assert.match(overlap.intersections[0].recommendation, /пересечения вопросов/);
const reverseOverlap = R.rank({ tournaments: [{ ...active, id: 13453 }] }, duplicateHistory, null, { now,
  intersections: { tournaments: [{ id: 13453, relatedIds: [13452] }] } });
assert.equal(reverseOverlap.active.length, 0); // The official relation is undirected.
const freshRegistration = R.rank({ tournaments: [active], teamTournamentIds: [active.id], teamHistoryCheckedAt: now }, history, null, { now });
assert.equal(freshRegistration.active.length, 0);
assert.equal(freshRegistration.planned.length, 1);
assert.equal(freshRegistration.planned[0].played, false);
assert.equal(freshRegistration.summary.teamRegistrationsCheckedAt, now);
const withDifficulty = history.map(row => { const copy = { ...row }; delete copy.trueDL; return copy; });
const index = { tournaments: history.map(row => ({ id: row.id, trueDL: row.trueDL, gotQuestionsTags: [row.id + 100] })) };
assert.equal(R.buildModel(withDifficulty, index).models.trueDL.games, 18);
const analysis = R.analysisByDifficulty(withDifficulty, index);
assert.equal(analysis.measuredGames, 18);
assert.equal(analysis.points.length, 18);
assert.equal(analysis.groups.reduce((sum, row) => sum + row.questions, 0), 648);
assert.equal(analysis.questionRatingsAvailable, false);
assert.equal(analysis.points[0].gqUrls[0], 'https://gotquestions.online/pack/101');
const unknown = R.analysisByDifficulty([{ ...history[0], trueDL: null }], null);
assert.equal(unknown.measuredGames, 0);
assert.equal(unknown.unknownGames, 1);

// Exercise the actual captured team data and prevent accidental calibration on
// the unpublished / future rows whose scores are null.
const dataSource = fs.readFileSync(path.join(__dirname, '../data.js'), 'utf8');
const actual = JSON.parse(dataSource.slice(dataSource.indexOf('{')).trim().replace(/;$/, ''));
const difficulty = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/team-difficulty.json'), 'utf8'));
const actualModel = R.buildModel(actual.tournaments, difficulty);
assert.equal(actualModel.models.trueDL.ready, true);
assert.ok(actualModel.models.trueDL.games >= 6 && actualModel.models.trueDL.games <= 24);
assert.ok(actualModel.recentTakeRate > 0 && actualModel.recentTakeRate < 1);
// Derive the expected coverage from the saved source records, independently of
// R.answers/buildModel. New published games must join the measured set, while
// registrations and packages with no measured trueDL must remain excluded.
const difficultyById = new Map(difficulty.tournaments.map(t => [t.id, t]));
const publishedHistory = actual.tournaments.filter(t => t.included !== false && t.resultsAvailable === true && t.knownQuestions > 0);
const expectedMeasured = publishedHistory.filter(t => {
  const value = Object.hasOwn(t, 'trueDL') ? t.trueDL : difficultyById.get(t.id)?.trueDL;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
});
assert.ok(expectedMeasured.length >= 6, 'Captured history has enough measured packages for calibration');
const actualAnalysis = R.analysisByDifficulty(actual.tournaments, difficulty);
const measuredIds = expectedMeasured.map(t => t.id).sort((a,b) => a-b);
assert.equal(actualAnalysis.measuredGames, expectedMeasured.length);
assert.deepEqual(actualAnalysis.points.map(t => t.id).sort((a,b) => a-b), measuredIds);
assert.deepEqual(actualAnalysis.unknownIds.slice().sort((a,b) => a-b), publishedHistory.filter(t => !measuredIds.includes(t.id)).map(t => t.id).sort((a,b) => a-b));
assert.equal(actualAnalysis.groups.reduce((sum, group) => sum + group.games, 0), expectedMeasured.length);
console.log(`Recommendations tests passed. Actual recent fit: n=${actualModel.models.trueDL.games}, level=${actualModel.models.trueDL.level.toFixed(2)}, scale=${actualModel.models.trueDL.scale.toFixed(2)}, takeRate=${(100 * actualModel.recentTakeRate).toFixed(1)}%.`);
