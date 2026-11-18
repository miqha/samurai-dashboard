/* Local updates run on the dashboard server; Pages checks published snapshots. */
(function () {
  'use strict';

  const POLL_MS = 1000;
  const RETRY_MS = 3000;
  const REQUEST_TIMEOUT_MS = 15000;
  const RELOAD_MS = 1500;
  const LOCAL_HELP = 'Для обновления откройте start-dashboard.cmd на Windows или start-dashboard.command на macOS в папке дашборда. В открывшейся странице кнопка запустит обновление. Браузер не может сам запускать скрипты из HTML-файла.';
  const site = window.SAMURAI_SITE;
  const hosted = site?.mode === 'static';
  const state = { initialized: false, busy: false, job: null, generation: 0, timer: null, reloadTimer: null, watchCompletion: false };
  let button, panel, status, progress, detail;

  function connected() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  const validVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  const validTimestamp = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && validCutoff(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  const validCutoff = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const when = value => validTimestamp(value) ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' МСК' : 'дата не указана';

  function actionsUrl() {
    try {
      const url = new URL(site.actionsUrl);
      return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/[^/]+\/[^/]+\/actions\/workflows\/pages\.yml$/.test(url.pathname) ? url.href : null;
    } catch (_) { return null; }
  }

  function showPublished(kind, title, description) {
    show(kind, title, description);
    const url = actionsUrl();
    if (url) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = ' Открыть GitHub Actions ↗';
      detail.appendChild(anchor);
    }
  }

  function publishedDescription() {
    return `Источники обновлены: ${when(site.dataUpdatedAt)}. На GitHub Pages данные собираются по расписанию; владелец может запустить сборку вручную в GitHub Actions.`;
  }

  function validateManifest(next) {
    if (!next || next.mode !== 'static' || !validVersion(next.version) || !validTimestamp(next.dataUpdatedAt) || !validTimestamp(next.publishedAt) || !validCutoff(next.cutoff)) throw new Error('Invalid published snapshot');
    if (!validVersion(site.version) || (validTimestamp(site.dataUpdatedAt) && Date.parse(next.dataUpdatedAt) < Date.parse(site.dataUpdatedAt))) throw new Error('Older published snapshot');
    return next;
  }

  async function checkPublished() {
    if (!state.initialized || state.busy) return;
    setBusy(true);
    button.textContent = '↻ Проверяю публикацию…';
    showPublished('checking', 'Проверяю опубликованную версию', 'Проверяю, появилась ли новая сборка дашборда. Сборку данных выполняет GitHub Actions.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch('site-manifest.json', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Published manifest unavailable');
      const next = validateManifest(await response.json());
      if (next.version !== site.version) {
        const url = new URL(location.href);
        url.searchParams.set('v', next.version);
        showPublished('published', 'Опубликована новая версия', `Источники обновлены: ${when(next.dataUpdatedAt)}. Открываю новую статистику…`);
        button.textContent = '✓ Открываю новую версию';
        state.reloadTimer = setTimeout(() => location.replace(url.href), RELOAD_MS);
      } else {
        setBusy(false);
        button.textContent = '↻ Проверить обновления';
        showPublished('published', 'У вас последняя опубликованная версия', `${publishedDescription()} Публикация проверена: ${when(new Date().toISOString())}.`);
      }
    } catch (_) {
      setBusy(false);
      button.textContent = '↻ Повторить проверку';
      showPublished('error', 'Не удалось проверить публикацию', `Открытая статистика сохранена. ${publishedDescription()} Попробуйте проверить публикацию ещё раз.`);
    } finally { clearTimeout(timeout); }
  }

  function show(kind, title, description) {
    panel.hidden = false;
    panel.dataset.state = kind;
    status.textContent = title;
    detail.textContent = description;
    progress.hidden = kind !== 'running' && kind !== 'completed';
    button.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  function stopPolling() {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  }

  function setBusy(value) {
    state.busy = value;
    button.disabled = value;
    button.setAttribute('aria-busy', value ? 'true' : 'false');
  }

  function schedulePoll(delay = POLL_MS) {
    stopPolling();
    state.timer = setTimeout(() => { state.timer = null; checkStatus(true); }, delay);
  }

  async function request(method) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const options = { method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal };
      if (method === 'POST') {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = '{}';
      }
      const response = await fetch('/api/update', options);
      if (!response.ok) {
        const error = new Error('Update endpoint unavailable');
        error.unavailable = [404, 405, 501].includes(response.status);
        error.httpStatus = response.status;
        throw error;
      }
      const payload = await response.json();
      if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'job')) throw new Error('Invalid update status');
      return payload.job;
    } finally {
      clearTimeout(timeout);
    }
  }

  function applyJob(job, followCompletion) {
    if (!job) {
      if (followCompletion && state.busy) throw new Error('Running update status was lost');
      return;
    }
    if (!['running', 'completed', 'error', 'failed'].includes(job.status)) throw new Error('Invalid update status');
    state.job = job;
    const total = Number.isFinite(Number(job.total)) && Number(job.total) > 0 ? Number(job.total) : 10;
    const step = Number.isFinite(Number(job.step)) ? Math.max(0, Math.min(Number(job.step), total)) : 0;
    progress.max = total;
    progress.value = step;

    if (job.status === 'running') {
      state.watchCompletion = true;
      setBusy(true);
      button.textContent = '↻ Обновляю данные…';
      // Render source labels as text; never insert server messages as markup.
      const label = typeof job.label === 'string' ? job.label.slice(0, 180) : 'Проверяю источники';
      show('running', 'Обновление данных', `${label} · ${step} из ${total}. Источники обновляются параллельно. Можно продолжать смотреть статистику.`);
      schedulePoll();
      return;
    }

    stopPolling();
    if (job.status === 'completed') {
      progress.value = total;
      if (followCompletion && state.watchCompletion) {
        setBusy(true);
        button.textContent = '✓ Данные обновлены';
        show('completed', 'Данные обновлены', `${Number.isFinite(job.elapsedSeconds) ? 'Обновление заняло ' + Math.floor(job.elapsedSeconds / 60) + ' мин ' + Math.round(job.elapsedSeconds % 60) + ' с. ' : ''}Открываю свежую статистику…`);
        if (state.reloadTimer === null) state.reloadTimer = setTimeout(() => location.reload(), RELOAD_MS);
      } else {
        // The completed job remains on the server after reload. Do not reload
        // again, or a successful update would trap the dashboard in a loop.
        setBusy(false);
      }
      return;
    }

    state.watchCompletion = false;
    setBusy(false);
    button.textContent = '↻ Повторить обновление';
    const errorDetail = job.snapshotPreserved === false
      ? 'Не удалось полностью сохранить или восстановить файлы. Закройте локальный дашборд и сохраните резервную копию из .updates/temp перед повтором.'
      : 'Не удалось получить или проверить новые данные. Предыдущие данные сохранены — можно повторить обновление.';
    show('error', 'Обновление не завершилось', errorDetail);
  }

  async function checkStatus(followCompletion = false) {
    if (hosted) return checkPublished();
    if (!connected()) return;
    const generation = state.generation;
    try {
      const job = await request('GET');
      if (generation !== state.generation) return;
      applyJob(job, followCompletion);
    } catch (error) {
      if (generation !== state.generation) return;
      if (state.busy) {
        // A lost response does not mean the server stopped. Keep the update
        // locked locally and reconnect to the same server job.
        show('running', 'Проверяю ход обновления', 'Связь с локальным сервером прервалась. Попробую снова через несколько секунд. Предыдущая статистика доступна.');
        schedulePoll(RETRY_MS);
      }
      // A static HTTP server may not implement the API. Keep the page quiet
      // until the user asks to refresh, then explain how to launch it.
    }
  }

  async function start() {
    if (!state.initialized || state.busy) return;
    if (hosted) return checkPublished();
    if (!connected()) {
      show('local', 'Откройте локальный режим обновления', LOCAL_HELP);
      return;
    }
    state.generation += 1;
    const requestedAt = Date.now();
    const previousJobId = state.job && state.job.id;
    state.watchCompletion = true;
    setBusy(true);
    stopPolling();
    button.textContent = '↻ Запускаю обновление…';
    progress.max = 10;
    progress.value = 0;
    show('running', 'Запускаю обновление данных', 'Обновлю историю и составы, календарь, GotQuestions, годовую базу тренировок, авторов заявок и все разборы команды. Страница останется доступна.');
    try {
      const job = await request('POST');
      if (!job) throw new Error('Update did not return a job');
      applyJob(job, true);
    } catch (error) {
      if (error.unavailable) {
        state.watchCompletion = false;
        setBusy(false);
        button.textContent = '↻ Обновить данные';
        show('local', 'Нужен локальный сервер дашборда', LOCAL_HELP);
      } else if (error.httpStatus) {
        state.watchCompletion = false;
        setBusy(false);
        button.textContent = '↻ Повторить обновление';
        show('error', 'Не удалось запустить обновление', 'Локальный сервер отклонил запрос. Предыдущие данные сохранены — можно повторить обновление.');
      } else {
        // POST can succeed on the server even when its response is lost.
        // First recover the current job instead of starting a duplicate run.
        show('running', 'Проверяю запуск обновления', 'Не получен ответ сервера. Проверяю, началось ли обновление.');
        try {
          const job = await request('GET');
          if (!job) throw new Error('No running job');
          if (job.status !== 'running' && (job.id === previousJobId || !Number.isFinite(Date.parse(job.startedAt)) || Date.parse(job.startedAt) < requestedAt - 1000)) throw new Error('No new update job');
          applyJob(job, true);
        } catch (_) {
          state.watchCompletion = false;
          setBusy(false);
          button.textContent = '↻ Повторить обновление';
          show('error', 'Сервер обновления недоступен', 'Предыдущие данные сохранены. Проверьте, что локальный запуск дашборда открыт, затем повторите обновление.');
        }
      }
    }
  }

  function init() {
    if (state.initialized) return;
    button = document.getElementById('updateDataButton');
    panel = document.getElementById('dataUpdatePanel');
    status = document.getElementById('dataUpdateStatus');
    progress = document.getElementById('dataUpdateProgress');
    detail = document.getElementById('dataUpdateDetail');
    if (!button || !panel || !status || !progress || !detail) return;
    state.initialized = true;
    button.addEventListener('click', start);
    button.setAttribute('aria-controls', 'dataUpdatePanel');
    button.setAttribute('aria-busy', 'false');
    if (hosted) {
      button.textContent = '↻ Проверить обновления';
      showPublished('published', 'Данные опубликованы через GitHub Actions', publishedDescription());
    } else if (connected()) checkStatus();
  }

  window.SamuraiUpdater = { init, start, checkStatus, get busy() { return state.busy; }, get job() { return state.job; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
