'use strict';
// Headless integration checks for planner state, clocks, fetches and chart data.
// The DOM shim records exactly what the module writes; it is not a layout test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../recommendations-core.js');
const Stats = require('../analytics.js');
const source = fs.readFileSync(path.join(__dirname, '../recommendations-ui.js'), 'utf8');
const START = Date.parse('2026-11-09T12:00:00Z');
const iso = offset => new Date(START + offset).toISOString();

function fixtures() {
  const history = Array.from({ length: 18 }, (_, i) => {
    const dl = 1 + i * .35, takes = Math.round(36 / (1 + Math.exp((dl - 4.1) / 1.3)));
    return { id: i + 1, name: i === 17 ? 'Крафтик №7 (синхрон)' : 'История ' + i,
      date: `2026-06-${String(i + 1).padStart(2, '0')}T12:00:00Z`, included: true,
      totalQuestions: 36, trueDL: dl, difficultyForecast: dl, score: takes,
      resultsAvailable: true, mask: '1'.repeat(takes) + '0'.repeat(36 - takes), editors: [] };
  });
  const base = { name: 'Открытый', type: { id: 3, name: 'Синхрон' }, dateStart: iso(-3600000), dateEnd: iso(600000), dateRequestsAllowedTo: iso(600000), totalQuestions: 36, trueDL: 4, editors: [] };
  const tournaments = [
    { ...base, id: 100, name: 'Закроется на границе', dateEnd: iso(120000) },
    { ...base, id: 101, name: 'Откроется на границе', dateStart: iso(120000) },
    { ...base, id: 102, name: 'Без сложности', trueDL: null },
    { ...base, id: 103, name: 'Только очный', type: { id: 2, name: 'Обычный' } },
    { ...base, id: 104, name: 'Свежая заявка' },
    { ...base, id: 105, name: 'Заявки закончились', dateRequestsAllowedTo: iso(-1) },
    { ...base, id: 106, name: 'Официальное пересечение' },
    { ...base, id: 107, name: 'Крафтик №7 (асинхрон)' }
  ];
  return { D: { fetchedAt: '2026-11-07T13:00:00Z', tournaments: history },
    H: { tournaments: history.map(row => ({ id: row.id, trueDL: row.trueDL, gotQuestionsTags: [] })) },
    I: { complete: true, tournaments: [{ id: 18, relatedIds: [106] }] },
    C: { fetchedAt: '2026-11-07T13:00:00Z', complete: true, teamTournamentIds: [104], teamHistoryCheckedAt: iso(0), tournaments } };
}

