'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Focus = require('../focus-core.js');
const old = { id: 100, name: 'Последний опубликованный пакет', date: '2026-10-20T10:00:00Z', included: true,
  totalQuestions: 12, questionQty: [12], mask: '0010000?0011', canceledQuestions: [7], rating: { b: 0, inRating: false },
  fieldCounts: Array(12).fill(100), fieldSuccesses: [80, 90, 70, 20, 30, 10, 80, 70, 90, 60, 70, 50] };
old.fieldCounts[8] = 29; old.fieldSuccesses[8] = 26;
old.fieldRates = old.fieldSuccesses.map((n, i) => n / old.fieldCounts[i]);
const latest = { ...old, id: 200, name: 'Новая игра без опубликованных вопросов', date: '2026-11-13T10:00:00Z', rating: { b: 500 } };
const source = (i, extra = {}) => ({ tournamentId: old.id, number: i, questionId: 1000 + i, packageId: 50,
  sourceUrl: 'https://gotquestions.online/question/' + (1000 + i), format: [1, 2, 7, 8, 9].includes(i) ? 'duplet' : i === 6 ? 'blitz' : 'ordinary',
  forms: [1, 2].includes(i) ? ['same_vowels'] : i === 4 ? ['anagram'] : ['unmarked'], handout: [1, 2, 10, 11].includes(i) ? 'with' : 'without',
  answer: 'НЕ ДОЛЖНО ПОПАСТЬ В ОТЧЁТ', evidence: { format: ['СЕКРЕТНО'] }, ...extra });
const played = { tournaments: [{ tournamentId: 100, status: 'matched', packageIds: [50] }, { tournamentId: 200, status: 'unmatched', packageIds: [] }],
  questions: Array.from({ length: 12 }, (_, i) => source(i + 1)) };
const candidate = (id, extra = {}) => ({ id: String(id), packageId: 70, canonicalQuestionId: 2000 + id,
  text: 'Вопрос', answer: 'Ответ', classification: { format: 'duplet', forms: ['same_vowels'], handout: 'with' },
  difficultyObservations: [{ teamsCount: 100, correctAnswers: 80, sourceIndex: 0 }], ...extra });
const bank = { packages: [{ id: 70, type: 'kvrm', published: true, trueDl: 9 }, { id: 50, type: 'kvrm' },
  { id: 80, type: 'kvrm', ratingTournamentIds: [200] }, { id: 90, type: 'si' }], questions: [
  candidate(1), candidate(2, { classification: { format: 'ordinary', forms: ['unmarked'], handout: 'without' },
    difficultyObservations: [{ teamsCount: 100, correctAnswers: 10, sourceIndex: 0 }] }),
  candidate(3, { packageId: 50 }), candidate(4, { packageId: 80 }), candidate(5, { canonicalQuestionId: 1001 }),
  candidate(6, { flags: { missingAnswer: true } }), candidate(7, { packageId: 90 }),
  candidate(8, { classification: undefined, difficultyObservations: [] }),
  candidate(9, { difficultyObservations: [{ teamsCount: 29, correctAnswers: 25 }, { teamsCount: 100, correctAnswers: 10 }] }),
  candidate(10, { difficultyObservations: [{ teamsCount: 100, correctAnswers: 80 }, { teamsCount: 200, correctAnswers: 20 }] }),
  candidate(11, { classification: { format: 'blitz', forms: ['anagram'], handout: 'without' }, difficultyObservations: [{ teamsCount: 100, correctAnswers: 20 }] }),
  candidate(12, { difficultyObservations: [{ teamsCount: 30, correctAnswers: 18, rate: 0 }] }),
  candidate(13, { difficultyObservations: [{ teamsCount: 100, correctAnswers: 101 }, { teamsCount: true, correctAnswers: 0 }] }),
  candidate(14, { canonicalQuestionId: undefined }), candidate(15, { flags: { takenDown: true } }) ] };
