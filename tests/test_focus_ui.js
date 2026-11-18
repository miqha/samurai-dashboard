'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Focus = require('../focus-core.js');
const UI = require('../focus-ui.js');
const project = path.join(__dirname, '..');
const history = JSON.parse(fs.readFileSync(path.join(project, 'data/dashboard.json')));
const played = JSON.parse(fs.readFileSync(path.join(project, 'data/played-questions.json')));
const bank = JSON.parse(fs.readFileSync(path.join(project, 'data/training.json')));
const options = { selected: history.tournaments, playedData: played, trainingData: bank };
const stats = Focus.build(options);
const viewState = { dimension: 'formats', category: '', band: '', showSmall: false, allMisses: false, trainMessage: '' };
const markup = UI.markup(stats, viewState);
assert.doesNotMatch(markup, /NaN|Infinity|undefined/);
assert.ok(markup.includes(`<b>${stats.opportunities.summary.matchedMisses}</b> доступных потерь с метаданными`), 'Metadata-only count is not inflated to all accessible misses');
assert.match(markup, /средний B/);
assert.match(markup, /Даты — начало окон турниров/);
assert.match(markup, /одинаковый автор не означает одинаковую тему или сложность/);
assert.match(markup, /не измеряет усталость/);
assert.match(markup, /data-sort-value=/);
assert.doesNotMatch(markup, /коэффициент|Elastic/);
const base = () => ({ tooltip: {}, xAxis: { axisLabel: {} }, yAxis: {} });
const chart = UI.atlasOptions(stats.atlas, { base, colors: { red: '#c00' } });
assert.equal(chart.xAxis.min, 0); assert.equal(chart.xAxis.max, 100);
assert.equal(chart.yAxis.data[1], 'Поле 20–<40%');
for (const series of chart.series) for (const point of series.data) for (const x of point) assert.ok(Number.isFinite(x));
assert.match(chart.tooltip.formatter({ data: chart.series[1].data[0] }), /Это доли взятия, не перфоманс/);
const connector = chart.series[0].renderItem({}, { value: i => [20, 1, 40][i], coord: value => value.map(x => x * 2) });
assert.deepEqual(connector.shape, { x1: 40, y1: 2, x2: 80, y2: 2 });
const escaped = UI.sourceTable([{ tournamentName: '<img onerror="X">', tournamentId: 1, number: 2, fieldRate: .7, fieldCount: 30,
  authors: [{ name: '<script>X</script>' }], sourceUrl: 'javascript:alert(1)' }]);
assert.match(escaped, /&lt;img/); assert.doesNotMatch(escaped, /<script|javascript:/);
assert.equal(UI.opportunityRows({ formats: [{ label: 'Тест', eligible: false }] }, viewState).length, 0);
assert.equal(UI.opportunityRows({ formats: [{ label: 'Тест', eligible: false }] }, { ...viewState, showSmall: true }).length, 1);
assert.doesNotMatch(UI.markup(Focus.build({ selected: [] }), viewState), /NaN|Infinity|undefined/);

// Exercise the actual rendered category chips, safe drill-down and training CTA.
class Mount {
  set innerHTML(value) {
    this.html = value; this.nodes = [];
    for (const match of value.matchAll(/<(?:button|input|div)\b([^>]*)>/g)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(x => [x[1], x[2] || '']));
      const node = { attrs, disabled: Object.hasOwn(attrs, 'disabled'), textContent: '', dataset: {} };
      for (const [key, val] of Object.entries(attrs)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase())] = val;
      this.nodes.push(node);
    }
  }
  querySelector(selector) { return this.nodes.find(n => n.attrs.id === selector.slice(1)) || null; }
  querySelectorAll(selector) { const attr = selector.slice(1, -1); return this.nodes.filter(n => Object.hasOwn(n.attrs, attr)); }
}
const mount = new Mount(), requests = [], chartCalls = [], tournamentCalls = [];
const runtime = { SamuraiFocusCore: Focus, document: { querySelector: selector => selector === '#focusRoot' ? mount : null } }; runtime.window = runtime;
vm.createContext(runtime);
vm.runInContext(fs.readFileSync(path.join(project, 'focus-ui.js'), 'utf8'), runtime, { filename: 'focus-ui.js' });
runtime.SamuraiFocusView.render({ ...options, base, colors: {}, chart: (...args) => chartCalls.push(args), onTrain: value => { requests.push(value); return false; }, openTournament: id => tournamentCalls.push(id) });
assert.equal(chartCalls[0][0], 'focusAtlasChart');
let train = mount.querySelector('#focusTrain'); assert.ok(train && !train.disabled);
train.onclick(); assert.equal(requests.length, 1);
const category = UI.opportunityRows(stats.opportunities, { ...viewState, dimension: 'authors' })[0];
assert.deepEqual(Array.from(requests[0].questionIds), category.trainingQuestionIds, 'Training gets exact new-question whitelist');
assert.match(mount.querySelector('#focusTrainMessage').textContent, /незавершённая тренировка/);
mount.querySelectorAll('[data-focus-dimension]').find(n => n.dataset.focusDimension === 'authors').onclick();
assert.ok(mount.querySelector('#focusShowSmall'));
mount.querySelector('#focusShowSmall').onchange({ target: { checked: true } });
assert.ok(mount.querySelectorAll('[data-focus-category]').length >= stats.opportunities.authors.filter(r => r.eligible).length);
mount.querySelectorAll('[data-focus-band]').find(n => n.dataset.focusBand === 'accessible').onclick();
assert.match(mount.html, /КОМАНДА · ПОЛЕ ≥60%/);
mount.querySelectorAll('[data-focus-tournament]')[0].onclick(); assert.equal(tournamentCalls.length, 1);
console.log('Focus UI tests passed');