class Element {
  constructor(id) { this.id = id; this.innerHTML = ''; this._text = ''; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {}; this.attributes = {}; this.classes = new Set(); this.classList = { toggle: (name, force) => { if (force) this.classes.add(name); else this.classes.delete(name); } }; }
  set textContent(value) { this._text = String(value); this.innerHTML = ''; }
  get textContent() { return this._text || this.innerHTML.replace(/<[^>]+>/g, ''); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback({ target: this, ...event }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  closest(selector) { return selector === '[data-play-mode]' && this.dataset.playMode ? this : null; }
}

function harness({ protocol = 'file:', responses = [], extraCount = 0, site, savedCatalog } = {}) {
  const { D, H, I, C } = fixtures();
  C.tournaments.push(...Array.from({ length: extraCount }, (_, i) => ({ ...C.tournaments[0], id: 200 + i, name: 'Дополнительный ' + i })));
  const elements = new Map(), buttons = ['recommended', 'open', 'upcoming', 'planned'].map(mode => { const button = new Element(mode); button.dataset.playMode = mode; return button; });
  const $ = id => { const key = id.replace(/^#/, ''); if (!elements.has(key)) elements.set(key, new Element(key)); return elements.get(key); };
  const anchorsCreated = [], exportsCreated = [];
  const document = { hidden: false, querySelector: $, querySelectorAll: selector => selector === '#plannerModes button' ? buttons : [], listeners: new Map(), createElement(tag) { assert.equal(tag, 'a'); const anchor = { href: '', download: '', clicked: false, click() { this.clicked = true; } }; anchorsCreated.push(anchor); return anchor; }, addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); } };
  let now = START, nextTimer = 1;
  const timers = new Map(), requests = [], chartOptions = [], charts = [];
  const setTimer = (fn, delay = 0, interval = false) => { const id = nextTimer++; timers.set(id, { fn, due: now + Number(delay), delay: Number(delay), interval }); return id; };
  const clearTimer = id => timers.delete(id);
  class FrozenDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class TestURL extends URL { static createObjectURL(blob) { exportsCreated.push(blob); return 'blob:planner-test'; } static revokeObjectURL() {} }
  const store = new Map();
  if (savedCatalog) store.set('samurai-catalog-v2', JSON.stringify(savedCatalog));
  const localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)) };
  const echarts = { init() { const chart = { disposed: false, setOption: option => chartOptions.push(option), on() {}, resize() {}, dispose() { this.disposed = true; } }; charts.push(chart); return chart; } };
  const fetch = async (url, options) => { requests.push({ url, options }); let response = responses.shift(); if (typeof response === 'function') response = await response(options); if (response instanceof Error) throw response; if (!response) throw new Error('Network not available in test'); return { ok: response.ok !== false, status: response.status || 200, json: async () => response.body }; };
  const window = { SamuraiRecommendations: R, SamuraiStats: Stats, SAMURAI_DATA: D, SAMURAI_DIFFICULTY: H, SAMURAI_INTERSECTIONS: I, SAMURAI_CATALOG: C, SAMURAI_SITE: site,
    SAMURAI_APP: { state: { view: 'play' }, selected: D.tournaments, openTournament() {} }, echarts, addEventListener() {} };
  const context = vm.createContext({ window, document, location: { protocol }, localStorage, echarts, Date: FrozenDate, URL: TestURL, Blob, AbortController, fetch,
    setTimeout: (fn, delay) => setTimer(fn, delay), clearTimeout: clearTimer,
    setInterval: (fn, delay) => setTimer(fn, delay, true), clearInterval: clearTimer, console });
  vm.runInContext(source, context, { filename: 'recommendations-ui.js' });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const advance = async milliseconds => {
    const target = now + milliseconds; let runs = 0;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      assert.ok(++runs < 1000, 'Unexpected timer loop');
      const [id, timer] = next; now = timer.due; timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, due: now + timer.delay });
      timer.fn(); await flush();
    }
    now = target; await flush();
  };
  const mode = value => $('plannerModes').emit('click', { target: buttons.find(button => button.dataset.playMode === value) });
  const field = (id, value, type = 'change') => { $(id).value = value; $(id).emit(type); };
  return { window, document, $, mode, field, requests, responses, chartOptions, charts, timers, C, D, H, I, flush, advance, anchorsCreated, exportsCreated, store, planner: window.SamuraiPlanner };
}

function noNaN(harness) {
  for (const id of ['plannerCards', 'plannerKpis', 'plannerModelNote', 'plannerResultCount']) assert.doesNotMatch(harness.$(id).innerHTML + harness.$(id).textContent, /NaN|Infinity|undefined/);
  for (const option of harness.chartOptions) for (const series of option.series || []) for (const point of series.data || []) for (const value of point) if (typeof value === 'number') assert.ok(Number.isFinite(value), 'Chart contains non-finite value');
}