const snapshot = JSON.stringify({ old, latest, played, bank });
let all = Focus.build({ selected: [old, latest], playedData: played, trainingData: bank });
let r = all.mistakes;
assert.equal(r.available, true);
assert.equal(r.tournament.id, 100);
assert.equal(r.tournament.performance, 0, 'Official B=0 preserved even inRating=false');
assert.equal(r.latestTournament.id, 200);
assert.deepEqual(r.skippedNewer.map(t => t.id), [200]);
assert.equal(r.dateBasis, 'official_start');
assert.equal(r.coverage.knownQuestions, 10, 'Canceled and unknown answers excluded');
assert.equal(r.coverage.mappedKnownQuestions, 10);
assert.equal(r.coverage.comparableQuestions, 9, '29 opponents cannot inform the diagnosis');
assert.equal(r.summary.takes, 3);
assert.equal(r.summary.questions, 9);
assert.ok(Math.abs(r.summary.fieldRate - 4.8 / 9) < 1e-12);
const group = key => r.categories.find(g => g.key === key);
assert.equal(group('format:duplet').questions, 2);
assert.equal(group('format:duplet').misses, 2);
assert.equal(group('format:duplet').smallSample, true);
assert.equal(group('format:duplet').priorityEligible, false, 'Two questions visible, not promoted to priority');
assert.equal(group('difficulty:accessible').questions, 5);
assert.equal(group('difficulty:accessible').priorityEligible, true);
assert.ok(r.priorities.every(g => g.gap < 0 && g.misses > 0 && g.questions >= 3));
assert.ok(Math.abs(group('difficulty:accessible').deficit - 1.7) < 1e-12);
assert.equal(group('difficulty:accessible').preset.focusKind, 'mistakes');
assert.equal(group('difficulty:accessible').preset.remediation.tournamentId, 100);
assert.deepEqual(group('difficulty:accessible').preset.authors, []);
assert.deepEqual(group('difficulty:accessible').trainingQuestionIds, ['1', '12'], 'Exact question take-rate bin, largest observed field, counts over serialized rate; packet DL never used');
assert.deepEqual(group('difficulty:hard').trainingQuestionIds, ['2', '9', '10']);
assert.deepEqual(group('difficulty:challenge').trainingQuestionIds, ['11'], '20% belongs to the next band');
assert.deepEqual(group('forms:anagram').trainingQuestionIds, ['11']);
assert.ok(group('forms:same_vowels').trainingQuestionIds.includes('13'), 'A category does not need published take-rate data');
assert.ok(!group('format:duplet').trainingQuestionIds.includes('8'), 'Missing category never broadens selection');
for (const g of r.categories) {
  assert.equal(g.trainingCount, g.trainingQuestionIds.length);
  assert.deepEqual(g.preset.questionIds, g.trainingQuestionIds);
  assert.ok(!g.trainingQuestionIds.some(id => ['3', '4', '5', '6', '7', '14', '15'].includes(id)), 'Whole played packs, canonical played IDs, linked tournaments, unavailable questions and non-ЧГК excluded');
}
assert.ok(!JSON.stringify(r).includes('СЕКРЕТНО'));
assert.ok(!JSON.stringify(r).includes('НЕ ДОЛЖНО'));
assert.equal(JSON.stringify({ old, latest, played, bank }), snapshot, 'No mutations');

// Filters determine the eligible last game; do not reach outside the slice.
assert.equal(Focus.build({ selected: [latest], playedData: played, trainingData: bank }).mistakes.available, false);
assert.equal(Focus.build({ selected: [old], playedData: played, trainingData: bank }).mistakes.skippedNewer.length, 0);
assert.equal(Focus.build({ selected: [] }).mistakes.tournament, null);
const noComparable = { ...old, fieldCounts: Array(12).fill(20), fieldSuccesses: Array(12).fill(10) };
r = Focus.build({ selected: [noComparable], playedData: played, trainingData: bank }).mistakes;
assert.equal(r.tournament.id, 100);
assert.equal(r.available, false, 'Last mapped game retained with insufficient-opponents explanation');
assert.equal(r.categories.length, 0);
const ambiguous = { ...played, tournaments: played.tournaments.map(t => ({ ...t, status: 'ambiguous' })) };
assert.equal(Focus.build({ selected: [old], playedData: ambiguous }).mistakes.tournament, null);
const forged = { ...played, questions: played.questions.map(q => ({ ...q, sourceUrl: 'https://example.com/' })) };
assert.equal(Focus.build({ selected: [old], playedData: forged }).mistakes.tournament, null);
const noBank = Focus.build({ selected: [old], playedData: played }).mistakes;
assert.ok(noBank.categories.every(g => g.trainingCount === 0 && g.preset.questionIds.length === 0), 'Unavailable strict training remains unavailable');

