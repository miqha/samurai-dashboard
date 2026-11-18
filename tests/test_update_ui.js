'use strict';
// The actual UI module with controlled network responses and time. These tests
// check update lifecycle behavior; visual layout is verified in the browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../update-ui.js'), 'utf8');
const START = Date.parse('2026-11-09T14:00:00Z');
const running = (step = 1, extra = {}) => ({ id: 'job-1', status: 'running', step, total: 7, label: 'Обновляю результаты', startedAt: new Date(START).toISOString(), ...extra });
const response = job => ({ body: { job } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ protocol = 'http:', responses = [response(null)], readyState = 'complete', site } = {}) {
  const elements = new Map(['updateDataButton', 'dataUpdatePanel', 'dataUpdateStatus', 'dataUpdateProgress', 'dataUpdateDetail'].map(id => [id, {
    id, hidden: id === 'dataUpdatePanel', disabled: false, _text: '', children: [], dataset: {}, attributes: {}, listeners: [],
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, callback) { this.listeners.push({ type, callback }); },
    setAttribute(key, value) { this.attributes[key] = value; }
  }]));
  const documentEvents = [];
  const document = { readyState, getElementById: id => elements.get(id), addEventListener: (type, fn) => documentEvents.push({ type, fn }), createElement(tag) { assert.equal(tag, 'a'); return { textContent: '' }; } };
  let now = START, nextTimer = 1, reloads = 0;
  const timers = new Map(), requests = [];
  const replacements = [];
  const location = { protocol, href: 'https://example.github.io/samurai/?theme=green#authors', hash: '#authors', reload() { reloads++; }, replace(url) { replacements.push(url); } };
  const window = { SAMURAI_SITE: site };
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ window, document, location, Date: TestDate, AbortController, URL,
    setTimeout(fn, delay = 0) { const id = nextTimer++; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    async fetch(url, options) {
      requests.push({ url, options });
      let reply = responses.shift();
      if (typeof reply === 'function') reply = await reply(options);
      if (reply && reply.promise) reply = await reply.promise;
      if (reply instanceof Error) throw reply;
      if (!reply) throw new Error('No response provided');
      return { ok: reply.ok !== false, status: reply.status || 200, json: async () => reply.body };
    }, console });
  vm.runInContext(source, context, { filename: 'update-ui.js' });
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const advance = async milliseconds => {
    const target = now + milliseconds;
    let runs = 0;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      assert.ok(++runs < 100, 'Timer loop');
      const [id, timer] = next; now = timer.due; timers.delete(id); timer.fn(); await flush();
    }
    now = target; await flush();
  };
  const $ = id => elements.get(id);
  const click = () => { for (const listener of $('updateDataButton').listeners) if (listener.type === 'click') listener.callback(); };
  return { $, click, window, location, requests, responses, flush, advance, timers, documentEvents, replacements, get reloads() { return reloads; } };
}

