'use strict';
// Offline integration smoke: executes the real app and analytics with a small
// DOM/ECharts test double. It checks rendering logic, not browser layout or SVG.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../analytics.js');
const R = require('../roster-stats.js');
const savedSnapshot = require('../data/dashboard.json');
const snapshotBefore = JSON.stringify(savedSnapshot);
// Real, missing and synthetic tournament-B values are exercised in memory.
// Test fixtures never enter the persisted team snapshot or generated dashboard.
const D = JSON.parse(snapshotBefore);
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const decode = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const elements = new Map(), documentEvents = new Map(), windowEvents = new Map();
const exportsCreated = [], anchorsCreated = [];
let documentStub;

class Element {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.id = attributes.id || '';
    this.dataset = Object.fromEntries(Object.entries(attributes).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [camel(k.slice(5)), v]));
    this.style = {};
    this.hidden = false;
    this.open = false;
    this.events = new Map();
    this.options = [];
    this._value = '';
    this._html = '';
    this.textContent = '';
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle: (name, enabled) => { if (enabled === undefined ? !classes.has(name) : enabled) classes.add(name); else classes.delete(name); }
    };
  }
  get value() { return this._value; }
  set value(value) { this._value = this.tagName === 'SELECT' && !this.options.some(o => o.value === String(value)) ? '' : String(value); }
  get selectedOptions() { return this.options.filter(o => o.value === this.value); }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); registerIds(this._html, true); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(listener); }
  insertAdjacentHTML(_, content) {
    this.innerHTML += content;
    if (this.tagName === 'SELECT') {
      for (const m of content.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
        const a = attrs(m[1]); this.options.push({ value: a.value, textContent: decode(m[2]) });
      }
    }
  }
  closest(selector) {
    const match = selector.match(/^\[data-([\w-]+)\]$/);
    if (match) return Object.hasOwn(this.dataset, camel(match[1])) ? this : null;
    return selector === 'button' && this.tagName === 'BUTTON' ? this : null;
  }
  matches(selector) { return selector === 'tr[data-tournament],tr[data-player]' && this.tagName === 'TR' && ('tournament' in this.dataset || 'player' in this.dataset); }
  click() { for (const listener of documentEvents.get('click') || []) listener({ target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, right: 800, top: 0, bottom: 600 }; }
}

