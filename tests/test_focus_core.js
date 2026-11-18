'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Focus = require('../focus-core.js');
const rates = [.1, .1, .1, .3, .3, .3, .5, .5, .5, .7, .7, .7];
const games = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: 'Игра ' + (i + 1), date: `2025-${String(i + 1).padStart(2, '0')}-10`,
  included: true, totalQuestions: 12, questionQty: [12], canceledQuestions: [], mask: i < 6 ? '100110111000' : '110111111110',
  fieldCounts: rates.map(() => 100), fieldRates: rates.slice(), fieldSuccesses: rates.map(r => r * 100), rating: { b: i * 100, inRating: false } }));
const sources = { questions: games.flatMap(t => Array.from({ length: 12 }, (_, i) => ({ tournamentId: t.id, number: i + 1,
  questionId: t.id * 100 + i, packageId: t.id, sourceUrl: `https://gotquestions.online/question/${t.id * 100 + i}`,
  authors: [{ id: 'gq-person-1', name: 'Мария Тестова' }], handout: i % 2 ? 'with' : 'without', format: 'ordinary', forms: ['same_vowels'],
  text: 'СЕКРЕТНЫЙ ТЕКСТ', answer: 'СЕКРЕТНЫЙ ОТВЕТ', evidence: { forms: ['СЕКРЕТНАЯ ЦИТАТА'] } }))),
  tournaments: games.map(t => ({ tournamentId: t.id, status: 'matched' })) };
const q = (id, more) => ({ id, packageId: 99, canonicalQuestionId: 9000 + id, text: 'Текст вопроса', answer: 'Ответ', authors: [{ id: 'gq-person-1', name: 'Мария Тестова' }], flags: {}, ...more });
const training = { packages: [{ id: 99, type: 'kvrm', trueDl: null }, { id: 98, type: 'si', trueDl: 4 }, { id: 97, type: 'kvrm', ratingTournamentIds: [1] }],
  questions: [q(1), q(2, { flags: { missingAnswer: true } }), q(3, { canonicalQuestionId: 100 }), q(4, { packageId: 98 }),
    q(5, { packageId: 97 }), q(6, { authors: [{ id: 'gq-person-2', name: 'Иной автор' }] }), q(7, { text: '', media: [{ role: 'handout', url: 'https://example.com/a.jpg' }] })] };
const snapshot = JSON.stringify({ games, sources, training });
let r = Focus.build({ selected: games, playedData: sources, trainingData: training });
assert.equal(r.coverage.games, 12);
assert.equal(r.coverage.knownQuestions, 144);
assert.equal(r.coverage.comparableQuestions, 144);
assert.equal(r.coverage.matchedComparableQuestions, 144);
assert.equal(r.atlas.size, 6);
assert.equal(r.atlas.first.from, '2025-01-10');
assert.equal(r.atlas.last.to, '2025-12-10');
assert.equal(r.atlas.first.meanB, 250, 'B=0 and inRating=false retained');
assert.equal(r.atlas.first.medianB, 250);
assert.equal(r.atlas.last.meanB, 850);
assert.deepEqual(r.atlas.first.ids, ['1', '2', '3', '4', '5', '6']);
assert.equal(r.atlas.first.ids.some(id => r.atlas.last.ids.includes(id)), false);
const accessible = r.atlas.bands.find(b => b.id === 'accessible');
assert.equal(accessible.first.questions, 18);
assert.equal(accessible.last.questions, 18);
assert.equal(accessible.deltaTeam, 2 / 3);
assert.equal(accessible.deltaField, 0);
assert.equal(r.performance.games, 12);
assert.equal(r.performance.timeline[0].performance, 0);
assert.equal(r.performance.timeline[3].rollingMedian, null);
assert.equal(r.performance.timeline[4].rollingMedian, 200);
assert.equal(r.opportunities.summary.questions, 36);
assert.equal(r.opportunities.summary.misses, 24);
const ordinary = r.opportunities.formats.find(c => c.id === 'ordinary');
assert.equal(ordinary.eligible, true);
assert.deepEqual(ordinary.authorIds, ['gq-person-1']);
assert.deepEqual(ordinary.trainingQuestionIds, ['1', '7'], 'Direct author identity, unknown DL retained; played, SI and unavailable questions excluded');
assert.equal(ordinary.trainingLabel, 'Вопросы этих авторов');
assert.equal(ordinary.trainingCount, 2);
assert.equal(r.rareWins.takes, 18);
assert.equal(r.rareWins.questions, 36);
assert.equal(r.rareWins.items.length, 18);
assert.equal(JSON.stringify(r).includes('СЕКРЕТ'), false, 'Focus payloads never expose text, answer or classification quotes');
assert.equal(JSON.stringify({ games, sources, training }), snapshot, 'Inputs are immutable');

// Bounds are exact, the opposing field is question weighted, and unknown / canceled
// answers never become misses. Less than 30 known opponents is not an opportunity.
const edge = { ...games[0], id: 20, totalQuestions: 7, questionQty: [7], mask: '001?110', canceledQuestions: [5],
  fieldRates: [.6, .2, .6, .6, .6, null, .600001], fieldCounts: [100, 100, 29, 100, 100, 100, 1000],
  fieldSuccesses: [60, 20, null, 60, 60, null, 600], rating: { b: null, r: 99999 } };