// Equal-question weights are retained despite different opponent sample sizes.
const weighted = { ...old, totalQuestions: 2, questionQty: [2], mask: '10', canceledQuestions: [], fieldCounts: [30, 300], fieldSuccesses: [18, 270], fieldRates: [.6, .9] };
r = Focus.build({ selected: [weighted], playedData: played }).mistakes;
assert.equal(r.summary.fieldRate, .75);
assert.equal(r.summary.teamRate, .5);

// With above-field takes there is no invented weakness, even with many misses.
const strong = { ...old, mask: '111111111111', canceledQuestions: [], fieldCounts: Array(12).fill(100) };
r = Focus.build({ selected: [strong], playedData: played, trainingData: bank }).mistakes;
assert.equal(r.priorities.length, 0);
assert.ok(r.categories.every(g => !g.weak));

// Offer the union of the three newest played games and three newest actual
// publication timestamps. Publication order can differ greatly from game order.
const choiceGames = Array.from({ length: 7 }, (_, i) => ({ ...old, id: i + 1, name: 'Турнир ' + (i + 1), date: `2026-10-0${i + 1}T10:00:00Z` }));
const choicePlayed = { tournaments: choiceGames.map((t, i) => ({ tournamentId: t.id, status: 'matched', packageIds: [50 + t.id],
  publishedAt: `2026-11-0${7 - i}T09:00:00Z` })),
  questions: choiceGames.flatMap(t => Array.from({ length: 12 }, (_, i) => source(i + 1, { tournamentId: t.id, packageId: 50 + t.id }))) };
const choiceSnapshot = JSON.stringify({ choiceGames, choicePlayed });
const choices = (selected = choiceGames, playedData = choicePlayed) => Focus.build({ selected, playedData, trainingData: bank }).mistakes;
r = choices();
assert.deepEqual(r.tournaments.map(t => t.id), [7, 6, 5, 1, 2, 3], 'Six choices when the two top threes are disjoint');
assert.equal(Object.keys(r.reports).length, 6);
assert.equal(r.tournament.id, 7, 'Default remains newest played mapped tournament');
assert.equal(r.publicationDateBasis, 'gotquestions_pubDate');
assert.deepEqual(r.publicationCoverage, { mappedGames: 7, knownPublicationDates: 7, missingPublicationDates: 0 });
for (const t of r.tournaments) {
  assert.equal(t.recentPlayed, [7, 6, 5].includes(t.id));
  assert.equal(t.recentPublished, [1, 2, 3].includes(t.id));
  const report = r.reports[String(t.id)];
  assert.equal(report.tournament.id, t.id);
  assert.equal(report.tournament.publishedAt, t.publishedAt);
  assert.ok(report.categories.every(c => c.preset.remediation.tournamentId === t.id));
  assert.ok(report.categories.flatMap(c => c.missed).every(q => q.tournamentId === t.id));
  assert.equal(report.skippedNewer.length, 0, 'Other mapped choices are never called unavailable');
  assert.ok(!('reports' in report) && !('tournaments' in report), 'Reports have no recursive parent references');
}
assert.ok(!JSON.stringify(r).includes('СЕКРЕТНО'));
assert.equal(JSON.stringify({ choiceGames, choicePlayed }), choiceSnapshot, 'Building choices does not mutate sources');
assert.equal(r.reports['1'].trainingCoverage, r.reports['7'].trainingCoverage, 'Training pool computed once and reused');
const sameOrder = { ...choicePlayed, tournaments: choicePlayed.tournaments.map((t, i) => ({ ...t, publishedAt: `2026-11-0${i + 1}T09:00:00Z` })) };
r = choices(choiceGames, sameOrder);
assert.deepEqual(r.tournaments.map(t => t.id), [7, 6, 5], 'Identical top threes collapse to three choices');
assert.ok(r.tournaments.every(t => t.recentPlayed && t.recentPublished));
for (const [days, count] of [[[7, 1, 2, 3, 4, 5, 6], 4], [[5, 6, 1, 2, 3, 4, 7], 5]]) {
  const partial = { ...choicePlayed, tournaments: choicePlayed.tournaments.map((t, i) => ({ ...t, publishedAt: `2026-11-0${days[i]}T09:00:00Z` })) };
  assert.equal(choices(choiceGames, partial).tournaments.length, count, 'Partial overlaps deduplicate to four or five choices');
}
r = choices(choiceGames.slice(0, 2));
assert.deepEqual(r.tournaments.map(t => t.id), [2, 1], 'Small filtered slices stay small and never reach outside the filter');
assert.deepEqual(Object.keys(r.reports).sort(), ['1', '2']);
r = choices(choiceGames.map(t => ({ ...t, included: t.id !== 1 })));
assert.ok(!r.tournaments.some(t => t.id === 1), 'Excluded tournament cannot reappear via publication order');
const unknown = { ...choicePlayed, tournaments: choicePlayed.tournaments.map(t => ({ ...t, publishedAt: t.tournamentId === 1 ? '2026-02-30T10:00:00Z'
  : t.tournamentId === 2 ? null : t.tournamentId === 3 ? '2026-11-11T24:00:00Z' : t.publishedAt, fetchedAt: '2099-01-01T00:00:00Z' })) };