function registerIds(markup, replaceChildren = false) {
  for (const tag of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const a = attrs(tag[2]);
    if (a.id && (replaceChildren || !elements.has(a.id))) elements.set(a.id, new Element(tag[1], a));
  }
  if (replaceChildren) {
    const stack = [], voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const tag of markup.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        const index = stack.findLastIndex(entry => entry.name === name);
        if (index < 0) continue;
        const entry = stack[index];
        if (entry.id) elements.get(entry.id)._html = markup.slice(entry.start, tag.index);
        stack.length = index;
      } else if (!voids.has(name) && !/\/$/.test(tag[3])) {
        stack.push({ name, id: attrs(tag[3]).id, start: tag.index + tag[0].length });
      }
    }
  }
  // The personal profile recreates its toolbar on render. New select nodes
  // must behave like fresh DOM nodes, including their declared options.
  if (replaceChildren) for (const m of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const select = elements.get(attrs(m[1]).id);
    if (!select) continue;
    select._html = '';
    select.insertAdjacentHTML('beforeend', m[2]);
    const chosen = [...m[2].matchAll(/<option\b([^>]*)>/g)].find(option => /\bselected(?:\s|=|$)/.test(option[1]));
    select.value = chosen ? attrs(chosen[1]).value : select.options[0]?.value || '';
  }
}
registerIds(html);
for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
  const select = elements.get(attrs(m[1]).id);
  select.insertAdjacentHTML('beforeend', m[2]);
  select.value = select.options[0].value;
}
const views = [...html.matchAll(/<section\b([^>]*data-section="[^"]+"[^>]*)>/g)].map(m => new Element('section', attrs(m[1])));
const nav = [...html.matchAll(/<button\b([^>]*data-view="[^"]+"[^>]*)>/g)].map(m => new Element('button', attrs(m[1]))).filter(b => b.attributes.class !== 'method-link');
const filters = new Element('section', { class: 'filters' });
const segmented = {
  '#trendMode button': ['performance', 'rate'].map(mode => new Element('button', { 'data-mode': mode })),
  '#questionMode button': ['absolute', 'round'].map(mode => new Element('button', { 'data-mode': mode }))
};
documentStub = {
  createElement(tag) { const element = new Element(tag); anchorsCreated.push(element); return element; },
  querySelector(selector) {
    if (selector === '.filters') return filters;
    assert.ok(selector.startsWith('#') && elements.has(selector.slice(1)), `Unknown DOM selector ${selector}`);
    return elements.get(selector.slice(1));
  },
  querySelectorAll(selector) { return selector === '.view' ? views : selector === '#navigation button' ? nav : segmented[selector] || []; },
  addEventListener(type, listener) { if (!documentEvents.has(type)) documentEvents.set(type, []); documentEvents.get(type).push(listener); }
};
let chartOptions = 0;
function checkNumbers(value, label = 'chart') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `Non-finite value in ${label}`);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) checkNumbers(child, `${label}.${key}`);
}
const chartInstances = new Map();
const E = {
  init(element) {
    const instance = { events: {}, disposed: false, dispose() { this.disposed = true; }, resize() {}, on(type, listener) { this.events[type] = listener; }, setOption(option) { checkNumbers(option); chartOptions++; this.option = option; } };
    chartInstances.set(element.id, instance); return instance;
  },
  graphic: { LinearGradient: function () {} }
};
const context = {
  document: documentStub, echarts: E, SAMURAI_DATA: D, SamuraiStats: A, SamuraiRosterStats: R,
  matchMedia: () => ({ matches: true }), innerWidth: 1400, location: { hash: '' },
  console, setTimeout, clearTimeout, Blob,
  URL: { createObjectURL(blob) { exportsCreated.push(blob); return 'blob:dashboard-test'; }, revokeObjectURL() {} },
  addEventListener(type, listener) { windowEvents.set(type, listener); }, scrollTo() {}
};
context.window = context;
vm.createContext(context);
for (const file of ['personal-stats.js', 'personal-ui.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
vm.runInContext(source, context, { filename: 'app.js' });
const app = context.SAMURAI_APP;
assert.ok(app, 'App initialized');
assert.equal(app.state.playersMinGames, false, 'Players start with the complete roster visible');
assert.equal(app.state.personalPlayer, '', 'A personal profile is chosen explicitly');
const all = A.filter(D.tournaments, {});
assert.equal(app.summary.games, all.length);
const sourceBs = savedSnapshot.tournaments.filter(t => t.included !== false).map(t => t.rating.b);
assert.ok(sourceBs.every(b => typeof b === 'number' && Number.isFinite(b)));
assert.equal(app.summary.performanceGames, sourceBs.length, 'Every published source B is used, including inRating=false');
assert.ok(Math.abs(app.summary.avgPerformance - sourceBs.reduce((a, b) => a + b, 0) / sourceBs.length) < 1e-10);
assert.ok(sourceBs.length >= 50, 'Integration covers the complete historical snapshot');
for (const id of ['filterYear', 'filterType', 'filterPlayer']) {
  assert.equal(elements.get(id).value, 'all');
  assert.ok(elements.get(id).options.some(o => o.value === 'all'), `${id} retains its all option`);
}

// A representative matrix includes every year/type, every player, and empty
// intersections. Every data route is rendered for each selected filter triple.
const routes = ['overview', 'tournaments', 'questions', 'players', 'roster', 'authors', 'insights', 'method'];
const years = ['all', ...new Set(all.map(t => t.date.slice(0, 4)))];
const types = ['all', ...new Set(all.map(t => String(t.type)))];
// Also probe IDs appearing only in excluded registrations: stale filter values
// must produce a usable empty state rather than a runtime error.
const players = ['all', ...new Set(D.tournaments.flatMap(t => t.players || []).map(p => String(p.id)))];
const firstYear = [...years].filter(y => y !== 'all').sort()[0];
let renders = 0, emptyRenders = 0;
for (const year of years) for (const type of types) for (const player of players) {
  if (!(player === 'all' || year === 'all' && type === 'all' || year === firstYear && type === 'all')) continue;
  Object.assign(app.state, { year, type, player });
  const expected = A.filter(D.tournaments, { year, type, player });
  for (const route of routes) {
    app.go(route); renders++;
    assert.equal(app.selected.length, expected.length, `${year}/${type}/${player}/${route}`);
    assert.equal(elements.get('views').hidden, !expected.length && route !== 'method');
    assert.equal(elements.get('emptyState').hidden, expected.length > 0 || route === 'method');
    assert.equal(filters.hidden, route === 'method');
    assert.equal(views.filter(v => v.classList.contains('active')).length, 1);
    assert.ok(!elements.get('pageTitle').innerHTML.includes('undefined'));
    if (!expected.length) emptyRenders++;
  }
}
assert.ok(renders >= 500 && emptyRenders > 0, 'Matrix covers normal and empty slices');

// A missing/invalid B never falls back to rt/rg/r/d, a take percentage, or the
// obsolete standalone performance property. Empty roster categories are also
// distinct from unknown B in categories with actual tournaments.
for (let i = 0; i < D.tournaments.length; i++) {
  const t = D.tournaments[i];
  t.rating = { rt: 10000, rg: 9000, r: 8000, d: 7000, ...(t.rating || {}) };
  t.performance = 99999;
  if (i % 2) t.rating.b = '500'; else delete t.rating.b;
}
Object.assign(app.state, { year: 'all', type: 'all', player: 'all', search: '' });
app.go('overview');
assert.equal(app.summary.avgPerformance, null);
assert.equal(app.summary.performanceGames, 0);
assert.equal(chartInstances.get('trendChart').option.series[0].name, 'Перфоманс');
assert.ok(chartInstances.get('trendChart').option.series[0].data.every(v => v === null));
assert.ok(elements.get('kpis').innerHTML.includes('Средний перфоманс'));
app.go('roster');
assert.ok(elements.get('rosterChart').innerHTML.includes('Нет игр одновременно с известным составом и перфомансом'));
assert.ok(elements.get('rosterTable').innerHTML.includes('1 участник'));
assert.ok(elements.get('rosterTable').innerHTML.includes('2 участника'));
assert.ok(elements.get('rosterTable').innerHTML.includes('7 участников'));
assert.ok(!elements.get('rosterTable').innerHTML.includes('performance-tag'), 'Missing performances do not manufacture zero estimates');

// Deliberately unrelated to take rate, position, rt/rg/r/d and the obsolete
// performance property. Newly populated comparisons must use rating.b only.
for (let i = 0; i < D.tournaments.length; i++) {
  D.tournaments[i].rating.b = i === 2 ? 0 : i % 9 === 0 ? null : 700 + (i % 13) * 217 + (R.rosterSize(D.tournaments[i]) || 0) * 31;
  if (i === 2) D.tournaments[i].rating.inRating = false;
}
app.go('overview');
const ratedValues = all.map(A.performance).filter(v => v !== null);
assert.ok(ratedValues.length > 20 && ratedValues.length < all.length);
assert.ok(Math.abs(app.summary.avgPerformance - ratedValues.reduce((a, b) => a + b, 0) / ratedValues.length) < 1e-9);
assert.equal(app.summary.performanceGames, ratedValues.length);
assert.notEqual(app.summary.avgPerformance, app.summary.takeRate * 100);

function click(attributes) { const target = new Element('button', attributes); target.click(); }
function rowNames(id) {
  const body = elements.get(id).innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert.ok(body, `Table ${id} has rows`);
  return [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m => decode(m[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/)[1].split('<span')[0].trim()));
}
function rawPlayerCounts(tournaments) {
  const counts = new Map();
  for (const tournament of tournaments.filter(t => t.included !== false)) {
    for (const id of new Set((tournament.players || []).map(p => String(p.id)))) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}
function rawPairCounts(tournaments) {
  const pairs = new Map();
  for (const tournament of tournaments.filter(t => t.included !== false)) {
    const roster = [...new Map((tournament.players || []).map(p => [String(p.id), p])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (let i = 0; i < roster.length; i++) for (let j = i + 1; j < roster.length; j++) {
      const ids = [String(roster[i].id), String(roster[j].id)], key = ids.join('|');
      if (!pairs.has(key)) pairs.set(key, { ids, name: roster[i].name + ' + ' + roster[j].name, games: 0 });
      pairs.get(key).games++;
    }
  }
  return [...pairs.values()];
}
function change(id, value) {
  const element = elements.get(id); assert.ok(element, `DOM control ${id} exists`);
  element.value = String(value);
  assert.equal(element.value, String(value), `${id}: requested option exists`);
  const event = { target: element };
  if (typeof element.onchange === 'function') element.onchange(event);
  for (const listener of element.events.get('change') || []) listener(event);
}
function tablePlayerIds() {
  return [...elements.get('playerTable').innerHTML.matchAll(/data-player="([^"]+)"/g)].map(m => m[1]).sort();
}
function assertPlayerThreshold(tournaments, minimum) {
  const counts = rawPlayerCounts(tournaments), visible = new Set([...counts].filter(([, games]) => games >= minimum).map(([id]) => id));
  assert.deepEqual(tablePlayerIds(), [...visible].sort(), 'Player table uses counts in the current slice');
  if (visible.size) {
    const byId = new Map(tournaments.flatMap(t => t.players || []).map(p => [String(p.id), p]));
    const visibleNames = new Set([...visible].map(id => byId.get(id).name));
    const playerChart = chartInstances.get('playersChart');
    assert.equal(playerChart.disposed, false);
    assert.equal(playerChart.option.yAxis.data.length, Math.min(16, visible.size));
    assert.ok(playerChart.option.yAxis.data.every(name => visibleNames.has(name)), 'Hidden players cannot remain on the participation chart');
    const network = chartInstances.get('networkChart');
    assert.equal(network.disposed, false);
    const graph = network.option.series[0], graphIds = new Set(graph.data.map(p => String(p.id)));
    assert.equal(graphIds.size, Math.min(13, visible.size));
    assert.ok([...graphIds].every(id => visible.has(id)), 'Hidden players cannot remain in the network');
    assert.ok(graph.links.every(link => graphIds.has(String(link.source)) && graphIds.has(String(link.target))), 'Network links only join visible nodes');
  } else {
    assert.ok(chartInstances.get('playersChart')?.disposed !== false, 'Empty threshold slice clears the previous chart');
    assert.ok(chartInstances.get('networkChart')?.disposed !== false, 'Empty threshold slice clears the previous network');
  }
  const expectedPairs = rawPairCounts(tournaments).filter(pair => pair.games >= 3 && pair.ids.every(id => visible.has(id))).map(pair => pair.name).sort();
  assert.deepEqual(expectedPairs.length ? rowNames('pairTable').sort() : [], expectedPairs, 'Pairs require three joint games and two visible participants');
  if (!expectedPairs.length) assert.ok(!elements.get('pairTable').innerHTML.includes('<tbody>'), 'No ineligible pair rows survive the threshold');
  return visible;
}
function assertOrdered(rows, key, direction, label) {
  for (let i = 1; i < rows.length; i++) {
    const left = rows[i - 1][key], right = rows[i][key];
    if (right === null || right === undefined) continue;
    assert.notEqual(left, null, `${label}: null values stay last`);
    assert.notEqual(left, undefined, `${label}: undefined values stay last`);
    const difference = typeof left === 'string' ? left.localeCompare(right, 'ru') : left - right;
    assert.ok(direction * difference <= 1e-10, `${label}: ${left} before ${right}`);
  }
}
Object.assign(app.state, { year: 'all', type: 'all', player: 'all', search: '' });
const tables = [
  { kind: 'player', route: 'players', id: 'playerTable', rows: A.byPlayer(all) },
  { kind: 'pair', route: 'players', id: 'pairTable', rows: A.pairs(all).filter(p => p.games >= 3) },
  { kind: 'author', route: 'authors', id: 'authorTable', rows: A.byAuthor(all) },
  { kind: 'editor', route: 'authors', id: 'editorTable', rows: A.byEditor(all) }
];
let sortChecks = 0;
for (const table of tables) {
  app.go(table.route);
  const byName = new Map(table.rows.map(row => [row.name, row]));
  assert.equal(byName.size, table.rows.length, 'Snapshot names uniquely identify table rows');
  assert.equal(rowNames(table.id).length, table.rows.length, `${table.kind}: table contains every eligible row`);
  const keys = [...elements.get(table.id).innerHTML.matchAll(/data-sort-key="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.includes('name'));
  if (table.kind === 'author') {
    assert.ok(keys.includes('takeRate') && keys.includes('excessPerQuestion'), 'Author ranges retain question-based rates');
    assert.ok(!keys.includes('avgPerformance'), 'A tournament performance is not attributed to an author range');
  } else {
    assert.ok(keys.includes('avgPerformance') && keys.includes('medianPerformance') && keys.includes('performanceGames'));
    assert.ok(!keys.includes('takeRate') && !keys.includes('excessPerQuestion'), 'Whole-game people comparisons measure performance');
  }
  assert.equal(new Set(keys).size, keys.length, `${table.kind}: each column has an independent sort key`);
  assert.equal(keys.length, table.kind === 'author' ? 6 : 5, `${table.kind}: every displayed column is sortable`);
  rowNames(table.id).forEach(name => assert.ok(byName.has(name), `${table.kind}: table row belongs to its source slice`));
  sortChecks += keys.length;
}
app.go('tournaments');
const tournamentSortKeys = [...elements.get('tournamentTable').innerHTML.matchAll(/data-sort-key="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(tournamentSortKeys, ['name', 'date', 'performance', 'score', 'trueDL', 'position'], 'Every tournament column is sortable');
const tournamentSortIds = [...elements.get('tournamentTable').innerHTML.matchAll(/data-tournament="([^"]+)"/g)].map(m => m[1]);
assert.equal(tournamentSortIds.length, all.length);
assert.deepEqual(tournamentSortIds.slice().sort(), all.map(t => String(t.id)).sort(), 'Sorting enhancement receives every tournament exactly once');
sortChecks += tournamentSortKeys.length;
// The shared DOM sorter, including the three-click restoration cycle, is tested
// with actual table nodes in test_table_sort.js rather than app-specific state.

// The ten-game button is inclusive and local to the players view. Counts are
// counted directly from source rosters, independently of analytics.byPlayer.
// These temporary players create an exact 9/10 boundary in one real year.
const boundaryYear = '2026';
const boundaryGames = D.tournaments.filter(t => t.included !== false && String(t.date).startsWith(boundaryYear + '-'));
assert.ok(boundaryGames.length >= 10);
const originalRosters = boundaryGames.map(t => t.players);
for (let i = 0; i < 10; i++) boundaryGames[i].players = [...boundaryGames[i].players,
  { id: 'qa-exactly-ten', name: 'Проверка десяти игр' },
  ...(i < 9 ? [{ id: 'qa-only-nine', name: 'Проверка девяти игр' }] : [])];
Object.assign(app.state, { year: boundaryYear, type: 'all', player: 'all', search: '' });
app.go('players');
assert.equal(elements.get('playersMin10').getAttribute('aria-pressed'), 'false');
assertPlayerThreshold(boundaryGames, 1);
elements.get('playersMin10').onclick();
assert.equal(app.state.playersMinGames, true);
assert.equal(elements.get('playersMin10').getAttribute('aria-pressed'), 'true');
const boundaryVisible = assertPlayerThreshold(boundaryGames, 10);
assert.ok(boundaryVisible.has('qa-exactly-ten'), 'Ten games meet the minimum');
assert.ok(!boundaryVisible.has('qa-only-nine'), 'Nine games are hidden');
assert.equal(app.selected.length, boundaryGames.length, 'Hiding player rows does not remove games');
app.go('tournaments');
assert.equal(app.selected.length, boundaryGames.length);
assert.equal([...elements.get('tournamentTable').innerHTML.matchAll(/data-tournament="/g)].length, boundaryGames.length, 'The players threshold does not affect other sections');
// Restore fixtures before testing the real snapshot's year/type/player slices.
boundaryGames.forEach((t, i) => { t.players = originalRosters[i]; });
app.go('players');
change('playersYear', '2024');
assert.equal(app.state.year, '2024');
assert.equal(elements.get('filterYear').value, '2024', 'The players year and global year stay synchronized');
assert.equal(elements.get('playersYear').value, '2024');
const fewGames = all.filter(t => t.date.startsWith('2024-'));
assert.ok(fewGames.length > 0 && fewGames.length < 10);
assertPlayerThreshold(fewGames, 10);
assert.equal(elements.get('views').hidden, false, 'An empty player list leaves its toolbar usable');
change('filterYear', boundaryYear);
assert.equal(elements.get('playersYear').value, boundaryYear, 'Changing the global year also updates the players year');
const focusId = String(boundaryGames[0].players[0].id), focusType = String(boundaryGames[0].type);
change('filterType', focusType);
change('filterPlayer', focusId);
const focusedGames = all.filter(t => t.date.startsWith(boundaryYear + '-') && String(t.type) === focusType && (t.players || []).some(p => String(p.id) === focusId));
assertPlayerThreshold(focusedGames, 10);
elements.get('playersMin10').onclick();
assert.equal(app.state.playersMinGames, false);
assert.equal(elements.get('playersMin10').getAttribute('aria-pressed'), 'false');
assertPlayerThreshold(focusedGames, 1);
elements.get('resetFilters').onclick();

// Exercise registered filter, segmented control, and modal handlers as well.
const yearSelect = elements.get('filterYear'); yearSelect.value = firstYear;
for (const listener of yearSelect.events.get('change')) listener({ target: yearSelect });
assert.equal(app.state.year, firstYear);
assert.equal(app.selected.length, A.filter(all, { year: firstYear }).length);
elements.get('resetFilters').onclick(); assert.equal(app.selected.length, all.length);
app.go('overview'); elements.get('trendMode').onclick({ target: segmented['#trendMode button'][1] }); assert.equal(app.state.trend, 'rate');
assert.equal(chartInstances.get('trendChart').option.series[0].name, 'Взятие');
elements.get('trendMode').onclick({ target: segmented['#trendMode button'][0] }); assert.equal(app.state.trend, 'performance');
assert.equal(chartInstances.get('trendChart').option.series[0].name, 'Перфоманс');
assert.deepEqual(Array.from(chartInstances.get('trendChart').option.series[0].data), [...all].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).map(A.performance));
app.go('questions'); elements.get('questionMode').onclick({ target: segmented['#questionMode button'][1] }); assert.equal(app.state.question, 'round');
app.openTournament(all[0].id);
assert.equal(elements.get('tournamentDialog').open, true);
assert.equal(elements.get('tournamentDialog').getAttribute('aria-labelledby'), 'dialogTitle');
assert.ok(elements.get('dialogContent').innerHTML.includes('id="dialogTitle"'));
elements.get('closeDialog').onclick(); assert.equal(elements.get('tournamentDialog').open, false);

// Roster charts carry the same t-interval as the statistics module. The custom
// renderer's actual coordinates are exercised, not merely its option shape.
Object.assign(app.state, { year: 'all', type: 'all', player: 'all', rosterPoints: true });
app.go('roster');
let rosterChart = chartInstances.get('rosterChart');
assert.equal(rosterChart.disposed, false);
const rosterStats = R.summarize(all, { performance: A.performance });
const means = rosterChart.option.series.find(s => s.name === 'Средний перфоманс');
const intervals = rosterChart.option.series.find(s => s.type === 'custom');
const individuals = rosterChart.option.series.find(s => s.name === 'Отдельные игры');
assert.deepEqual(Array.from(means.data, row => Array.from(row)), rosterStats.groups.filter(g => g.count).map(g => [g.size, g.mean, g.count]));
assert.ok(!means.data.some(row => row[0] === 1 || row[0] === 2), 'Unplayed solo/pair categories have no synthetic mean=0');
assert.ok(means.data.some(row => row[0] === 7), 'Seven declared members remain a separate category');
assert.deepEqual(Array.from(intervals.data, row => Array.from(row)), rosterStats.groups.filter(g => g.lower !== null).map(g => [g.size, g.lower, g.upper]));
assert.equal(individuals.data.length, rosterStats.groupedPerformanceGames);
assert.equal(elements.get('rosterShowGames').getAttribute('aria-pressed'), 'true');
for (const row of intervals.data) {
  const coordinates = [];
  const rendered = intervals.renderItem({}, {
    value(index) { return row[index]; },
    coord(value) { checkNumbers(value, 'confidence coordinate input'); coordinates.push(Array.from(value)); return [value[0] * 100 + 20, 1000 - value[1] / 10]; }
  });
  assert.deepEqual(coordinates, [[row[0], row[1]], [row[0], row[2]]]);
  assert.equal(rendered.children.length, 3); checkNumbers(rendered, 'confidence interval rendered geometry');
  assert.ok(rendered.children.every(c => c.type === 'line'));
}
const groupTooltip = rosterChart.option.tooltip.formatter({ seriesName: means.name, data: means.data[0] });
assert.ok(groupTooltip.includes('95% ДИ среднего') && groupTooltip.includes('Игр с оценкой'));
assert.ok(groupTooltip.includes('не диапазон следующей игры'));
const point = individuals.data[0];
const pointTooltip = rosterChart.option.tooltip.formatter({ seriesName: individuals.name, data: point });
assert.ok(pointTooltip.includes('Перфоманс') && pointTooltip.includes(decode(point[4])));
rosterChart.events.click({ seriesName: individuals.name, data: point });
assert.equal(elements.get('tournamentDialog').open, true);
assert.ok(elements.get('dialogContent').innerHTML.includes(decode(point[4])));
elements.get('closeDialog').onclick();
elements.get('rosterShowGames').onclick();
assert.equal(app.state.rosterPoints, false);
assert.equal(elements.get('rosterShowGames').getAttribute('aria-pressed'), 'false');
assert.ok(!chartInstances.get('rosterChart').option.series.some(s => s.name === 'Отдельные игры'));
elements.get('rosterShowGames').onclick();
assert.equal(app.state.rosterPoints, true);
assert.equal(chartInstances.get('rosterChart').option.series.find(s => s.name === 'Отдельные игры').data.length, rosterStats.groupedPerformanceGames);

// Changing any existing filter updates roster counts and means too. A player
// filter selects team games with that person, not personal question answers.
const rosterSlices = [
  { year: '2026', type: 'all', player: 'all' },
  { year: 'all', type: String(all[0].type), player: 'all' },
  { year: 'all', type: 'all', player: String(all[0].players[0].id) },
  { year: '2025', type: String(all.at(-1).type), player: String(all[0].players[0].id) }
];
for (const slice of rosterSlices) {
  Object.assign(app.state, slice); app.go('roster');
  const filtered = A.filter(D.tournaments, slice), expected = R.summarize(filtered, { performance: A.performance });
  assert.equal(app.selected.length, filtered.length);
  if (!filtered.length) { assert.equal(elements.get('views').hidden, true); continue; }
  const chart = chartInstances.get('rosterChart');
  const observed = expected.groups.filter(g => g.count);
  if (!observed.length) { assert.ok(elements.get('rosterChart').innerHTML.includes('Нет игр одновременно')); continue; }
  assert.deepEqual(Array.from(chart.option.series.find(s => s.name === 'Средний перфоманс').data, row => Array.from(row)), observed.map(g => [g.size, g.mean, g.count]));
  assert.equal(chart.option.series.find(s => s.name === 'Отдельные игры').data.length, expected.groupedPerformanceGames);
}

// Personal profiles keep an independent identity. The team's old "В составе"
// filter must never turn the profile into a list of games shared with somebody
// else, nor narrow the profile's all-history player selector.
const sourcePlayerIds = [...rawPlayerCounts(all).keys()].sort();
const personalId = [...rawPlayerCounts(all)].sort((a, b) => b[1] - a[1])[0][0];
const playerPlayed = (t, id) => (t.players || []).some(p => String(p.id) === String(id));
const personalAllGames = all.filter(t => playerPlayed(t, personalId));
const otherFilterId = sourcePlayerIds.find(id => id !== personalId && personalAllGames.some(t => !playerPlayed(t, id)));
assert.ok(otherFilterId, 'Profile fixture differs from the global player intersection');
const rawPerformance = t => typeof t.rating?.b === 'number' && Number.isFinite(t.rating.b) && t.rating.b >= 0 ? t.rating.b : null;
function profileGames(id = app.state.personalPlayer) {
  return all.filter(t => playerPlayed(t, id) && (app.state.year === 'all' || t.date.startsWith(app.state.year + '-')) && (app.state.type === 'all' || String(t.type) === app.state.type));
}
function assertPersonalHistory(expected) {
  assert.deepEqual(Array.from(app.selected, t => String(t.id)).sort(), expected.map(t => String(t.id)).sort(), 'Personal selection contains only the chosen player/year/type games');
  const historyIds = [...elements.get('personalHistory').innerHTML.matchAll(/data-tournament="([^"]+)"/g)].map(m => m[1]);
  const ordered = [...expected].sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
  assert.deepEqual(historyIds, ordered.map(t => String(t.id)), 'Personal history is complete and newest first');
  const chronological = [...expected].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const rated = chronological.map(rawPerformance);
  if (rated.some(v => v !== null)) {
    const chart = chartInstances.get('personalTrendChart');
    assert.equal(chart.disposed, false);
    assert.deepEqual(Array.from(chart.option.series[0].data), rated, 'Personal progression uses official B including gaps');
  }
}
function assertPersonalTeammates(expectedGames, minimum) {
  const sharedRatedCounts = rawPlayerCounts(expectedGames.filter(t => rawPerformance(t) !== null));
  const expectedIds = [...sharedRatedCounts].filter(([id, games]) => id !== app.state.personalPlayer && games >= minimum).map(([id]) => id).sort();
  const actualIds = [...elements.get('personalTeammateTable').innerHTML.matchAll(/data-personal-player="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(actualIds.slice().sort(), expectedIds, 'Teammate threshold counts only joint games with official B');
  let lastMean = Infinity;
  for (const id of actualIds) {
    const bs = expectedGames.filter(t => playerPlayed(t, id)).map(rawPerformance).filter(v => v !== null);
    const mean = bs.reduce((a, b) => a + b, 0) / bs.length;
    assert.ok(mean <= lastMean + 1e-9, 'Best teammate rows are ordered by joint team B'); lastMean = mean;
  }
  return actualIds;
}
Object.assign(app.state, { year: 'all', type: 'all', player: otherFilterId, personalPlayer: '', playersMinGames: true });
app.go('personal');
assert.equal(elements.get('views').hidden, false, 'The personal welcome view is reachable before choosing a player');
assert.equal(elements.get('emptyState').hidden, true);
assert.equal(app.selected.length, 0, 'No implicit player is selected on the personal welcome view');
assert.equal(elements.get('personalPlayer').value, '');
assert.deepEqual(elements.get('personalPlayer').options.map(o => o.value).filter(Boolean).sort(), sourcePlayerIds, 'Any player from a published historical roster can choose a profile');
assert.ok(elements.get('personalContent').innerHTML.includes('Выберите имя'));
change('personalPlayer', personalId);
assert.equal(app.state.personalPlayer, personalId);
assert.equal(app.state.player, otherFilterId, 'Opening a profile preserves the team player filter');
assertPersonalHistory(personalAllGames);
const teammatesAtThree = assertPersonalTeammates(personalAllGames, 3);
assert.ok(teammatesAtThree.length > 0);
assert.ok(elements.get('personalKpis').innerHTML.includes('95% ДИ среднего'));
assert.ok(elements.get('personalKpis').innerHTML.includes('Средний перфоманс B'));
change('personalMinGames', '1');
const teammatesAtOne = assertPersonalTeammates(personalAllGames, 1);
assert.ok(teammatesAtOne.length >= teammatesAtThree.length);
const teammateId = teammatesAtOne[0];
elements.get('personalTeammateTable').onclick({ target: new Element('button', { 'data-personal-player': teammateId }) });
assert.equal(app.state.personalPlayer, teammateId, 'A teammate link opens that person’s profile');
assert.equal(app.state.player, otherFilterId);
assertPersonalHistory(profileGames());
change('personalPlayer', personalId);
change('personalYear', '2025');
assert.equal(app.state.year, '2025');
assert.equal(elements.get('filterYear').value, '2025', 'Personal year mirrors the shared year control');
assert.equal(elements.get('personalYear').value, '2025');
assertPersonalHistory(profileGames());
assert.deepEqual(elements.get('personalPlayer').options.map(o => o.value).filter(Boolean).sort(), sourcePlayerIds, 'Year selection never removes historical identities');
const profileType = String(profileGames()[0].type);
change('filterType', profileType);
assertPersonalHistory(profileGames());
assertPersonalTeammates(profileGames(), 1);
const personalChart = chartInstances.get('personalTrendChart');
const personalChronological = [...profileGames()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
personalChart.events.click({ dataIndex: 0 });
assert.equal(elements.get('tournamentDialog').open, true);
assert.ok(elements.get('dialogContent').innerHTML.includes(decode(personalChronological[0].name)), 'Personal trend opens the selected performance’s tournament');
elements.get('closeDialog').onclick();
click({ 'data-tournament': String(personalChronological.at(-1).id) });
assert.equal(elements.get('tournamentDialog').open, true);
assert.ok(elements.get('dialogContent').innerHTML.includes(decode(personalChronological.at(-1).name)), 'Personal archive rows use the existing tournament modal');
elements.get('closeDialog').onclick();
const noEarlyGamesId = sourcePlayerIds.find(id => !all.some(t => t.date.startsWith('2024-') && playerPlayed(t, id)));
assert.ok(noEarlyGamesId);
change('filterType', 'all'); change('personalPlayer', noEarlyGamesId); change('personalYear', '2024');
assert.equal(app.state.personalPlayer, noEarlyGamesId);
assert.equal(app.selected.length, 0);
assert.equal(elements.get('views').hidden, false, 'An empty profile retains its name/year controls');
assert.equal(elements.get('emptyState').hidden, true);
assert.ok(elements.get('personalContent').innerHTML.includes('В этом году или формате игр пока нет'));
assert.ok(!elements.get('personalContent').innerHTML.includes('id="personalHistory"'), 'Empty profiles do not retain another player’s archive');
change('personalYear', 'all');
assertPersonalHistory(profileGames());
// Each question list uses actual per-question response coverage, including our
// known response. Apply its threshold before ordering, not tournament rosters.
Object.assign(app.state, {year:'all',type:'all',player:'all'});
app.go('questions');
function questionIds(id) {
  return [...elements.get(id).innerHTML.matchAll(/<tr class="clickable-row" data-tournament="([^"]+)"[^>]*><td[^>]*>[\s\S]*?<\/td><td[^>]*>(\d+)<\/td>/g)].map(m=>m[1]+':'+m[2]);
}
for (const minimum of [0,10,30]) {
  change('rareMinTeams',String(minimum));
  change('missMinTeams',String(minimum));
  const qs=A.questionDetails(all);
  for (const kind of ['rare','miss']) {
    const expected=qs.filter(q=>(kind==='rare'?q.result===1&&q.fieldRate!==null&&q.fieldRate<=.2:q.result===0&&q.fieldRate!==null&&q.fieldRate>=.6)&&(!minimum||q.fieldCount!==null&&q.fieldCount+1>=minimum)).map(q=>q.tournamentId+':'+q.number).sort();
    assert.deepEqual(questionIds(kind+'Table').sort(),expected,kind+' list applies per-question minimum '+minimum);
  }
}
for (const kind of ['rare','miss']) {
  const target=A.questionDetails(all).find(q=>kind==='rare'?q.result===1&&q.fieldRate!==null&&q.fieldRate<=.2:q.result===0&&q.fieldRate!==null&&q.fieldRate>=.6);
  assert.ok(target);
  const t=D.tournaments.find(t=>t.id===target.tournamentId), original=t.fieldCounts[target.number-1];
  for (const minimum of [10,30]) for (const total of [minimum-1,minimum]) {
    t.fieldCounts[target.number-1]=total-1;
    change(kind+'MinTeams',String(minimum));
    assert.equal(questionIds(kind+'Table').includes(target.tournamentId+':'+target.number),total>=minimum,kind+' '+minimum+' boundary is inclusive');
  }
  t.fieldCounts[target.number-1]=original;
}
change('rareMinTeams','10'); change('missMinTeams','30');
assert.equal(app.state.rareMinTeams,10,'Rare threshold is independent');
assert.equal(app.state.missMinTeams,30,'Miss threshold is independent');
change('rareMinTeams','0');change('missMinTeams','0');

assert.equal(JSON.stringify(savedSnapshot), snapshotBefore, 'Integration fixtures leave the saved snapshot untouched');
assert.ok(chartOptions > 400);
console.log(`dashboard: ${renders} renders (${emptyRenders} empty), ${sortChecks} sorting checks, ${chartOptions} finite chart options; all checks passed`);

// Export the actual chosen year and verify the downloaded bytes and row set.
function parseCsv(csv) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = csv.charCodeAt(0) === 0xfeff ? 1 : 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && c === ';') { row.push(cell); cell = ''; }
    else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  assert.equal(quoted, false, 'CSV quoting is balanced');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
(async () => {
  const exportYear = '2026';
  const expectedIds = D.tournaments
    .filter(t => t.included !== false && String(t.date).startsWith(exportYear + '-'))
    .map(t => t.id).sort((a, b) => a - b);
  assert.ok(expectedIds.length > 0 && expectedIds.length < all.length, 'CSV fixture exercises a nonempty year subset');
  Object.assign(app.state, { year: exportYear, type: 'all', player: 'all' });
  app.go('tournaments');
  elements.get('exportCsv').onclick();
  assert.equal(exportsCreated.length, 1);
  assert.ok(anchorsCreated.at(-1).download.startsWith(`samurai-tournaments-${exportYear}-`));
  const bytes = new Uint8Array(await exportsCreated[0].arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191], 'CSV includes UTF-8 BOM for Excel');
  const csv = await exportsCreated[0].text();
  assert.ok(csv.includes('"ID";"Турнир";"Дата старта"'));
  const ids = [...csv.matchAll(/^"(\d+)";/gm)].map(m => Number(m[1]));
  assert.deepEqual(ids.sort((a,b) => a-b), expectedIds, 'CSV contains exactly the published games in the chosen year');
  assert.equal(ids.length, app.selected.length);
  const [headers, ...csvRows] = parseCsv(csv), performanceColumn = headers.indexOf('Перфоманс B');
  assert.ok(performanceColumn >= 0, 'CSV exports canonical performance explicitly');
  assert.ok(headers.includes('Взятие %'), 'Question-based context remains available alongside performance');
  let missing = 0;
  for (const row of csvRows) {
    assert.equal(row.length, headers.length, 'Exported rows match the column schema');
    const tournament = all.find(t => String(t.id) === row[0]);
    assert.ok(tournament);
    const performance = A.performance(tournament);
    if (performance === null) { assert.equal(row[performanceColumn], '', 'Missing performance remains empty in the export'); missing++; }
    else assert.equal(Number(row[performanceColumn]), performance, 'CSV does not substitute take rate or a rating object for performance');
  }
  assert.ok(missing > 0, 'CSV fixture includes games with missing performance');
  Object.assign(app.state, { year: exportYear, type: 'all', player: otherFilterId, personalPlayer: personalId });
  app.go('personal');
  const personalExpected = profileGames();
  assert.ok(personalExpected.length > 0 && personalExpected.length < expectedIds.length, 'Personal CSV fixture is a proper subset of team games');
  elements.get('exportCsv').onclick();
  assert.equal(exportsCreated.length, 2);
  const [personalHeaders, ...personalRows] = parseCsv(await exportsCreated[1].text());
  assert.deepEqual(personalRows.map(row => Number(row[0])).sort((a, b) => a - b), personalExpected.map(t => t.id).sort((a, b) => a - b), 'Personal CSV exports exactly the selected player’s games, independently of the global player filter');
  assert.ok(personalHeaders.includes('Перфоманс B'));
  for (const row of personalRows) assert.equal(row.length, personalHeaders.length);
  assert.equal(JSON.stringify(savedSnapshot), snapshotBefore);
  console.log(`csv: ${expectedIds.length} filtered tournament rows and ${personalRows.length} personal rows, canonical and missing performances, Unicode and download name verified`);
})().catch(error => { console.error(error); process.exitCode = 1; });