(async () => {
  // file:// retains a discoverable button and explains the one-time launcher;
  // neither startup nor clicking the button can trigger any network request.
  const file = harness({ protocol: 'file:' });
  file.click(); await file.flush();
  assert.equal(file.requests.length, 0);
  assert.equal(file.$('updateDataButton').disabled, false);
  assert.equal(file.$('dataUpdatePanel').hidden, false);
  assert.match(file.$('dataUpdateDetail').textContent, /start-dashboard\.command/);
  assert.match(file.$('dataUpdateDetail').textContent, /не может сам запускать/);
  assert.equal(file.$('dataUpdateProgress').hidden, true);

  // Initialization is safe both at the bottom of the document and from a
  // deferred script. Repeated init calls do not attach duplicate handlers.
  const loading = harness({ protocol: 'file:', readyState: 'loading' });
  assert.equal(loading.$('updateDataButton').listeners.length, 0);
  loading.documentEvents[0].fn(); loading.window.SamuraiUpdater.init();
  assert.equal(loading.$('updateDataButton').listeners.length, 1);

  // A double click while POST is in flight starts exactly one server request.
  // Real progress is shown; server failure retains existing charts and allows
  // a retry, without an automatic reload or an injected HTML error message.
  const pending = deferred();
  const failed = harness({ responses: [response(null), pending, response(running(4)), response(running(4, { status: 'error', error: '<script>bad()</script>' }))] });
  await failed.flush();
  failed.click(); failed.click(); await failed.flush();
  assert.equal(failed.requests.filter(r => r.options.method === 'POST').length, 1);
  assert.equal(failed.$('updateDataButton').disabled, true);
  assert.equal(failed.$('updateDataButton').attributes['aria-busy'], 'true');
  const post = failed.requests[1];
  assert.equal(post.url, '/api/update');
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  assert.equal(post.options.body, '{}');
  assert.equal(post.options.credentials, 'same-origin');
  pending.resolve(response(running(1))); await failed.flush();
  await failed.advance(1000);
  assert.equal(failed.$('dataUpdateProgress').value, 4);
  assert.match(failed.$('dataUpdateDetail').textContent, /4 из 7/);
  await failed.advance(1000);
  assert.equal(failed.$('updateDataButton').disabled, false);
  assert.equal(failed.$('dataUpdatePanel').dataset.state, 'error');
  assert.match(failed.$('dataUpdateDetail').textContent, /Предыдущие данные сохранены/);
  assert.doesNotMatch(failed.$('dataUpdateDetail').textContent, /script/);
  await failed.advance(10000); assert.equal(failed.reloads, 0);

  // An unsuccessful rollback must never promise that the previous snapshot
  // survived. Show the recovery location and keep the warning on screen.
  const rollbackFailure = harness({ responses: [response(running(7, { status: 'error', snapshotPreserved: false }))] });
  await rollbackFailure.flush();
  assert.equal(rollbackFailure.$('dataUpdatePanel').dataset.state, 'error');
  assert.doesNotMatch(rollbackFailure.$('dataUpdateDetail').textContent, /Предыдущие данные сохранены/);
  assert.match(rollbackFailure.$('dataUpdateDetail').textContent, /сохраните резервную копию из \.updates\/temp перед повтором/);
  assert.equal(rollbackFailure.$('updateDataButton').disabled, false);
  await rollbackFailure.advance(10000);
  assert.equal(rollbackFailure.reloads, 0);

  // Retrying after a failed job displays a real completion before reloading
  // the current route; location.reload naturally preserves the hash.
  failed.responses.push(response(running(7, { id: 'job-2', status: 'completed' })));
  failed.click(); await failed.flush();
  assert.equal(failed.$('dataUpdateProgress').value, 7);
  assert.equal(failed.$('dataUpdatePanel').dataset.state, 'completed');
  await failed.advance(1499); assert.equal(failed.reloads, 0);
  await failed.advance(1); assert.equal(failed.reloads, 1);
  assert.equal(failed.location.hash, '#authors');

  // An existing completed job on page load must not cause a reload loop. A
  // running job, however, is resumed and watched through to completion.
  const completed = harness({ responses: [response(running(7, { status: 'completed' }))] });
  await completed.flush(); await completed.advance(10000);
  assert.equal(completed.reloads, 0);
  assert.equal(completed.$('updateDataButton').disabled, false);
  const resumed = harness({ responses: [response(running(3)), response(running(7, { status: 'completed' }))] });
  await resumed.flush();
  assert.equal(resumed.$('updateDataButton').disabled, true);
  assert.equal(resumed.$('dataUpdateProgress').value, 3);
  await resumed.advance(1000); await resumed.advance(1500);
  assert.equal(resumed.reloads, 1);
  assert.equal(resumed.requests.filter(r => r.options.method === 'POST').length, 0);

  // Losing a poll keeps the local lock: the job may still be running on the
  // server. The next connection recovers progress and does not create a job.
  const reconnect = harness({ responses: [response(running(2)), new Error('offline'), response(running(5)), response(running(7, { status: 'completed' }))] });
  await reconnect.flush(); await reconnect.advance(1000);
  reconnect.click();
  assert.equal(reconnect.$('updateDataButton').disabled, true);
  assert.match(reconnect.$('dataUpdateDetail').textContent, /Связь/);
  await reconnect.advance(3000);
  assert.equal(reconnect.$('dataUpdateProgress').value, 5);
  await reconnect.advance(2500); assert.equal(reconnect.reloads, 1);
  assert.equal(reconnect.requests.filter(r => r.options.method === 'POST').length, 0);

  // A lost POST response is recovered by GET, while a completed older job
  // cannot be mistaken for a successful new update.
  const lostPost = harness({ responses: [response(null), new Error('response lost'), response(running(2)), response(running(7, { status: 'completed' }))] });
  await lostPost.flush(); lostPost.click(); await lostPost.flush();
  assert.equal(lostPost.$('dataUpdateProgress').value, 2);
  await lostPost.advance(2500); assert.equal(lostPost.reloads, 1);
  const staleJob = running(7, { status: 'completed', startedAt: '2026-11-01T12:00:00Z' });
  const lostRejected = harness({ responses: [response(staleJob), new Error('offline'), response(staleJob)] });
  await lostRejected.flush(); lostRejected.click(); await lostRejected.flush(); await lostRejected.advance(10000);
  assert.equal(lostRejected.reloads, 0);
  assert.equal(lostRejected.$('dataUpdatePanel').dataset.state, 'error');

  // The initial GET may finish after the user has started an update. Its
  // older response must not replace the new job or release the busy lock.
  const initial = deferred();
  const race = harness({ responses: [initial, response(running(2))] });
  race.click(); await race.flush(); initial.resolve(response(null)); await race.flush();
  assert.equal(race.$('dataUpdateProgress').value, 2);
  assert.equal(race.$('updateDataButton').disabled, true);

  // An ordinary static HTTP server does not support this feature. It gets a
  // useful launch instruction, with no fabricated success or bootstrap link.
  const staticServer = harness({ responses: [{ ok: false, status: 404 }, { ok: false, status: 404 }] });
  await staticServer.flush();
  assert.equal(staticServer.$('dataUpdatePanel').hidden, true);
  staticServer.click(); await staticServer.flush();
  assert.equal(staticServer.$('dataUpdatePanel').dataset.state, 'local');
  assert.match(staticServer.$('dataUpdateDetail').textContent, /start-dashboard\.command/);
  assert.equal(staticServer.$('updateDataButton').disabled, false);
  assert.equal(staticServer.reloads, 0);

  // Pages only checks published static files. A fresh browser check must not
  // pretend the upstream sources were fetched now, nor start a local Python job.
  const site = { mode: 'static', version: 'snapshot-a', dataUpdatedAt: '2026-11-08T12:00:00Z', cutoff: '2026-11-08', actionsUrl: 'https://github.com/team/samurai/actions/workflows/pages.yml' };
  const manifest = { ...site, publishedAt: '2026-11-08T12:10:00Z' };
  const hosted = harness({ protocol: 'https:', site, responses: [{ body: manifest }] });
  assert.equal(hosted.requests.length, 0, 'Hosted init must never request the local API');
  assert.match(hosted.$('updateDataButton').textContent, /Проверить обновления/);
  assert.match(hosted.$('dataUpdateDetail').textContent, /Источники обновлены: 08\.11\.2026/);
  const actionLink = hosted.$('dataUpdateDetail').children[0];
  assert.equal(actionLink.href, site.actionsUrl);
  assert.equal(actionLink.target, '_blank');
  assert.equal(actionLink.rel, 'noopener noreferrer');
  hosted.click(); await hosted.flush();
  assert.equal(hosted.requests.length, 1);
  assert.equal(hosted.requests[0].url, 'site-manifest.json', 'Manifest path must remain within a project Pages subpath');
  assert.equal(hosted.requests[0].options.cache, 'no-store');
  assert.equal(hosted.requests[0].options.method, undefined);
  assert.ok(hosted.requests[0].options.signal);
  assert.match(hosted.$('dataUpdateStatus').textContent, /последняя опубликованная версия/);
  assert.match(hosted.$('dataUpdateDetail').textContent, /Источники обновлены: 08\.11\.2026/);
  assert.match(hosted.$('dataUpdateDetail').textContent, /Публикация проверена: 09\.11\.2026/);
  assert.equal(hosted.$('dataUpdateProgress').hidden, true);
  assert.equal(hosted.$('updateDataButton').disabled, false);
  await hosted.advance(10000);
  assert.equal(hosted.reloads, 0);
  assert.equal(hosted.replacements.length, 0);

  // A changed valid version reloads this repository's URL and retains all
  // existing controls/routes, with a cache-busting version parameter.
  const nextManifest = { ...manifest, version: 'snapshot-b', dataUpdatedAt: '2026-11-09T13:00:00Z', publishedAt: '2026-11-09T13:10:00Z', cutoff: '2026-11-09' };
  hosted.responses.push({ body: nextManifest });
  hosted.click(); hosted.click(); await hosted.flush();
  assert.equal(hosted.requests.length, 2, 'Double click must only check once');
  assert.equal(hosted.$('updateDataButton').disabled, true);
  assert.match(hosted.$('dataUpdateStatus').textContent, /новая версия/);
  await hosted.advance(1500);
  assert.equal(hosted.replacements.length, 1);
  const replacement = new URL(hosted.replacements[0]);
  assert.equal(replacement.origin, 'https://example.github.io');
  assert.equal(replacement.pathname, '/samurai/');
  assert.equal(replacement.searchParams.get('theme'), 'green');
  assert.equal(replacement.searchParams.get('v'), 'snapshot-b');
  assert.equal(replacement.hash, '#authors');
  assert.equal(hosted.reloads, 0);

  // Partial, stale, unsafe or unreachable manifests retain the current page
  // and allow a new attempt. Manifest content cannot add navigation links.
  const rejected = harness({ protocol: 'https:', site, responses: [
    { body: { ...nextManifest, version: '../../other' } },
    { body: { ...nextManifest, dataUpdatedAt: '2026-11-07T00:00:00Z' } },
    { body: { ...nextManifest, cutoff: '2026-02-31' } },
    { body: { ...nextManifest, publishedAt: null } },
    { body: { ...nextManifest, mode: 'local' } },
    { body: { ...nextManifest, dataUpdatedAt: '2026-02-31T00:00:00Z' } },
    { ok: false, status: 404 },
    new Error('offline')
  ] });
  for (let i = 0; i < 8; i++) {
    rejected.click(); await rejected.flush();
    assert.equal(rejected.$('dataUpdatePanel').dataset.state, 'error');
    assert.match(rejected.$('dataUpdateDetail').textContent, /Открытая статистика сохранена/);
    assert.equal(rejected.$('updateDataButton').disabled, false);
  }
  await rejected.advance(10000);
  assert.equal(rejected.replacements.length, 0);
  assert.equal(rejected.reloads, 0);
  assert.ok(rejected.requests.every(item => item.url === 'site-manifest.json'));
  const unsafeLink = harness({ protocol: 'https:', site: { ...site, actionsUrl: site.actionsUrl + '?token=not-a-secret' }, responses: [{ body: manifest }] });
  assert.equal(unsafeLink.$('dataUpdateDetail').children.length, 0);
  await unsafeLink.window.SamuraiUpdater.checkStatus();
  assert.equal(unsafeLink.requests[0].url, 'site-manifest.json');

  const timedOut = harness({ protocol: 'https:', site, responses: [options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' }))))] });
  timedOut.click(); await timedOut.flush();
  assert.equal(timedOut.$('updateDataButton').disabled, true);
  await timedOut.advance(15000);
  assert.equal(timedOut.$('updateDataButton').disabled, false);
  assert.equal(timedOut.$('dataUpdatePanel').dataset.state, 'error');
  assert.equal(timedOut.replacements.length, 0);
  console.log('update UI: double-click lock, server progress, retry, completion reload, recovery, stale-job protection and file mode verified');
})().catch(error => { console.error(error); process.exitCode = 1; });