(async () => {
  const presetBundle = { tournaments: [{ tournamentId: 104, authors: [{ id: 'a', name: 'Author' }] }] };
  let deliveredPreset = null;
  // A separate HTTP harness keeps file-mode requests fully offline.
  const livePreset = harness({ protocol: 'http:', responses: [{ body: { ...fixtures().C, _registrationTraining: presetBundle } }] });
  livePreset.window.SamuraiTrainingView = { setRegistrationData(value) { deliveredPreset = value; } };
  await livePreset.flush();
  assert.equal(deliveredPreset, presetBundle, 'Calendar responses deliver new author presets to training without reload');
  // A standalone HTML never attempts fetch, labels its snapshot honestly, and
  // still moves tournaments across playing-window boundaries using the clock.
  const offline = harness();
  assert.equal(offline.requests.length, 0);
  assert.match(offline.$('plannerFreshness').innerHTML, /Автономный снимок/);
  assert.match(offline.$('plannerConnection').innerHTML, /новые турниры здесь не загружаются/);
  assert.match(offline.$('plannerConnection').innerHTML, /start-dashboard.command/);
  assert.equal(offline.planner.lastRank.active.some(row => row.id === 100), true);
  assert.equal(offline.planner.lastRank.upcoming.some(row => row.id === 101), true);
  assert.equal(offline.planner.lastRank.active.some(row => row.id === 103 || row.id === 104 || row.id === 106), false);
  offline.mode('planned');
  assert.match(offline.$('plannerCards').innerHTML, /Свежая заявка/);
  offline.mode('open');
  assert.match(offline.$('plannerCards').innerHTML, /Без сложности/);
  assert.match(offline.$('plannerCards').innerHTML, /Возможен повтор/);
  assert.match(offline.$('plannerCards').innerHTML, /Заявки закрыты/);
  assert.doesNotMatch(offline.$('plannerCards').innerHTML, /Только очный/);
  await offline.advance(120100);
  assert.equal(offline.planner.lastRank.active.some(row => row.id === 100), false);
  assert.equal(offline.planner.lastRank.active.some(row => row.id === 101), true);
  assert.equal(offline.planner.lastRank.upcoming.some(row => row.id === 101), false);
  assert.equal(offline.requests.length, 0);
  offline.field('plannerTarget', 'comfort');
  offline.field('plannerFormat', '8');
  assert.match(offline.$('plannerCards').innerHTML, /не нашлось/);
  offline.field('plannerFormat', 'all');
  offline.field('plannerLength', '24');
  assert.match(offline.$('plannerCards').innerHTML, /не нашлось/);
  offline.field('plannerLength', 'all');
  offline.field('plannerSort', 'end');
  offline.field('plannerSearch', 'несуществующий поиск', 'input');
  assert.match(offline.$('plannerCards').innerHTML, /не нашлось/);
  offline.field('plannerSearch', '', 'input');
  offline.planner.renderHistory(offline.D.tournaments);
  noNaN(offline);
  await offline.planner.refresh(true);
  assert.equal(offline.requests.length, 0);

  // CSV exports the complete filtered pool, even when the card view only shows
  // its first twelve rows. It preserves the selected planner mode and filters.
  const csvView = harness({ extraCount: 20 });
  csvView.mode('open');
  assert.equal((csvView.$('plannerCards').innerHTML.match(/<article /g) || []).length, 12);
  csvView.planner.exportCsv();
  const csvIds = async blob => [...(await blob.text()).matchAll(/^"(\d+)";/gm)].map(match => Number(match[1])).sort((a, b) => a - b);
  const bytes = new Uint8Array(await csvView.exportsCreated[0].arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
  assert.deepEqual(await csvIds(csvView.exportsCreated[0]), csvView.planner.lastRank.active.map(row => row.id).sort((a, b) => a - b));
  assert.ok((await csvIds(csvView.exportsCreated[0])).length > 12);
  assert.ok(csvView.anchorsCreated[0].clicked);
  assert.match(csvView.anchorsCreated[0].download, /^samurai-play-open-2026-11-09\.csv$/);
  csvView.mode('upcoming'); csvView.planner.exportCsv();
  assert.deepEqual(await csvIds(csvView.exportsCreated[1]), [101]);
  csvView.mode('open'); csvView.field('plannerSearch', 'Дополнительный 19', 'input'); csvView.planner.exportCsv();
  assert.deepEqual(await csvIds(csvView.exportsCreated[2]), [219]);

  // A successful connected refresh must use the live server's metadata, not
  // infer freshness merely because a fetch returned HTTP 200.
  const fresh = { ...fixtures().C, fetchedAt: iso(0), _live: { status: 'fresh', error: '' } };
  fresh.tournaments.push({ ...fresh.tournaments[0], id: 999, name: 'Свежий турнир CSV' });
  const online = harness({ protocol: 'http:', responses: [{ body: fresh }] });
  await online.flush();
  assert.equal(online.requests[0].url, '/api/catalog?refresh=1');
  assert.match(online.$('plannerFreshness').innerHTML, /Каталог проверен/);
  assert.equal(online.$('plannerRefresh').disabled, false);
  assert.equal(online.$('plannerConnection').hidden, true);
  assert.equal(online.planner.catalog.fetchedAt, fresh.fetchedAt);
  assert.ok(online.requests[0].options.signal);
  assert.equal(online.requests[0].options.credentials, 'omit');
  online.field('plannerSearch', 'Свежий турнир CSV', 'input'); online.planner.exportCsv();
  assert.deepEqual(await csvIds(online.exportsCreated[0]), [999]);
  assert.match(await online.exportsCreated[0].text(), /2026-11-09T12:00:00\.000Z/);
  online.field('plannerSearch', '', 'input');
  noNaN(online);

  // A failed check retains the usable catalog while removing any fresh label.
  online.responses.push(new Error('offline'));
  await online.planner.refresh(true);
  assert.doesNotMatch(online.$('plannerFreshness').innerHTML, /Каталог проверен/);
  assert.match(online.$('plannerFreshness').innerHTML, /Сохранённый каталог/);
  assert.match(online.$('plannerConnection').textContent, /Не удалось проверить источник/);
  assert.equal(online.planner.catalog.fetchedAt, fresh.fetchedAt);
  assert.equal(online.$('plannerRefresh').disabled, false);

  // Incomplete payloads cannot replace the last complete snapshot or claim a
  // verified update, even if the server itself returned a successful status.
  const partial = harness({ protocol: 'http:', responses: [{ body: { complete: false, fetchedAt: iso(0), tournaments: [] } }] });
  await partial.flush();
  assert.equal(partial.planner.catalog.tournaments.length, fixtures().C.tournaments.length);
  assert.doesNotMatch(partial.$('plannerFreshness').innerHTML, /Каталог проверен/);
  assert.match(partial.$('plannerConnection').textContent, /сохранённый каталог/);
  noNaN(partial);

  // A background server refresh is pending, not fresh. Polling then promotes
  // only a complete payload explicitly carrying a fresh result.
  const pending = harness({ protocol: 'http:', responses: [
    { body: { ...fixtures().C, _live: { status: 'refreshing', error: '' } } },
    { body: fresh }
  ] });
  await pending.flush();
  assert.match(pending.$('plannerFreshness').innerHTML, /Обновляю/);
  assert.doesNotMatch(pending.$('plannerFreshness').innerHTML, /Каталог проверен/);
  await pending.advance(2500);
  assert.equal(pending.requests.length, 2);
  assert.equal(pending.requests[1].url, '/api/catalog');
  assert.match(pending.$('plannerFreshness').innerHTML, /Каталог проверен/);
  noNaN(pending);

  // Pages fetches only a relative published artifact, even for an explicit
  // refresh. Publication checks never masquerade as fresh upstream requests.
  const published = { ...fixtures().C, _live: { status: 'fresh', error: '' } };
  published.tournaments.push({ ...published.tournaments[0], id: 1500, name: 'Опубликованный турнир' });
  const pages = harness({ protocol: 'https:', site: { mode: 'static' }, responses: [{ body: published }] });
  await pages.flush();
  assert.equal(pages.requests[0].url, 'data/catalog.json');
  assert.equal(pages.requests[0].options.cache, 'no-store');
  assert.equal(pages.requests[0].options.credentials, 'omit');
  assert.ok(pages.requests[0].options.signal);
  assert.match(pages.$('plannerFreshness').innerHTML, /Опубликованный каталог/);
  assert.doesNotMatch(pages.$('plannerFreshness').innerHTML, /Каталог проверен/);
  assert.match(pages.$('plannerFreshness').innerHTML, /Источник обновлён: 07\.11\.2026/);
  assert.match(pages.$('plannerFreshness').innerHTML, /Публикация проверена: 09\.11\.2026/);
  assert.match(pages.$('plannerConnection').textContent, /кнопка проверяет опубликованный файл/);
  assert.equal(pages.$('plannerRefresh').textContent, '↻ Проверить каталог');
  assert.equal(pages.store.has('samurai-catalog-v2'), false, 'Hosted catalog must not populate the local server cache');
  pages.field('plannerSearch', 'Опубликованный турнир', 'input');
  assert.match(pages.$('plannerCards').innerHTML, /Опубликованный турнир/);
  pages.field('plannerSearch', '', 'input');
  pages.responses.push({ body: published });
  await pages.planner.refresh(true);
  assert.equal(pages.requests[1].url, 'data/catalog.json', 'Force refresh must not call a server action');

  // Unavailable, partial, undated and older published catalogs preserve the
  // last complete snapshot, its source date, and the clock-driven windows.
  pages.responses.push(new Error('offline'), { body: { ...published, complete: false } }, { body: { ...published, fetchedAt: 'invalid' } }, { body: { ...published, fetchedAt: '2026-11-01T00:00:00Z' } });
  for (let i = 0; i < 4; i++) {
    await pages.planner.refresh(true);
    assert.equal(pages.planner.catalog, published);
    assert.match(pages.$('plannerConnection').textContent, /Не удалось проверить опубликованный каталог/);
    assert.match(pages.$('plannerFreshness').innerHTML, /Источник обновлён: 07\.11\.2026/);
    assert.equal(pages.$('plannerRefresh').disabled, false);
  }
  await pages.advance(120100);
  assert.equal(pages.planner.lastRank.active.some(row => row.id === 100), false);
  assert.equal(pages.planner.lastRank.active.some(row => row.id === 101), true);
  assert.ok(pages.requests.every(request => request.url === 'data/catalog.json'));
  noNaN(pages);

  // A catalog left in browser storage by a different deployment cannot replace
  // this build's embedded seed when the publication cannot be reached.
  const foreignCache = { ...fixtures().C, fetchedAt: iso(10000), tournaments: [] };
  const pagesOffline = harness({ protocol: 'https:', site: { mode: 'static' }, savedCatalog: foreignCache, responses: [new Error('offline')] });
  await pagesOffline.flush();
  assert.equal(pagesOffline.planner.catalog, pagesOffline.C);
  assert.ok(pagesOffline.planner.catalog.tournaments.length > 0);

  const pagesTimeout = harness({ protocol: 'https:', site: { mode: 'static' }, responses: [options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' }))))] });
  assert.equal(pagesTimeout.$('plannerRefresh').disabled, true);
  await pagesTimeout.advance(45000);
  assert.equal(pagesTimeout.planner.catalog, pagesTimeout.C);
  assert.equal(pagesTimeout.$('plannerRefresh').disabled, false);
  assert.match(pagesTimeout.$('plannerConnection').textContent, /45 секунд/);

  console.log('Planner UI integration tests passed: offline clock boundaries, live refresh, partial/failing/pending source states, ownership/overlaps, filters, finite chart data, complete filtered CSV downloads.');
})().catch(error => { console.error(error); process.exitCode = 1; });
