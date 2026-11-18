const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Q = require('../question-types.js');
const game = { id: 1, included: true, name: 'A', mask: '101?0', totalQuestions: 5, canceledQuestions: [3], fieldCounts: [10, 10, 10, 10, 0], fieldSuccesses: [2, 8, 6, 5, 0], fieldRates: [.2, .8, .6, .5, null] };
const rows = Array.from({ length: 5 }, (_, i) => ({ tournamentId: 1, number: i + 1, handout: i === 0 ? 'with' : 'without', format: 'ordinary', forms: i === 0 ? ['same_vowels', 'paired_initials'] : ['unmarked'] }));
const data = { questions: rows, tournaments: [{ tournamentId: 1, status: 'matched' }] };
const before = JSON.stringify([data, game]);
let s = Q.summarize(data, [game]);
assert.equal(s.coverage.knownQuestions, 3, 'Canceled and missing mask responses excluded');
assert.equal(s.coverage.classifiedKnown, 3);
assert.equal(s.coverage.comparableQuestions, 2, 'Unknown field response excluded for both team and field');
assert.equal(s.groups.handout[0].teamRate, 1);
assert.equal(s.groups.handout[0].fieldRate, .2);
assert.equal(s.groups.handout[1].teamRate, 0);
assert.equal(s.groups.handout[1].fieldRate, .8);
assert.equal(s.groups.forms.find(x => x.id === 'same_vowels').questions, 1);
assert.equal(s.groups.forms.find(x => x.id === 'paired_initials').questions, 1, 'Overlapping form labels retained');
assert.equal(JSON.stringify([data, game]), before, 'Source snapshot is immutable');
assert.equal(Q.summarize({ ...data, questions: rows.concat(rows) }, [game]).coverage.comparableQuestions, 2, 'Duplicate metadata cannot double counts');
assert.equal(Q.summarize(data, [{ ...game, included: false }]).coverage.comparableQuestions, 0);
assert.equal(Q.summarize(data, [{ ...game, id: 2 }]).coverage.comparableQuestions, 0, 'Respects selected games');
const two = { ...game, totalQuestions: 2, mask: '10', canceledQuestions: [], fieldCounts: [1, 100], fieldSuccesses: [1, 0] };
const weighted = Q.summarize(data, [two]).groups.format[0];
assert.equal(weighted.fieldRate, .5, 'Equal weight per question, not pooled opponent responses');
const root = path.join(__dirname, '..');
if (fs.existsSync(path.join(root, 'data/played-questions.json'))) {
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'data/played-questions.json')));
  const history = JSON.parse(fs.readFileSync(path.join(root, 'data/dashboard.json')));
  const result = Q.summarize(actual, history.tournaments);
  assert.ok(result.coverage.comparableQuestions > 100);
  assert.equal(result.groups.handout.reduce((n, r) => n + r.questions, 0), result.coverage.comparableQuestions);
  assert.equal(result.groups.format.reduce((n, r) => n + r.questions, 0), result.coverage.comparableQuestions);
  for (const rows of Object.values(result.groups)) for (const r of rows) {
    assert.ok(r.questions === 0 ? r.teamRate === null && r.fieldRate === null : r.teamRate >= 0 && r.teamRate <= 1 && r.fieldRate >= 0 && r.fieldRate <= 1);
  }
}
console.log('Question type comparison tests passed');
