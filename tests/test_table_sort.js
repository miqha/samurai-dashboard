'use strict';
const assert = require('node:assert/strict');
const S = require('../table-sort.js');

// A small DOM fixture retains node identity and browser-style live row lists.
// This exercises the sorter itself, not a second implementation of sorting.
class TextNode {
  constructor(value, doc) { this.nodeType = 3; this.nodeValue = String(value); this.ownerDocument = doc; this.parentElement = null; }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
}
class Element {
  constructor(tag, doc) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.attrs = new Map(); this.parentElement = null; this.hidden = false; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name), add: name => { if (!this.className.split(/\s+/).includes(name)) this.className = (this.className + ' ' + name).trim(); } }; }
  get colSpan() { return Number(this.getAttribute('colspan')) || 1; }
  get cells() { return this.children.filter(node => ['TH', 'TD'].includes(node.tagName)); }
  get rows() { return this.tagName === 'TABLE' ? this.children.flatMap(node => node.rows || []) : this.children.filter(node => node.tagName === 'TR'); }
  get tHead() { return this.children.find(node => node.tagName === 'THEAD') || null; }
  get tBodies() { return this.children.filter(node => node.tagName === 'TBODY'); }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.childNodes.forEach(node => { node.parentElement = null; }); this.childNodes = []; if (String(value)) this.appendChild(new TextNode(value, this.ownerDocument)); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  appendChild(node) { if (node.parentElement) node.parentElement.childNodes.splice(node.parentElement.childNodes.indexOf(node), 1); this.childNodes.push(node); node.parentElement = this; return node; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentElement = null; }
  matches(selector) { return selector[0] === '[' ? this.attrs.has(selector.slice(1, -1)) : this.tagName === selector.toUpperCase(); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
}
class Document {
  constructor() { this.readyState = 'complete'; this.listeners = {}; this.documentElement = this.createElement('html'); this.body = this.documentElement.appendChild(this.createElement('body')); }
  createElement(tag) { return new Element(tag, this); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  addEventListener(name, callback, capture) { (this.listeners[name] ||= []).push({ callback, capture }); }
  dispatch(name, target, extra = {}) { const event = { target, ...extra, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; for (const { callback } of this.listeners[name] || []) callback(event); return event; }
}
const doc = new Document();
const el = (tag, text = '') => { const node = doc.createElement(tag); if (text) node.textContent = text; return node; };
function table(headers, values) {
  const node = el('table'), head = node.appendChild(el('thead')), row = head.appendChild(el('tr'));
  headers.forEach(label => row.appendChild(el('th', label)));
  const body = node.appendChild(el('tbody'));
  values.forEach((values, id) => { const r = body.appendChild(el('tr')); r.id = id; values.forEach(value => r.appendChild(el('td', value))); });
  doc.body.appendChild(node);
  return node;
}
const ids = table => Array.from(table.tBodies[0].rows, row => row.id);
const fixtures = [
  ['1\u00a0234,50', 'number', 1234.5], ['−1,7%', 'number', -1.7], ['0', 'number', 0],
  ['+12,4', 'number', 12.4], ['5 / 36', 'number', 5], ['-30 – 200', 'number', -30],
  ['6 участников', 'number', 6], ['1.2e-7', 'number', 1.2e-7], ['36 обезьян', 'text', '36 обезьян'],
  ['07.11.2026', 'date', Date.UTC(2026, 10, 7)], ['2026-11-08', 'date', Date.UTC(2026, 10, 8)],
  ['09.11.2026, 14:05:21', 'date', Date.UTC(2026, 10, 9, 14, 5, 21)],
  ['1723456789123', 'number', 1723456789123],
  ['31.02.2026', 'text', '31.02.2026'], ['—', 'missing', null], ['Не оценён · 1 игра', 'missing', null],
  ['не рассчитан', 'missing', null], ['', 'missing', null]
];
fixtures.forEach(([raw, kind, value]) => assert.deepEqual(S.parseValue(raw), { kind, value }, raw));
assert.ok(S.compareValues('—', '0', 'asc') > 0);
assert.ok(S.compareValues('—', '0', 'desc') > 0);
assert.ok(S.compareValues('Игра 2', 'Игра 12') < 0, 'Russian natural collation');

const t = table(['Имя', 'Дата', 'B', 'Взятие'], [
  ['Яна', '02.01.2026', '0', '9,5%'],
  ['Борис', '30.12.2025', '1 005', '100,0%'],
  ['Анна', '07.11.2026', '—', '20%'],
  ['Вера', '01.03.2024', '0', '—']
]);
const originalRows = Array.from(t.tBodies[0].rows);
const sub = originalRows[0].cells[0].appendChild(el('span', 'не должен влиять на имя')); sub.className = 'table-sub';
const denominator = originalRows[1].cells[2].appendChild(el('small', '/ 2000'));
const sample = originalRows[1].cells[2].appendChild(el('span', 'мало игр')); sample.className = 'sample-small';
assert.equal(S.cellValue(originalRows[1].cells[2]).value, 1005);
assert.equal(S.cellValue(originalRows[0].cells[0]).value, 'Яна');
let observed = null;
global.MutationObserver = class { constructor(callback) { observed = callback; } observe() {} };
S.install(doc);
assert.ok(observed, 'Dynamic tables are observed');
const headers = t.tHead.rows[0].cells;
headers.forEach((header, index) => {
  assert.equal(header.getAttribute('data-table-sort-column'), String(index));
  assert.equal(header.getAttribute('aria-sort'), 'none');
  assert.equal(header.children[0].tagName, 'BUTTON');
});
const clicked = doc.dispatch('click', headers[2].children[0]);
assert.ok(clicked.prevented && clicked.stopped, 'One shared handler owns sorting');
assert.deepEqual(ids(t), [0, 3, 1, 2], 'First click: numeric ascending, stable zero ties, missing last');
assert.equal(headers[2].getAttribute('aria-sort'), 'ascending');
doc.dispatch('click', headers[2]);
assert.deepEqual(ids(t), [1, 0, 3, 2], 'Second click: descending, missing still last');
assert.equal(headers[2].getAttribute('aria-sort'), 'descending');
doc.dispatch('click', headers[2].children[0]);
assert.deepEqual(ids(t), [0, 1, 2, 3], 'Third click restores the inserted order exactly');
assert.equal(headers[2].getAttribute('aria-sort'), 'none');
doc.dispatch('click', headers[1].children[0]);
assert.deepEqual(ids(t), [3, 1, 0, 2], 'Dates compare chronologically across years');
doc.dispatch('click', headers[0].children[0]);
assert.deepEqual(ids(t), [2, 1, 3, 0], 'Switching columns starts ascending');
assert.equal(headers[1].getAttribute('aria-sort'), 'none');
S.sort(t, 3, 'asc');
assert.deepEqual(ids(t), [0, 2, 1, 3], 'Percentages compare numerically');
S.sort(t, 3, null);
assert.deepEqual(Array.from(t.tBodies[0].rows), originalRows, 'Sorting retains original row nodes and their event handlers');

const beforeButton = headers[0].children[0];
S.refresh(t); S.refresh(t);
assert.equal(headers[0].children.length, 1);
assert.equal(headers[0].children[0], beforeButton, 'Enhancement preserves focused header controls');
assert.equal(beforeButton.querySelectorAll('span').length, 1, 'Repeated mutation callbacks do not add arrows');

S.sort(t, 2, 'desc');
const added = t.tBodies[0].appendChild(el('tr')); added.id = 4;
['Глеб', '01.01.2027', '500', '50%'].forEach(value => added.appendChild(el('td', value)));
observed([{ target: t.tBodies[0], addedNodes: [added] }]);
assert.deepEqual(ids(t), [1, 4, 0, 3, 2], 'Appending to an active table retains its sorting');
S.sort(t, 2, null);
assert.deepEqual(ids(t), [0, 1, 2, 3, 4], 'Restore includes new rows in their insertion order');
t.tBodies[0].removeChild(originalRows[1]);
S.refresh(t); S.sort(t, 2, 'asc'); S.sort(t, 2, null);
assert.deepEqual(ids(t), [0, 2, 3, 4], 'Removed rows never reappear');

const second = table(['Число'], [['20 / 100'], ['3 / 5'], ['—']]);
second.tBodies[0].rows[0].cells[0].setAttribute('data-sort-value', '0.2');
second.tBodies[0].rows[1].cells[0].setAttribute('data-sort-value', '0.6');
observed([{ target: doc.body, addedNodes: [second] }]);
const secondHeader = second.tHead.rows[0].cells[0];
assert.ok(secondHeader.children[0].classList.contains('table-sort-button'), 'A newly rendered table is enhanced');
S.sort(second, 0, 'desc');
assert.deepEqual(ids(second), [1, 0, 2], 'Explicit source values take priority over displayed ratios');
assert.equal(headers[0].getAttribute('aria-sort'), 'none', 'Sorting state is independent for each table');
S.sort(second, 0, null);
const keyboard = doc.dispatch('keydown', secondHeader, { key: 'Enter' });
assert.ok(keyboard.prevented);
assert.equal(secondHeader.getAttribute('aria-sort'), 'ascending', 'Enter supports header activation');
const buttonKeyboard = doc.dispatch('keydown', secondHeader.children[0], { key: 'Enter' });
assert.ok(!buttonKeyboard.prevented, 'Native button keyboard activation is not doubled');
assert.equal(S.sort(second, 99, 'asc'), false, 'Invalid columns are rejected');
delete global.MutationObserver;
console.log(`table sorting: ${fixtures.length} parsing cases; three-click cycle, stable ties, missing values, dates, percentages, dynamic tables, keyboard and row identity passed`);