r = choices(choiceGames, unknown);
assert.deepEqual(r.publicationCoverage, { mappedGames: 7, knownPublicationDates: 4, missingPublicationDates: 3 });
assert.deepEqual(r.tournaments.filter(t => t.recentPublished).map(t => t.id).sort(), [4, 5, 6], 'Invalid/unknown pubDate never replaced by retrieval dates or catalog order');
const withoutPublication = { ...choicePlayed, tournaments: choicePlayed.tournaments.map(t => ({ ...t, publishedAt: null })) };
r = choices(choiceGames, withoutPublication);
assert.deepEqual(r.tournaments.map(t => t.id), [7, 6, 5]);
assert.ok(r.tournaments.every(t => !t.recentPublished && t.publishedAt === null));
const incomparable = choiceGames.map(t => t.id === 1 ? { ...t, fieldCounts: Array(12).fill(20) } : t);
r = choices(incomparable);
assert.ok(r.tournaments.some(t => t.id === 1));
assert.equal(r.reports['1'].available, false, 'Published choice remains selectable even when field sample is insufficient');
const excludedStatus = { ...choicePlayed, tournaments: choicePlayed.tournaments.map(t => t.tournamentId === 1 ? { ...t, status: 'ambiguous' } : t) };
assert.ok(!choices(choiceGames, excludedStatus).tournaments.some(t => t.id === 1));
const tiedPublication = { ...choicePlayed, tournaments: choicePlayed.tournaments.map(t => ({ ...t, publishedAt: '2026-11-01T10:00:00Z' })) };
assert.deepEqual(choices(choiceGames.slice().reverse(), tiedPublication).tournaments.map(t => t.id), [7, 6, 5], 'Timestamp ties have deterministic ID ordering');
r = choices(choiceGames.map(t => t.id === 1 ? { ...t, date: null } : t));
assert.ok(r.tournaments.some(t => t.id === 1 && t.recentPublished && !t.recentPlayed), 'Known publication can select a mapped game without a known official start');

const project = path.join(__dirname, '..');
const data = name => JSON.parse(fs.readFileSync(path.join(project, 'data', name + '.json')));
const actual = Focus.build({ selected: data('dashboard').tournaments, playedData: data('played-questions'), trainingData: data('training') }).mistakes;
assert.ok(actual.available);
assert.ok(actual.trainingCoverage.classifiedNewQuestions > 1000);
assert.ok(actual.trainingCoverage.questionsWithPublishedRate > 100);
for (const category of actual.categories) assert.equal(category.trainingCount, new Set(category.trainingQuestionIds).size);
console.log('Tournament-choice remediation tests passed');
