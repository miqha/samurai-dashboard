'use strict';
const assert = require('node:assert/strict');
const UI = require('../mistakes-ui.js');
const row = { key: 'format:duplet', dimension: 'format', label: 'Дуплеты', questions: 4, takes: 0, misses: 4, teamRate: 0, fieldRate: .42, gap: -.42, smallSample: true, trainingCount: 12, trainingQuestionIds: ['new1', 'new2'], trainingExplanation: 'Только подтверждённые дуплеты.', missed: [{ number: 5, fieldRate: .6, fieldCount: 40, sourceUrl: 'https://gotquestions.online/question/123' }], preset: { questionIds: ['new1','new2'], focusKind: 'mistakes', focusLabel: 'Дуплеты' } };
const data = { available: true, tournament: { id: 10, name: 'Игра <script>X</script>', date: '2026-11-10', performance: 0 }, skippedNewer: [{ name: 'Более новая игра' }], summary: { questions: 36, takes: 10, misses: 26, teamRate: 10/36, fieldRate: .42 }, categories: [row, { ...row, key: 'difficulty:hard', dimension: 'difficulty', label: 'Сложные вопросы', trainingCount: 0, trainingQuestionIds: [], missed: [] }], priorities: [row] };
let html = UI.markup(data);
assert.doesNotMatch(html, /NaN|undefined|<script>/);
assert.match(html, /Перфоманс B · 0/);
assert.match(html, /Игра &lt;script&gt;/);
assert.match(html, /Более новых турниров/);
assert.match(html, /Мало вопросов/);
assert.match(html, /Только подтверждённые дуплеты/);
assert.match(html, /data-sort-value=/);
assert.match(html, /Ссылки раскрывают ответы/);
assert.doesNotMatch(UI.diagnosticsTable([{ ...row, label: '<img src=x onerror=x>' }]), /<img/);
assert.doesNotMatch(UI.markup({ ...data, categories: [{ ...row, missed: [{ sourceUrl: 'javascript:alert(1)' }] }], priorities: [] }, { all: true }), /javascript:/);
assert.match(UI.markup({ available: false, reason: 'Нет проверенных вопросов' }), /Нет проверенных вопросов/);
assert.match(UI.markup({ ...data, priorities: [] }), /нет категорий со взятием ниже поля/);
assert.match(UI.markup(data, { all: true, dimension: 'difficulty' }), /data-mistakes-train disabled/);

// Minimal DOM adapter tests actual category navigation and exact preset delivery.
class Mount {
  set innerHTML(html) { this.html = html; this.nodes = []; for (const m of html.matchAll(/<(?:button|input|div|select)\b([^>]*)>/g)) { const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(x => [x[1], x[2] || ''])); this.nodes.push({ attrs, dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k,v]) => [k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()), v])), textContent: '' }); } }
  querySelectorAll(selector) { const key = selector.slice(1, -1); return this.nodes.filter(n => Object.hasOwn(n.attrs, key)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const mount = new Mount(), requested = [], opened = [];
UI.render({ mount, data, onTrain: preset => { requested.push(preset); return false; }, openTournament: id => opened.push(id) });
mount.querySelector('[data-mistakes-train]').onclick();
assert.deepEqual(requested[0].questionIds, ['new1','new2']);
assert.match(mount.querySelector('[data-mistakes-message]').textContent, /незавершённая/);
mount.querySelector('[data-mistakes-tournament]').onclick(); assert.deepEqual(opened, ['10']);
mount.querySelectorAll('[data-mistakes-dimension]').find(n=>n.dataset.mistakesDimension==='forms').onclick();
assert.match(mount.html, /нет категорий/);
mount.querySelector('[data-mistakes-all]').onchange({ target: { checked: true } });
assert.match(mount.html, /нет сопоставимых/);
mount.querySelectorAll('[data-mistakes-dimension]').find(n=>n.dataset.mistakesDimension==='all').onclick();
mount.querySelectorAll('[data-mistakes-category]').find(n=>n.dataset.mistakesCategory==='difficulty:hard').onclick();
assert.match(mount.html, /data-mistakes-train disabled/);
console.log('Latest-game remediation UI: exact category presets, no silent broadening, small samples, empty and safe states passed.');

// Selecting a tournament replaces diagnosis, source links and the training preset.
const secondRow = { ...row, key: 'forms:rhyme', dimension: 'forms', label: 'Рифма', trainingCount: 1, trainingQuestionIds: ['only-second'], preset: { questionIds: ['only-second'], focusKind: 'mistakes', remediation: { tournamentId: 20 } } };
const secondReport = { ...data, tournament: { id: 20, name: 'Вторая игра', date: '2026-10-01', performance: 700 }, categories: [secondRow], priorities: [secondRow], skippedNewer: [], summary: { ...data.summary, takes: 5 } };
const choices = [{ ...data.tournament, recentPlayed: true, recentPublished: true, publishedAt: '2026-11-12T00:00:00Z' }, { ...secondReport.tournament, recentPlayed: false, recentPublished: true, publishedAt: '2026-11-13T00:00:00Z' }];
const bundle = { ...data, tournaments: choices, reports: { '10': data, '20': secondReport }, publicationCoverage: { missingPublicationDates: 2 } };
html = UI.markup(bundle);
assert.equal((html.match(/<option /g) || []).length, 2);
assert.match(html, /последние сыгранные \+ свежие публикации/);
assert.match(html, /нет подтверждённой даты публикации/);
assert.match(html, /Опубликован на GotQuestions: 12.11.2026/);
const picked = [];
UI.render({ mount, data: bundle, onTrain: preset => picked.push(preset) });
mount.querySelector('[data-mistakes-select]').onchange({ target: { value: '20' } });
assert.match(mount.html, /data-mistakes-tournament="20"/);
assert.match(mount.html, /Вторая игра/);
assert.match(mount.html, /Перфоманс B · 700/);
assert.match(mount.html, /Рифма/);
assert.doesNotMatch(mount.html, /Дуплеты/);
mount.querySelector('[data-mistakes-train]').onclick();
assert.deepEqual(picked[0].questionIds, ['only-second']);
assert.equal(picked[0].remediation.tournamentId, 20);
// A parent re-render, including a switch between Training/Focus, keeps the game.
UI.render({ mount, data: bundle });
assert.match(mount.html, /value="20" selected/);
mount.querySelector('[data-mistakes-select]').onchange({ target: { value: '999' } });
assert.match(mount.html, /value="20" selected/, 'An unavailable selection cannot silently open another report');
// A filter removing the selected game resolves to the default available choice.
UI.render({ mount, data: { ...bundle, tournaments: [choices[0]], reports: { '10': data } } });
assert.match(mount.html, /value="10" selected/);
// Insufficient field data does not hide the selector for the other games.
const unavailable = { ...secondReport, available: false, reason: 'Недостаточно ответов соперников' };
html = UI.markup({ ...bundle, reports: { '10': data, '20': unavailable } }, { tournamentId: '20' });
assert.match(html, /data-mistakes-select/);
assert.match(html, /Недостаточно ответов соперников/);
assert.doesNotMatch(html, /data-mistakes-train/);
html = UI.markup({ ...bundle, reports: {} }, { tournamentId: '20' });
assert.match(html, /Разбор выбранного турнира недоступен/);
console.log('Tournament picker: exact report/preset switch, deduplicated options, persistence, filters and unavailable states passed.');
