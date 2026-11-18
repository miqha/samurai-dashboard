'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../training-core.js');
const decode = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
class Node {
  constructor(tag = 'div', attrs = {}, parent = null) { this.tagName = tag.toUpperCase(); this.attrs = attrs; this.parent = parent; this.children = []; this._text = ''; this._value = null; this.style = {}; this.hidden = Object.hasOwn(attrs, 'hidden'); this.disabled = Object.hasOwn(attrs, 'disabled'); this.checked = Object.hasOwn(attrs, 'checked'); this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase()), v])); this.classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean)); this.classList = { contains: v => this.classes.has(v), toggle: (v, on) => { if (on === undefined ? !this.classes.has(v) : on) this.classes.add(v); else this.classes.delete(v); } }; }
  matches(selector) { if (selector.startsWith('#')) return this.attrs.id === selector.slice(1); if (selector.startsWith('.')) return this.classes.has(selector.slice(1)); const match = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/); if (match) return Object.hasOwn(this.attrs, match[1]) && (match[2] === undefined || this.attrs[match[1]] === match[2]); return this.tagName.toLowerCase() === selector; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let n = this; n; n = n.parent) if (n.matches(selector)) return n; return null; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  get value() { if (this._value !== null) return this._value; if (this.tagName === 'SELECT') { const options = this.querySelectorAll('option'); return (options.find(o => Object.hasOwn(o.attrs, 'selected')) || options[0] || { attrs: {} }).attrs.value || ''; } if (this.tagName === 'TEXTAREA') return this.textContent; return this.attrs.value || ''; }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(html) { this.children = []; this._text = ''; const stack = [this]; const tokens = String(html).match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || []; for (const token of tokens) { if (token.startsWith('<!--')) continue; if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); } else if (token.startsWith('<')) { const match = token.match(/^<([a-z0-9]+)\b([\s\S]*?)\/?\s*>$/i); if (!match) continue; const attrs = {}; const attr = /([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; for (const item of match[2].matchAll(attr)) attrs[item[1]] = decode(item[2] ?? item[3] ?? item[4] ?? ''); const node = new Node(match[1], attrs, stack.at(-1)); stack.at(-1).children.push(node); if (!/^(input|img|br|hr|meta|link|source|wbr)$/i.test(match[1]) && !token.endsWith('/>')) stack.push(node); } else stack.at(-1)._text += decode(token); } }
  click() { if (!this.disabled && this.onclick) this.onclick({ target: this }); }
}
function environment(storage = new Map(), initialNow = 100000) {
  let now = initialNow; const intervalCallbacks = [], audioEvents = [], charts = [];
  const section = new Node('section', { class: 'view active' }); const mount = new Node('div', { id: 'trainingRoot' }, section); section.children.push(mount);
  const doc = { querySelector: selector => selector === '#trainingRoot' ? mount : section.querySelector(selector), addEventListener() {}, createElement: tag => new Node(tag) };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class Audio { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; } createOscillator() { return { type: '', frequency: {}, connect() {}, start(t) { audioEvents.push({ now, t }); }, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } }
  const runtime = { document: doc, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) }, setInterval: cb => intervalCallbacks.push(cb), setTimeout: cb => { cb(); return 1; }, AudioContext: Audio, Date: ClockDate, console, Blob: class {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, scrollY: 0, scrollTo() {} }; runtime.window = runtime;
  vm.createContext(runtime); for (const file of ['training-core.js', 'training.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), runtime, { filename: file });
  const questions = Array.from({ length: 5 }, (_, i) => ({ id: `q${i + 1}`, text: `Вопрос ${i + 1}: текст без ответа`, answer: `КАНОН ${i + 1}`, authors: [{ id: 'a', name: 'Автор А' }], package: { id: `p${i}`, name: 'Тестовый пакет', trueDl: 5 }, sourceUrl: 'https://example.com/question' }));
  const options = { data: { questions }, active: true, recommendedDifficulty: 5, colors: { green: '#1', red: '#2', gray: '#3' }, chart: (id, option) => charts.push({ id, option }), base: () => ({ xAxis: { axisLabel: {} }, yAxis: {}, tooltip: {}, series: [] }) };
  function render() { runtime.SamuraiTrainingView.render(options); }
  function node(id) { const n = mount.querySelector('#' + id); assert.ok(n, `Missing UI control ${id}`); return n; }
  function click(id) { node(id).click(); }
  function change(id, value) { const n = node(id); if (typeof value === 'boolean') n.checked = value; else n.value = value; if (n.onchange) n.onchange({ target: n }); }
  function input(answer) { const n = node('trainingAnswer'); assert.equal(n.disabled, false); n.value = answer; n.oninput({ target: n }); }
  function advance(ms) { now += ms; intervalCallbacks.forEach(cb => cb()); }
  function begin() { click('trainingStart'); if (mount.querySelector('#trainingStartTimer')) click('trainingStartTimer'); }
  function next() { click('trainingNext'); if (mount.querySelector('#trainingStartTimer')) click('trainingStartTimer'); }
  return { begin, next, runtime, storage, mount, section, render, node, click, change, input, advance, audioEvents, charts, options, now: () => now, session: () => JSON.parse(storage.get('samurai-training-session-v1') || 'null'), history: () => JSON.parse(storage.get('samurai-training-history-v1') || '[]') };
}
// Reading is explicit for every question, including after reload and navigation.
let env = environment(); env.render(); env.click('trainingStart');
assert.equal(env.session().status, 'reading'); assert.equal(env.session().clock, null);
assert.match(env.mount.textContent, /Вопрос [1-5]: текст без ответа/); assert.doesNotMatch(env.mount.textContent, /КАНОН/);
assert.equal(env.node('trainingAnswer').disabled, true); assert.equal(env.node('trainingClock').textContent, '60');
assert.equal(env.node('trainingPhase').textContent, 'ЧТЕНИЕ ВОПРОСА');
env.advance(180000); assert.equal(env.session().status, 'reading'); assert.equal(env.audioEvents.length, 0);
const readingStorage = env.storage; env = environment(readingStorage, env.now() + 360000); env.render();
assert.equal(env.session().status, 'reading'); assert.equal(env.node('trainingClock').textContent, '60');
env.click('trainingStartTimer'); assert.equal(env.session().status, 'running');
env.advance(12000); env.input('Проверка отсчёта'); env.click('trainingSubmit'); assert.equal(env.session().attempts[0].elapsed, 12);
env.click('trainingNext'); assert.equal(env.session().status, 'reading'); assert.equal(env.session().clock, null);
env.advance(90000); assert.equal(env.session().status, 'reading'); assert.equal(env.node('trainingClock').textContent, '60');
env.click('trainingFinish'); env.click('trainingShowResults'); assert.equal(C.summary(env.session()).attempted, 1);
// Finishing before the first clock starts records no missed or attempted questions.
env = environment(); env.render(); env.click('trainingStart'); env.advance(100000); env.click('trainingFinish');
assert.equal(C.summary(env.session()).attempted, 0); assert.equal(C.summary(env.session()).unplayed, 5);
env.click('trainingShowResults'); assert.equal(C.validSession(env.session()), true);
// Actual UI controls drive a whole training without revealing answers early.
env = environment(); env.render();
assert.equal(env.node('trainingStart').disabled, false);
assert.match(env.mount.textContent, /Вопросов: 5/);
env.begin();
assert.equal(env.session().status, 'running');
assert.equal(env.node('trainingClock').textContent, '60');
assert.doesNotMatch(env.mount.textContent, /КАНОН/);
const first = env.session().questions[0]; env.input(first.answer); env.advance(12000); env.click('trainingSubmit');
assert.equal(env.session().attempts[0].grade, 1);
assert.equal(env.session().attempts[0].elapsed, 12);
assert.equal(env.node('trainingAnswer').disabled, true);
assert.doesNotMatch(env.mount.textContent.replace(first.answer, ''), /Ответ источника/);
env.advance(90000); assert.equal(env.session().index, 0); env.next();
assert.equal(env.session().index, 1);
assert.equal(env.node('trainingClock').textContent, '60');
// Pause disables answer entry, excludes time, and survives a reload.
env.advance(10000); env.click('trainingPause'); assert.equal(env.node('trainingAnswer').disabled, true);
const pausedStorage = env.storage; env.advance(90000); assert.equal(env.node('trainingClock').textContent, '50');
env = environment(pausedStorage, env.now()); env.render(); assert.equal(env.node('trainingClock').textContent, '50'); assert.equal(env.session().paused, true);
env.click('trainingPause'); env.input('Спорная версия'); env.advance(10000); env.click('trainingSubmit');
assert.equal(env.session().attempts[1].elapsed, 20); assert.equal(env.session().attempts[1].grade, null);
// Background time locks only the current question at 70 seconds, preserving a draft.
env.next(); env.input('Фоновый ответ'); env.runtime.SamuraiTrainingView.setActive(false); env.section.classList.toggle('active', false); env.advance(71000);
assert.equal(env.session().status, 'locked'); assert.equal(env.session().index, 2); assert.equal(env.session().attempts[2].answer, 'Фоновый ответ'); assert.equal(env.session().attempts[2].elapsed, 70);
env.section.classList.toggle('active', true); env.runtime.SamuraiTrainingView.setActive(true); env.render(); assert.equal(env.node('trainingClock').textContent, '✓');
// Early finish does not count remaining questions as missed; results require a separate click.
env.click('trainingFinish'); assert.equal(env.session().status, 'complete'); assert.doesNotMatch(env.mount.textContent, /КАНОН/); env.click('trainingShowResults');
assert.equal(env.session().status, 'results'); assert.match(env.mount.textContent, /КАНОН/); assert.equal(env.history().length, 1);
assert.equal(C.summary(env.session()).unplayed, 2);
assert.ok(env.charts.some(c => c.id === 'trainingHistoryChart'));
const pendingButton = env.mount.querySelectorAll('[data-training-grade]').find(n => n.dataset.trainingGrade === '1' && n.dataset.grade === '1'); pendingButton.click();
assert.equal(env.session().attempts[1].grade, 1); assert.equal(env.history()[0].attempts[1].grade, 1);
assert.equal(C.summary(env.session()).correct, 2);
// Starting a new run returns to setup; history can be regraded, including after reload.
env.click('trainingNew'); assert.equal(env.session(), null); assert.ok(env.node('trainingStart'));
env.mount.querySelector('[data-training-history]').click();
assert.match(env.mount.textContent, /ПРОВЕРКА КАЖДОГО ОТВЕТА/);
const reject = env.mount.querySelectorAll('[data-training-grade]').find(n => n.dataset.trainingGrade === '1' && n.dataset.grade === '0'); reject.click();
assert.equal(env.history()[0].attempts[1].grade, 0);
env.click('trainingNew'); assert.ok(env.node('trainingStart'));
env.change('trainingExcludeSeen', false); env.begin(); assert.equal(env.session().status, 'running');
// A page reload after timeout recovers a locked question, without consuming any next question.
env.input('Сохранённый ответ'); const savedNow = env.now(); env = environment(env.storage, savedNow + 100000); env.render();
assert.equal(env.session().status, 'locked'); assert.equal(env.session().attempts[0].answer, 'Сохранённый ответ'); assert.equal(env.session().index, 0);
// Explicit skips clear the draft and save a zero; an empty submission also remains a zero.
env.next(); env.input('Черновик для пропуска'); env.click('trainingSkip');
assert.equal(env.session().attempts[1].answer, ''); assert.equal(env.session().attempts[1].status, 'skipped'); assert.equal(env.session().attempts[1].grade, 0);
env.next(); env.click('trainingSubmit'); assert.equal(env.session().attempts[2].status, 'empty'); assert.equal(env.session().attempts[2].grade, 0);
// Live sound has one pulse at50 and two at60; the submission phase starts at10.
env.next(); env.advance(50000); assert.equal(env.audioEvents.length, 1); env.advance(10000); assert.equal(env.audioEvents.length, 3); assert.equal(env.node('trainingClock').textContent, '10'); assert.equal(env.node('trainingPhase').textContent, 'СДАЧА ОТВЕТА'); env.advance(10000); assert.equal(env.session().status, 'locked');
// Empty source data keeps existing history accessible and never starts invented questions.
env = environment(new Map(), 0); env.options.data.questions = []; env.render(); assert.equal(env.node('trainingStart').disabled, true); assert.match(env.mount.textContent, /Вопросы пока не загружены/); env.begin(); assert.equal(env.session(), null);
// Invalid/no-match inputs disable start and recover through the same controls.
env = environment(); env.render(); env.change('trainingDifficulty', ''); assert.equal(env.node('trainingStart').disabled, true); env.change('trainingDifficulty', '19'); assert.equal(env.node('trainingStart').disabled, true); env.change('trainingDifficulty', '5'); assert.equal(env.node('trainingStart').disabled, false);
// Unavailable storage keeps a working in-memory run and presents a visible warning.
env.runtime.localStorage.setItem = () => { throw new Error('Storage is unavailable'); }; env.change('trainingCount', '5'); assert.equal(env.node('trainingStorageNotice').hidden, false); env.begin(); assert.ok(env.node('trainingAnswer')); env.input('Ответ без storage'); env.click('trainingSubmit'); env.click('trainingFinish'); env.click('trainingShowResults'); assert.match(env.mount.textContent, /Ответ без storage/);
// Malformed saved state is ignored without breaking setup or existing history.
const brokenStorage = new Map([['samurai-training-session-v1', JSON.stringify({ version: 1, questions: [{}] })], ['samurai-training-history-v1', '{}'], ['samurai-training-config-v1', JSON.stringify({ tolerance: 100, count: -4 })]]);
env = environment(brokenStorage); env.render(); assert.ok(env.node('trainingStart')); assert.equal(env.node('trainingCount').value, '10'); assert.equal(env.node('trainingTolerance').value, '1');
// An initial recommendation outside the real bank selects its nearest available difficulty.
env = environment(); env.options.recommendedDifficulty = 3.8763; env.options.data.questions.forEach(q => { q.package.trueDl = 6; }); env.render(); assert.equal(Number(env.node('trainingDifficulty').value), 6); assert.equal(env.node('trainingStart').disabled, false); assert.match(env.mount.textContent, /Ориентир сыгранных вами пакетов/); assert.equal(env.storage.has('samurai-training-config-v1'), false, 'An automatically proposed default is not a saved user choice');
// Explicit filters are never silently changed, even when they give an empty slice.
env.change('trainingDifficulty', '3'); env.render(); assert.equal(env.node('trainingDifficulty').value, '3'); assert.equal(env.node('trainingStart').disabled, true); const preferences = env.storage; env = environment(preferences); env.options.data.questions.forEach(q => { q.package.trueDl = 6; }); env.render(); assert.equal(env.node('trainingDifficulty').value, '3'); assert.equal(env.node('trainingStart').disabled, true);
// Loading real data after an empty source still resolves the first automatic default.
env = environment(); env.options.recommendedDifficulty = 3.8763; const actual = env.options.data.questions; actual.forEach(q => { q.package.trueDl = 6; }); env.options.data.questions = []; env.render(); env.options.data.questions = actual; env.render(); assert.equal(Number(env.node('trainingDifficulty').value), 6);
// Completed-result restoration keeps both the official answer and the latest self-grade.
env.begin(); env.input('Своя формулировка'); env.click('trainingSubmit'); env.click('trainingFinish'); env.click('trainingShowResults'); env.mount.querySelectorAll('[data-training-grade]').find(n => n.dataset.grade === '1').click(); const completedStorage = env.storage; env = environment(completedStorage, env.now()); env.render(); assert.match(env.mount.textContent, /Своя формулировка/); assert.equal(env.session().attempts[0].grade, 1); assert.ok(env.node('trainingNew'));
// A damaged session missing canonical author/media arrays is rejected instead of crashing rendering.
const incomplete = JSON.parse(completedStorage.get('samurai-training-session-v1')); delete incomplete.questions[0].authors; env = environment(new Map([['samurai-training-session-v1', JSON.stringify(incomplete)]])); env.render(); assert.ok(env.node('trainingStart'));
// Empty deadline time belongs to time-per-question, not to late submitted answers.
env = environment(); env.render(); assert.match(env.node('trainingCount').textContent, /24 вопроса/); env.begin(); env.input('Версия на десятой секунде сдачи'); env.advance(70000); env.next(); env.advance(70000); env.click('trainingFinish'); env.click('trainingShowResults'); assert.match(env.mount.textContent, /1 ответ — в десятисекундку/); assert.match(env.mount.textContent, /Позже 60 секунд сдано: 1 из 1/); assert.match(env.mount.textContent, /Без сданного ответа: 1/); assert.match(env.mount.textContent, /Среднее время на вопрос/); assert.match(env.mount.textContent, /Подходов: 1/); assert.doesNotMatch(env.mount.textContent, /2 ответов/);
// Both late nonempty responses use a plural with an accurate submitted denominator.
env = environment(); env.render(); env.begin(); env.input('Первая версия'); env.advance(70000); env.next(); env.input('Вторая версия'); env.advance(70000); env.click('trainingFinish'); env.click('trainingShowResults'); assert.match(env.mount.textContent, /2 ответа — в десятисекундку/); assert.match(env.mount.textContent, /Позже 60 секунд сдано: 2 из 2/);
// Smoke-test the complete verified on-disk bank through the actual initial UI.
const live = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'training-data.js'), 'utf8'), live);
env = environment(); env.options.data = live.window.SAMURAI_TRAINING_DATA; env.options.recommendedDifficulty = 3.8763; env.render();
const rawBank = env.options.data.questions, normalizedBank = C.questions(env.options.data);
assert.ok(rawBank.length > 0); assert.equal(new Set(rawBank.map(q => String(q.id))).size, rawBank.length, 'Every raw catalog ID must be unique');
assert.equal(normalizedBank.length, rawBank.length, 'The UI pool must retain every published catalog record');
assert.deepEqual(Array.from(normalizedBank, q => q.id).sort(), Array.from(rawBank, q => String(q.id)).sort(), 'Normalization must retain precisely the catalog IDs');
const catalogAuthors = C.authors(normalizedBank), authorOptions = env.node('trainingAuthor').querySelectorAll('option').slice(1);
assert.equal(authorOptions.length, catalogAuthors.length);
assert.deepEqual(authorOptions.map(n => n.value), catalogAuthors.map(a => a.id), 'Rendered authors must retain the canonical surname order');
for (let i = 1; i < catalogAuthors.length; i++) assert.ok(C.compareAuthors(catalogAuthors[i - 1], catalogAuthors[i]) <= 0);
if (env.options.data.meta.complete) {
  assert.equal(rawBank.length, env.options.data.meta.coverage.questions);
  assert.match(env.mount.textContent, /Полный годовой каталог/);
  const unavailable = env.options.data.meta.coverage.unavailableForTraining || 0;
  if (unavailable) assert.ok(env.mount.textContent.includes(`Без опубликованного текста/ответа: ${unavailable} — недоступны для тренировки`));
  env.change('trainingAnyDifficulty', true); env.change('trainingFormat', 'all');
  const expectedPlayable = rawBank.length - unavailable;
  assert.equal(C.candidates(normalizedBank, { author: 'all', format: 'all', difficulty: null, excludeSeen: false }, []).length, expectedPlayable);
  assert.ok(env.node('trainingAvailability').textContent.includes(expectedPlayable.toLocaleString('ru-RU')));
}
assert.equal(env.node('trainingStart').disabled, false);
env.click('trainingStart'); assert.ok(env.node('trainingAnswer')); assert.equal(env.session().status, 'reading'); assert.ok(C.validSession(env.session()));
env.advance(150000); assert.equal(env.session().status, 'reading'); assert.equal(env.node('trainingClock').textContent, '60');
env.click('trainingStartTimer'); assert.equal(env.session().status, 'running'); env.advance(1000);
env.click('trainingFinish'); env.click('trainingShowResults'); assert.match(env.mount.textContent, /Самооценка|Спорные|спорные|Остальные версии/);
// All difficulties explicitly includes unknown trueDL; numeric mode keeps those out.
env = environment(); env.options.data.questions.push({ id: 'unknown', text: 'Вопрос без сложности', answer: 'Канон без сложности', authors: [{ id: 'b', name: 'Анна Бабушкина' }], package: { id: 'unknown', name: 'Без trueDL', trueDl: null, type: 'kvrm' } });
env.options.data.questions.push({ id: 'si', text: 'Вопрос СИ', answer: 'СИ', authors: [{ id: 'c', name: 'Сергей Галеев' }], package: { id: 'si', name: 'Своя игра', trueDl: null, type: 'si' } });
env.options.data.questions.push({ id: 'unavailable', text: 'Текст без опубликованного ответа', answer: '', flags: { missingAnswer: true }, authors: [], package: { id: 'unavailable', name: 'Без ответа', trueDl: null } });
env.options.data.meta = { yearWindow: { from: '2025-11-10', toInclusive: '2026-11-10' }, complete: true, coverage: { questions: 8, unavailableForTraining: 1 } };
env.render(); assert.match(env.mount.textContent, /Полный годовой каталог/); assert.match(env.mount.textContent, /10.11.2025–10.11.2026/); assert.match(env.mount.textContent, /Без опубликованного текста\/ответа: 1 — недоступны для тренировки/);
assert.match(env.node('trainingAvailability').textContent, /Доступно: 5 вопросов/);
env.change('trainingAnyDifficulty', true); assert.equal(env.node('trainingDifficulty').disabled, true); assert.equal(env.node('trainingTolerance').disabled, true); assert.match(env.node('trainingAvailability').textContent, /Доступно: 6 вопросов/);
env.change('trainingFormat', 'all'); assert.match(env.node('trainingAvailability').textContent, /Доступно: 7 вопросов/);
env.change('trainingAuthor', 'b'); env.click('trainingStart'); assert.equal(env.session().status, 'reading'); assert.equal(env.session().questions[0].package.trueDl, null); env.click('trainingStartTimer'); env.input('Версия'); env.click('trainingSubmit'); env.click('trainingFinish'); env.click('trainingShowResults'); assert.match(env.mount.textContent, /Канон без сложности/); assert.doesNotMatch(env.mount.textContent, /NaN/); assert.ok(C.validSession(env.session()));
// Question and handout media are visible before starting, answer/comment media only in review.
env = environment(); env.options.data.questions = [{ id: 'media', text: 'Вопрос с раздаткой', form: 'Животное', answer: 'Медиаответ', authors: [], package: { id: 'p', name: 'Медиапакет', trueDl: 5 }, flags: { nonstandardTiming: true }, media: [
  { type: 'image', url: 'https://example.com/handout.png', role: 'handout' },
  { type: 'audio', url: 'https://example.com/question.mp3', role: 'question' },
  { type: 'video', url: 'https://example.com/answer.mp4', role: 'answer' },
  { type: 'image', url: 'https://example.com/comment.png', role: 'comment' },
  { type: 'image', url: 'javascript:alert(1)', role: 'question' }
] }]; env.render(); env.click('trainingStart');
assert.match(env.mount.textContent, /Форма ответа: Животное/); assert.ok(env.mount.querySelector('img')); assert.ok(env.mount.querySelector('audio')); assert.equal(env.mount.querySelector('video'), null); assert.equal(env.mount.querySelectorAll('img').length, 1); assert.equal(env.mount.querySelector('audio').getAttribute('controls'), ''); assert.match(env.mount.textContent, /нужен интернет/); assert.match(env.mount.textContent, /особый формат/);
env.click('trainingStartTimer'); env.input('Медиаответ'); env.click('trainingSubmit'); env.click('trainingFinish'); assert.equal(env.mount.querySelector('video'), null); env.click('trainingShowResults'); assert.ok(env.mount.querySelector('video')); assert.equal(env.mount.querySelectorAll('img').length, 2); assert.equal(env.mount.querySelector('video').getAttribute('controls'), '');
console.log('Training UI: manual clock per question, year coverage, unknown difficulty, format/media safety, controls, hidden answers, pause/reload, 70s/background timeout, result gating, history regrading, empty answers, skip and 50/60 audio passed.');
// Actual registration controls use the multi-author preset, exclude targets,
// label announced editors honestly and recheck eligibility at click time.
env = environment();
const currentStart = new Date(env.now() - 1000).toISOString(), currentEnd = new Date(env.now() + 1000).toISOString();
env.options.registrationData = { tournaments: [
  { tournamentId: 111, name: 'Ближайшая заявка', dateStart: currentStart, dateEnd: currentEnd, authorBasis: 'rating_editors', authors: [{ id: 'a', name: 'Автор А' }], targetPackageIds: ['p0'], difficultyForecast: 5, declaredAuthorCount: 2, matchedAuthorCount: 1, unmatchedAuthors: [{ name: 'Неизвестный автор' }], ratingUrl: 'https://rating.chgk.info/tournament/111' },
  { tournamentId: 222, name: 'Без совпадений', dateStart: currentStart, dateEnd: currentEnd, authorBasis: 'rating_editors', authors: [], targetPackageIds: [], declaredAuthorCount: 1, matchedAuthorCount: 0, unmatchedAuthors: [{ name: 'Нет в базе' }] },
  { tournamentId: 333, name: 'Старый турнир', dateStart: '1969-01-01T00:00:00Z', dateEnd: '1969-01-02T00:00:00Z', authors: [{ id: 'a', name: 'Автор А' }], targetPackageIds: [] }
] };
env.render();
assert.equal(env.node('trainingRegistration').querySelectorAll('option').length, 3, 'Only two current registrations plus manual choice are listed');
env.change('trainingRegistration', '111');
assert.equal(env.node('trainingAuthor').disabled, true);
assert.match(env.node('trainingRegistrationInfo').textContent, /Редакторы турнира/);
assert.match(env.node('trainingRegistrationInfo').textContent, /редакторство не означает авторство будущего пакета/);
assert.match(env.node('trainingAvailability').textContent, /Доступно: 4/);
env.click('trainingStart');
assert.equal(env.session().status, 'reading', 'Preset sessions still wait for explicit timer start');
assert.ok(env.session().questions.every(q => q.package.id !== 'p0'));
assert.deepEqual(env.session().config.authors, ['a']);
env.click('trainingFinish'); env.click('trainingShowResults'); env.click('trainingNew');
env.change('trainingRegistration', '222');
assert.equal(env.node('trainingStart').disabled, true, 'No matched authors must never open the full bank');
env.change('trainingRegistration', '111'); env.advance(2000); env.click('trainingStart');
assert.equal(env.session(), null, 'An expired registration is rechecked even without reopening the page');
assert.equal(env.node('trainingStart').disabled, true);
env.change('trainingPastRegistrations', true);
assert.equal(env.node('trainingStart').disabled, false, 'Historical preparation is available only when explicitly enabled');
env.change('trainingRegistration', '');
assert.equal(env.node('trainingAuthor').disabled, false);
assert.equal(env.node('trainingStart').disabled, false);
const fresh = { tournaments: [] };
env.runtime.SamuraiTrainingView.setRegistrationData(fresh);
assert.equal(env.node('trainingRegistration').querySelectorAll('option').length, 1, 'Live metadata refresh reaches the setup controls');
console.log('Registration UI: honest editor fallback, exact target exclusion, reading clock, no-match safety, live data and expiry checks passed.');
// Focus selection prepares setup, retains the chosen question set on reload,
// and never replaces an unfinished session.
const focusEnv = environment();
assert.equal(focusEnv.runtime.SamuraiTrainingView.prepareFocus({ questionIds: [], focusLabel: 'Пусто' }).accepted, false);
assert.equal(focusEnv.runtime.SamuraiTrainingView.prepareFocus({ questionIds: ['q1', 'q3'], authors: ['a'], focusLabel: 'Авторы доступных потерь' }).accepted, true);
focusEnv.render();
assert.match(focusEnv.mount.textContent, /Авторы доступных потерь/);
assert.match(focusEnv.node('trainingAvailability').textContent, /Доступно: 2/);
assert.equal(focusEnv.node('trainingAuthor').disabled, true);
const focusedReload = environment(focusEnv.storage); focusedReload.render();
assert.match(focusedReload.mount.textContent, /Авторы доступных потерь/);
focusedReload.click('trainingStart');
assert.deepEqual(focusedReload.session().questions.map(q => q.id).sort(), ['q1','q3']);
assert.equal(focusedReload.session().status, 'reading');
const inProgress = JSON.stringify(focusedReload.session());
assert.equal(focusedReload.runtime.SamuraiTrainingView.prepareFocus({ questionIds: ['q2'], authors: ['a'] }).accepted, false);
assert.equal(JSON.stringify(focusedReload.session()), inProgress);
focusedReload.click('trainingFinish'); focusedReload.click('trainingShowResults');
assert.equal(focusedReload.runtime.SamuraiTrainingView.prepareFocus({ questionIds: ['q2'], authors: ['a'], focusLabel: 'Следующая подборка' }).accepted, true);
focusedReload.render(); focusedReload.click('trainingClearFocus');
assert.equal(focusedReload.node('trainingAuthor').disabled, false);
assert.equal(JSON.parse(focusedReload.storage.get('samurai-training-config-v1')).questionIds, undefined);
assert.equal(focusedReload.history().length, 1, 'Completed approaches are preserved');
// Category practice preserves its exact whitelist and context through setup/results.
const mistakeEnv = environment();
assert.equal(mistakeEnv.runtime.SamuraiTrainingView.prepareFocus({ questionIds: ['q2','q4'], authors: [], focusKind: 'mistakes', focusLabel: 'Дуплеты', focusDescription: 'Только подтверждённые дуплеты из нового пакета.', remediation: { tournamentId: 10, tournamentName: 'Последний турнир', categoryKey: 'format:duplet', categoryLabel: 'Дуплеты', teamRate: 0, fieldRate: .4, questions: 4 } }).accepted, true);
mistakeEnv.render();
assert.match(mistakeEnv.mount.textContent, /Работа над ошибками · Дуплеты/);
assert.match(mistakeEnv.mount.textContent, /Только подтверждённые дуплеты/);
assert.doesNotMatch(mistakeEnv.mount.textContent, /Вопросы выбранных авторов; формы и темы могут различаться/);
assert.match(mistakeEnv.node('trainingAvailability').textContent, /Доступно: 2/);
mistakeEnv.begin();
assert.deepEqual(mistakeEnv.session().questions.map(q=>q.id).sort(), ['q2','q4']);
mistakeEnv.input('Спорная версия'); mistakeEnv.click('trainingSubmit'); mistakeEnv.click('trainingFinish');
assert.doesNotMatch(mistakeEnv.mount.textContent, /ИТОГ ПОДХОДА/);
mistakeEnv.click('trainingShowResults');
assert.match(mistakeEnv.mount.textContent, /РАБОТА НАД ОШИБКАМИ · ИТОГ ПОДХОДА/);
assert.match(mistakeEnv.mount.textContent, /Последний турнир/);
assert.match(mistakeEnv.mount.textContent, /На проверке: 1/);
assert.match(mistakeEnv.mount.textContent, /не измеряют изменение перфоманса/);
mistakeEnv.click('trainingNew'); mistakeEnv.click('trainingClearFocus');
const clearedMistake = JSON.parse(mistakeEnv.storage.get('samurai-training-config-v1'));
assert.equal(clearedMistake.remediation, undefined); assert.equal(clearedMistake.focusKind, undefined);