r = Focus.build({ selected: [edge], playedData: sources, trainingData: training });
assert.equal(r.coverage.knownQuestions, 5);
assert.equal(r.coverage.comparableQuestions, 3);
assert.equal(r.coverage.opponentBelowMinimum, 1);
assert.equal(r.coverage.missingOpponentData, 1);
assert.equal(r.opportunities.summary.questions, 2, '60% exact bound is accessible');
assert.equal(r.opportunities.summary.fieldRate, .6, 'Uses exact successes/counts');
assert.equal(r.rareWins.questions, 1, '20% exact bound is included in rare takes consistently with the existing dashboard');
assert.equal(r.performance.games, 0, 'Other rating values never replace missing B');
assert.equal(r.atlas.available, false);
assert.equal(r.atlas.bands.every(b => b.deltaTeam === null), true);
assert.equal(r.rhythm.available, false);
const mixedWeight = { ...edge, mask: '10', totalQuestions: 2, questionQty: [2], canceledQuestions: [], fieldCounts: [30, 300], fieldRates: [.6, .9], fieldSuccesses: [18, 270] };
r = Focus.build({ selected: [mixedWeight] });
assert.equal(r.opportunities.summary.fieldRate, .75, 'Each question has one weight, never pool all opponent answers');
assert.equal(r.opportunities.summary.teamRate, .5);
assert.equal(r.opportunities.categories.length, 0, 'Unmatched metadata never invents a skill');
assert.equal(r.opportunities.missed[0].sourceUrl, null);

const repeated = { ...sources, questions: sources.questions.concat(sources.questions) };
assert.equal(Focus.build({ selected: games, playedData: repeated }).coverage.matchedQuestions, 144, 'Identical metadata duplicates cannot inflate counts');
const conflict = { ...sources, questions: sources.questions.concat([{ ...sources.questions[0], questionId: 99999 }]) };
assert.equal(Focus.build({ selected: games, playedData: conflict }).coverage.matchedQuestions, 143, 'Ambiguous locators fail closed');
assert.equal(Focus.build({ selected: games.slice(0, 9) }).atlas.available, false);
assert.equal(Focus.build({ selected: games.slice(0, 10) }).atlas.size, 5);
assert.equal(Focus.build({ selected: games.concat([{ ...games[0], id: 99, included: false }]) }).coverage.games, 12);
assert.equal(Focus.build({ selected: [] }).performance.meanB, null);
assert.equal(Focus.build({ selected: [] }).opportunities.summary.teamRate, null);

// A's solo card must not suggest B-only questions merely because B coauthored
// one of A's missed questions. A format card can offer both source authors.
const coauthored = { ...sources, questions: sources.questions.map(s => ({ ...s,
  authors: [...s.authors, { id: 'gq-person-2', name: 'Соавтор Б' }] })) };
r = Focus.build({ selected: games, playedData: coauthored, trainingData: training });
const authorA = r.opportunities.authors.find(a => a.id === 'gq-person-1');
assert.deepEqual(authorA.authorIds, ['gq-person-1']);
assert.deepEqual(authorA.trainingQuestionIds, ['1', '7']);
const authorB = r.opportunities.authors.find(a => a.id === 'gq-person-2');
assert.deepEqual(authorB.authorIds, ['gq-person-2']);
assert.deepEqual(authorB.trainingQuestionIds, ['6']);
assert.deepEqual(r.opportunities.formats[0].authorIds, ['gq-person-1', 'gq-person-2']);
assert.ok(r.opportunities.formats[0].trainingQuestionIds.includes('6'));

// Rhythm compares only the first/last thirds within known tour boundaries.
const rhythmGames = Array.from({ length: 3 }, (_, i) => ({ ...games[0], id: i + 20, totalQuestions: 18, questionQty: [9, 9],
  mask: '111000000111000000', fieldRates: Array(18).fill(.7), fieldCounts: Array(18).fill(100), fieldSuccesses: Array(18).fill(70) }));
r = Focus.build({ selected: rhythmGames });
assert.equal(r.rhythm.available, true);
assert.equal(r.rhythm.first.questions, 18);
assert.equal(r.rhythm.last.questions, 18);
assert.equal(r.rhythm.first.teamRate, 1);
assert.equal(r.rhythm.last.teamRate, 0);
assert.equal(r.rhythm.difference, -1);
assert.equal(r.rhythm.lastMinusFirstField, 0);
assert.equal(Focus.build({ selected: rhythmGames.map(t => ({ ...t, questionQty: [] })) }).rhythm.questions, 0);

const project = path.join(__dirname, '..');
const history = JSON.parse(fs.readFileSync(path.join(project, 'data/dashboard.json')));
const played = JSON.parse(fs.readFileSync(path.join(project, 'data/played-questions.json')));
const bank = JSON.parse(fs.readFileSync(path.join(project, 'data/training.json')));
const actual = Focus.build({ selected: history.tournaments, playedData: played, trainingData: bank });
assert.ok(actual.coverage.comparableQuestions > 1000);
assert.ok(actual.opportunities.summary.misses > 10);
assert.ok(actual.atlas.available);
assert.ok(actual.performance.games > 20);
for (const b of actual.atlas.bands) for (const side of [b.first, b.last]) assert.ok(side.teamRate === null || side.teamRate >= 0 && side.teamRate <= 1);
for (const category of actual.opportunities.categories) assert.equal(category.trainingCount, new Set(category.trainingQuestionIds).size);
console.log('Focus analytics tests passed');
