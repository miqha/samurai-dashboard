'use strict';
const assert = require('node:assert/strict');
const S = require('../analytics.js');
const base = { id: 1, name: 'Турнир Альфа', date: '2024-02-03', type: 'sync', typeName: 'Синхрон', questionQty: [3, 3], totalQuestions: 6, mask: '10X1?0', score: 3, position: 2.5, fieldSize: 5, players: [{ id: 1, name: 'Анна' }, { id: 2, name: 'Борис' }], editors: [{ id: 8, name: 'Редактор' }], fieldRates: [.1, .8, .5, .2, .9, .6], canceledQuestions: [2], scoreDistribution: [{ score: 4, count: 1 }, { score: 3, count: 2 }, { score: 1, count: 2 }] };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// Unknown/cancelled marks never become misses, including in field denominators.
const s = S.summarize([base]);
assert.equal(s.knownAnswers, 3);
assert.equal(s.takes, 2);
assert.equal(s.misses, 1);
assert.equal(s.totalQuestions, 5);
assert.equal(s.unknownAnswers, 2);
assert.equal(s.officialScore, 3); // Official points and mask takes remain separate.
close(s.takeRate, 2 / 3);
close(s.fieldExpected, .9);
close(s.excess, 1.1);
assert.equal(s.fieldQuestions, 3);
assert.equal(s.rareTakes, 2);
assert.equal(s.popularMisses, 1);
close(s.avgPercentile, 62.5); // Fractional official place preserves ties.
close(S.percentile({ fieldSize: 5, position: 2.5 }), 62.5);
assert.equal(S.percentile({ fieldSize: 1, position: 1 }), null);
assert.equal(s.longestTakeStreak, 1); // Unknown and cancelled marks break runs.
assert.equal(S.questionDetails([base]).some(q => q.number === 2), false);

// Pool answers rather than averaging per-tournament percentages.
const short = { ...base, id: 2, name: 'Бета', date: '2025-03-04', totalQuestions: 2, questionQty: [2], mask: '00', score: 0, fieldRates: [.5, null], canceledQuestions: [], players: [{ id: 1, name: 'Анна' }], position: 5 };
const pooled = S.summarize([base, short]);
close(pooled.takeRate, 2 / 5);
close(pooled.fieldExpected, 1.4);
close(pooled.excess, .6);
assert.equal(pooled.fieldQuestions, 4);
close(pooled.masksCoverage.questions, 5 / 7);
assert.equal(S.filter([base, short], { year: '2025' }).length, 1);
assert.equal(S.filter([base, short], { player: '2' }).length, 1);
assert.equal(S.filter([base, short], { type: 'Синхрон', search: 'альфа' }).length, 1);
assert.equal(S.filter([base, short], { search: 'РЕДАКТОР' }).length, 2);
assert.equal(S.filter([base, { ...short, included: false }], {}).length, 1);
assert.equal(S.summarize([base, { ...short, included: false }]).excludedGames, 1);

const absolute = S.byQuestion([base, short]);
assert.equal(absolute.find(q => q.number === 1).knownAnswers, 2);
assert.equal(absolute.find(q => q.number === 2).knownAnswers, 1);
const relative = S.byQuestion([base], 'round');
assert.equal(relative.find(q => q.number === 1).takes, 2);
assert.equal(S.byRound([base])[0].knownAnswers, 1);
assert.equal(S.byRound([base])[1].knownAnswers, 2);
assert.equal(S.byRound([base])[0].officialScore, null);
assert.equal(S.byRound([base])[0].score, 1);
assert.equal(S.byPlayer([base, short]).find(p => p.id === '1').games, 2);
assert.equal(S.pairs([base, short])[0].games, 1);
assert.equal(S.byEditor([base, short])[0].eligible, false);

// Duplicate overlapping ranges for the same credited group cannot inflate totals.
const credited = { ...base, questionCredits: [
  { from: 1, to: 4, authors: [{ id: 9, name: 'Соавтор А' }, { id: 10, name: 'Соавтор Б' }] },
  { from: 3, to: 6, authors: [{ id: 10, name: 'Соавтор Б' }, { id: 9, name: 'Соавтор А' }] },
  { questions: [4, 6], authors: [{ id: 11, name: 'Группа В' }], players: [{ id: 999, name: 'Не автор' }] }
] };
const authors = S.byAuthor([credited]);
assert.equal(authors.length, 2);
assert.equal(authors.find(a => a.id === '10|9').knownAnswers, 3);
assert.equal(authors.find(a => a.id === '10|9').questions, 5);
assert.equal(authors.find(a => a.id === '10|9').overlapQuestions, 3);
assert.equal(authors.some(a => a.name.includes('Не автор')), false);
assert.equal(S.questionDetails([credited]).find(q => q.number === 4).authorGroups.length, 2);
const unresolved = S.byAuthor([{ ...base, questionCredits: [{ from: null, to: null, authors: [{ id: null, name: null, tentative: true, candidates: [{ id: 10, name: 'Один человек' }, { id: 11, name: 'Один человек' }] }] }] }]);
assert.equal(unresolved[0].questions, 5);
assert.equal(unresolved[0].authors.length, 1);
assert.equal(unresolved[0].unresolvedAuthors, 1);
assert.equal(unresolved[0].name.includes('Без имени'), false);
assert.equal(unresolved[0].name.includes('ID не подтверждён'), true);

// Shared first places are wins even when the official mean rank is 1.5.
const tieWin = { ...short, position: 1.5, score: 4, scoreDistribution: [{ score: 4, count: 2 }, { score: 1, count: 3 }] };
assert.equal(S.summarize([tieWin]).wins, 1);
assert.equal(S.summarize([tieWin]).podiums, 1);

// Empty and maskless datasets are usable by charts without misleading zero rates.
assert.equal(S.summarize([]).takeRate, null);
assert.equal(S.summarize([]).avgPercentile, null);
assert.equal(S.insights([]).length, 1);
const maskless = S.summarize([{ ...short, mask: null, fieldRates: null }]);
assert.equal(maskless.knownAnswers, 0);
assert.equal(maskless.unknownAnswers, 2);
assert.equal(maskless.takeRate, null);
assert.equal(maskless.excess, null);
assert.equal(S.insights([base, short]).every(i => i.title && i.text), true);
console.log('analytics: all checks passed');
