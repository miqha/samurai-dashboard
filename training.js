/* A local training room. Answers and history stay in this browser. */
(function (root) {
  'use strict';
  const C = root.SamuraiTrainingCore;
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const num = (value, digits = 0) => finite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits }) : '—';
  const pct = value => finite(value) ? `${num(value * 100)}%` : '—';
  const noun = (count, one, few, many) => { const n = Math.abs(count) % 100, last = n % 10; return n >= 11 && n <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many; };
  const counted = (count, one, few, many) => `${num(count)} ${noun(count, one, few, many)}`;
  const safeUrl = value => /^https?:\/\//i.test(String(value || '')) ? String(value) : '';
  const block = value => e(value).replace(/\n/g, '<br>');
  const key = 'samurai-training-session-v1', historyKey = 'samurai-training-history-v1', configKey = 'samurai-training-config-v1';
  let context, mount, pool = [], session = null, history = [], restored = false, initialized = false, sound = true, audio = null, storageWarning = false, resultSession = null, active = false, hasSavedConfig = false, defaultDifficultyResolved = false;
  let config = { author: 'all', format: 'kvrm', difficulty: null, anyDifficulty: false, tolerance: 1, count: 10, excludeSeen: true };
  function load(storageKey, fallback) { try { const raw = root.localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }
  function save(storageKey, value) { try { root.localStorage.setItem(storageKey, JSON.stringify(value)); return true; } catch (_) { storageWarning = true; const notice = mount && mount.querySelector('#trainingStorageNotice'); if (notice) { notice.hidden = false; notice.textContent = 'Браузер не смог сохранить тренировку. Результаты доступны до закрытия страницы; скачайте их после завершения.'; } return false; } }
  function persist() { if (session) save(key, session); }
  function remember() {
    if (!session || !['complete', 'results'].includes(session.status)) return;
    history = [session, ...history.filter(s => s.id !== session.id)].slice(0, 12);
    save(historyKey, history); persist();
  }
  function initialize() {
    if (initialized || !C) return;
    initialized = true;
    const saved = load(key, null); if (C.validSession(saved)) { session = saved; restored = true; C.advance(session, Date.now()); persist(); }
    history = load(historyKey, []); history = Array.isArray(history) ? history.filter(C.validSession).slice(0, 12) : [];
    const previous = load(configKey, null); if (previous && typeof previous === 'object' && !Array.isArray(previous)) { config = { ...config, ...previous }; hasSavedConfig = true; }
    if (![.5, 1, 2].includes(config.tolerance)) config.tolerance = 1;
    if (![5, 10, 15, 24, 36].includes(config.count)) config.count = 10;
    config.registrationId = String(config.registrationId || ''); config.includePastRegistrations = config.includePastRegistrations === true;
    config.author = String(config.author || 'all'); config.excludeSeen = config.excludeSeen !== false; config.anyDifficulty = config.anyDifficulty === true; if (!['kvrm', 'all'].includes(config.format)) config.format = 'kvrm';
    const savedSound = load('samurai-training-sound-v1', true); sound = savedSound !== false;
    root.setInterval(tick, 200);
    root.document.addEventListener('visibilitychange', tick);
  }
  function unlockAudio() {
    if (!sound) return;
    try { const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return; if (!audio) audio = new AC(); if (audio.state === 'suspended') audio.resume().catch(() => {}); } catch (_) { /* The visual clock remains usable without audio. */ }
  }
  function beep(finalSignal) {
    if (!sound || !audio || audio.state !== 'running') return;
    try {
      const start = audio.currentTime;
      (finalSignal ? [0, .28] : [0]).forEach(offset => {
        const osc = audio.createOscillator(), gain = audio.createGain();
        osc.type = 'sine'; osc.frequency.value = finalSignal ? 880 : 660;
        gain.gain.setValueAtTime(0, start + offset); gain.gain.linearRampToValueAtTime(.16, start + offset + .015); gain.gain.exponentialRampToValueAtTime(.001, start + offset + .2);
        osc.connect(gain); gain.connect(audio.destination); osc.start(start + offset); osc.stop(start + offset + .22);
      });
    } catch (_) { /* Browser audio policy never interrupts a question. */ }
  }
  function isVisible() { const section = mount && mount.closest('.view'); return active && mount && (!section || section.classList.contains('active')); }
  function tick() {
    if (!session || session.status !== 'running') return;
    const before = C.phase(session, Date.now()), events = C.advance(session, Date.now());
    if (events.length) {
      if (events.includes('signal60')) beep(true); else if (events.includes('signal50')) beep(false);
      persist();
      if (events.includes('locked')) { if (isVisible() && !resultSession) draw(); return; }
    }
    if (isVisible() && !resultSession) { updateClock(); if (before !== C.phase(session, Date.now()) || events.includes('signal60')) announce('Минута истекла. Десять секунд на сдачу ответа.'); }
  }
  function announce(text) { const node = mount && mount.querySelector('#trainingLive'); if (node) node.textContent = text; }
  function render(ctx) {
    context = ctx || {}; active = context.active !== false; mount = root.document && root.document.querySelector('#trainingRoot');
    if (!mount) return;
    if (!C) { mount.innerHTML = '<div class="notice">Не удалось загрузить модуль тренировки.</div>'; return; }
    initialize();
    const data = context.data || root.SAMURAI_TRAINING_DATA || root.SAMURAI_TRAINING || {};
    pool = C.questions(data);
    if (!config.anyDifficulty && (!finite(config.difficulty) || !hasSavedConfig && !defaultDifficultyResolved)) {
      const difficulties = [...new Map(pool.filter(q => finite(q.package.trueDl)).map(q => [q.package.id || q.package.name, q.package.trueDl])).values()].sort((a, b) => a - b);
      const targetDifficulty = finite(context.recommendedDifficulty) ? context.recommendedDifficulty : difficulties.length ? difficulties[Math.floor(difficulties.length / 2)] : 5;
      const nearby = difficulties.some(value => Math.abs(value - targetDifficulty) <= config.tolerance);
      config.difficulty = difficulties.length && !nearby ? difficulties.reduce((nearest, value) => Math.abs(value - targetDifficulty) < Math.abs(nearest - targetDifficulty) ? value : nearest, difficulties[0]) : targetDifficulty;
      if (difficulties.length) defaultDifficultyResolved = true;
    }
    if (session) { const events = C.advance(session, Date.now()); if (events.length) persist(); }
    draw();
  }
  function draw() {
    if (!mount) return;
    mount.innerHTML = `<div id="trainingLive" class="sr-only" role="status" aria-live="polite"></div><div id="trainingStorageNotice" class="notice"${storageWarning ? '' : ' hidden'}>Браузер не смог сохранить тренировку. Результаты доступны до закрытия страницы; скачайте их после завершения.</div><div id="trainingContent"></div>`;
    const target = mount.querySelector('#trainingContent');
    if (resultSession) { drawResults(target, resultSession); return; }
    if (!session) { drawSetup(target); return; }
    if (session.status === 'results') { drawResults(target, session); return; }
    if (session.status === 'complete') { drawComplete(target); return; }
    drawQuestion(target);
  }
  function seenIds() { return [...new Set(history.flatMap(s => s.questions.filter((_, i) => s.attempts[i].status !== 'unplayed').map(q => q.id)))]; }
  function dataMeta() { const d = context.data || root.SAMURAI_TRAINING_DATA || root.SAMURAI_TRAINING || {}; return d.meta || {}; }
  function historyMarkup() {
    if (!history.length) return '<p class="tiny-note">Завершённые тренировки появятся здесь. История сохраняется только в этом браузере.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Тренировка</th><th>Вопросов сыграно</th><th>Зачтено</th><th>Проверить</th><th>Средний trueDL пакетов</th><th>Результаты</th></tr></thead><tbody>${history.map(s => { const a = C.summary(s); return `<tr><td data-sort-value="${s.createdAt}">${new Date(s.createdAt).toLocaleString('ru-RU')}</td><td class="number">${a.attempted}</td><td class="number">${a.correct}</td><td class="number">${a.pending}</td><td class="number">${num(a.meanPackageDifficulty, 2)}</td><td><button class="training-inline" data-training-history="${e(s.id)}">Открыть ↗</button></td></tr>`; }).join('')}</tbody></table></div>`;
  }
  function registrationData() { return context.registrationData || root.SAMURAI_REGISTRATION_TRAINING || {}; }
  function prepareFocus(preset) {
    initialize();
    if (session && !['complete', 'results'].includes(session.status)) return { accepted: false, reason: 'active_session' };
    const ids = preset && Array.isArray(preset.questionIds) ? [...new Set(preset.questionIds.map(String))] : [];
    if (!ids.length) return { accepted: false, reason: 'empty_selection' };
    const authors = Array.isArray(preset.authors) ? [...new Set(preset.authors.map(String))] : [];
    config = { ...C.registrationConfig(null, config), author: 'all', questionIds: ids, focusLabel: String(preset.focusLabel || 'Вопросы выбранных авторов').slice(0, 160), format: 'kvrm', difficulty: null, anyDifficulty: true, count: 10, excludeSeen: true };
    if (authors.length) config.authors = authors;
    config.focusKind = preset.focusKind === 'mistakes' ? 'mistakes' : 'authors';
    config.focusDescription = String(preset.focusDescription || 'Вопросы выбранных авторов; формы и темы могут различаться. Исключены точно сопоставленные сыгранные вопросы команды.').slice(0, 1800);
    if (preset.focusKind === 'mistakes' && preset.remediation && typeof preset.remediation === 'object') {
      const r = preset.remediation;
      config.remediation = { tournamentId: String(r.tournamentId || ''), tournamentName: String(r.tournamentName || '').slice(0, 300), categoryKey: String(r.categoryKey || '').slice(0, 100), categoryLabel: String(r.categoryLabel || '').slice(0, 160), teamRate: finite(r.teamRate) ? r.teamRate : null, fieldRate: finite(r.fieldRate) ? r.fieldRate : null, questions: finite(r.questions) ? r.questions : null };
    }
    session = null; resultSession = null; save(key, null); hasSavedConfig = true; save(configKey, config);
    if (mount && isVisible()) draw();
    return { accepted: true };
  }
  function registrationPreset() { return C.registrations(registrationData(), Date.now(), true).find(t => String(t.tournamentId) === String(config.registrationId)); }
  function registrationMarkup() {
    const rows = C.registrations(registrationData(), Date.now(), config.includePastRegistrations);
    const all = C.registrations(registrationData(), Date.now(), true), selected = all.find(t => String(t.tournamentId) === config.registrationId);
    const unavailable = config.registrationId && !rows.some(t => String(t.tournamentId) === config.registrationId);
    const labels = { active: 'срок игры идёт', upcoming: 'предстоит', past: 'срок завершён', played: 'сыгран', unknown: 'даты не указаны' };
    return `<div class="training-registration"><div class="training-registration-heading"><div><div class="eyebrow muted">ПОДГОТОВКА К ИГРЕ</div><h4>Турнир из заявок команды</h4></div><span class="pill">${rows.length} в списке</span></div><label class="training-registration-select">Турнир<select id="trainingRegistration"><option value="">Ручной выбор автора</option>${unavailable ? `<option value="${e(config.registrationId)}">${e(selected ? selected.name : 'Заявка отсутствует в свежем списке')} · недоступен в текущих заявках</option>` : ''}${rows.map(t => `<option value="${e(t.tournamentId)}">${e(t.name)} · ${e(labels[t.status])}</option>`).join('')}</select></label><label class="training-checkbox"><input type="checkbox" id="trainingPastRegistrations"${config.includePastRegistrations ? ' checked' : ''}> Также показать сыгранные и завершённые турниры</label><div id="trainingRegistrationInfo" class="training-registration-info" aria-live="polite"></div><p class="tiny-note">По умолчанию здесь только текущие и будущие турниры из официального списка команды без опубликованного результата. Даты проверяются при выборе и запуске. Присутствие в списке рейтинга не подтверждает место у организатора.</p></div>`;
  }
  function updateRegistrationInfo() {
    const node = mount.querySelector('#trainingRegistrationInfo'); if (!node) return;
    if (!config.registrationId) { node.innerHTML = '<p>Выберите заявку, чтобы собрать вопросы нескольких авторов за один подход.</p>'; return; }
    const preset = registrationPreset();
    if (!preset) { node.innerHTML = '<p>Этой заявки нет в свежем снимке. Выберите другой турнир или ручной подбор.</p>'; return; }
    const eligible = C.registrations(registrationData(), Date.now(), config.includePastRegistrations).some(t => String(t.tournamentId) === config.registrationId);
    const actual = preset.authorBasis === 'question_credits', authors = preset.authors || [];
    const sources = `<a href="${e(safeUrl(preset.ratingUrl))}" target="_blank" rel="noopener">Карточка турнира ↗</a>`;
    node.innerHTML = `${!eligible ? '<div class="notice">Турнир уже сыгран, срок завершён или даты неизвестны. Для исторической подготовки включите показ завершённых турниров.</div>' : ''}<p><strong>${actual ? 'Авторы опубликованных вопросов выбранного турнира' : preset.authorBasis === 'rating_editors' ? 'Редакторы турнира → их прошлые авторские вопросы' : 'Авторы пока неизвестны'}</strong></p>${actual ? `<p>Авторы взяты из кредитов точно связанных пакетов GotQuestions. Кредиты есть у ${num(preset.targetQuestionsWithAuthors)} из ${num(preset.publishedTargetQuestions)} опубликованных вопросов.</p>` : '<p>Вопросы выбранного пакета не опубликованы или не сопоставлены. Его авторов мы не знаем. Подборка использует собственные прошлые вопросы объявленных редакторов; редакторство не означает авторство будущего пакета.</p>'}<p>${authors.length ? authors.slice().sort(C.compareAuthors).map(a => e(a.name)).join(' · ') : 'Совпавших авторов в тренировочной базе нет — запуск недоступен.'}</p><p>Найдено ${num(preset.matchedAuthorCount)} из ${num(preset.declaredAuthorCount)} ${actual ? 'известных авторов' : 'объявленных редакторов'} в годовой базе.${(preset.unmatchedAuthors || []).length ? ` Нет авторских вопросов у: ${preset.unmatchedAuthors.map(a => e(a.name)).join(', ')}.` : ''} Связанные с выбранным турниром пакеты исключены.${finite(preset.difficultyForecast) ? ` Сложность подставлена по прогнозу организаторов (${num(preset.difficultyForecast, 1)}); её можно изменить.` : ''}</p><p>${sources}</p>`;
  }
  function drawSetup(target) {
    const meta = dataMeta(), authors = C.authors(pool), packages = new Set(pool.map(q => q.package.id || q.package.name)).size;
    const catalogSourceUrl = safeUrl(meta.sourceUrl || meta.source);
    const difficulties = [...new Set(pool.map(q => q.package.trueDl).filter(finite))].sort((a, b) => a - b);
    const coverage = meta.coverage || {}, window = meta.yearWindow || {};
    const dateLabel = value => value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('ru-RU') : '';
    const coverageLabel = window.from && window.toInclusive ? `${dateLabel(window.from)}–${dateLabel(window.toInclusive)}` : '';
    const catalogLabel = meta.complete === true ? 'Полный годовой каталог' : 'Загруженная часть каталога';
    const knownDifficultyQuestions = pool.filter(q => finite(q.package.trueDl)).length;
    const difficultyNote = difficulties.length ? `В каталоге trueDL ${difficulties.length <= 5 ? difficulties.map(value => num(value, 2)).join(' · ') : `${num(difficulties[0], 2)}–${num(difficulties.at(-1), 2)}`}.${finite(context.recommendedDifficulty) ? ` Ориентир сыгранных вами пакетов: ${num(context.recommendedDifficulty, 2)}.` : ''}` : '';
    target.innerHTML = `<article class="training-hero"><div><div class="eyebrow">ДОДЗЁ · 60 + 10 СЕКУНД</div><h3>Следующий вопрос —<br>ваш следующий шаг<span>.</span></h3><p>Выберите автора и сложность пакетов. Прочитайте вопрос, запустите минуту отдельной кнопкой, сдавайте ответы и разбирайте тренировку после финиша.</p><div class="training-badges"><span>Сигнал на 50-й секунде</span><span>Сигнал на 60-й</span><span>10 секунд на сдачу</span></div></div><div class="training-hero-mark" aria-hidden="true">稽<small>ПРАКТИКА</small></div></article>
      <div id="trainingMistakesRoot"></div><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">СОБЕРИТЕ СВОЮ ТРЕНИРОВКУ</div><h3>Точность начинается с выбора</h3></div><span class="pill">Вопросов: ${num(pool.length)} · Пакетов: ${num(packages)}</span></div><p class="tiny-note training-catalog-coverage">${e(catalogLabel)}${coverageLabel ? ` · ${e(coverageLabel)}` : ''}. Загружено ${num(pool.length)} вопросов из ${num(packages)} пакетов${finite(coverage.questions) && coverage.questions !== pool.length ? `; в каталоге источника ${num(coverage.questions)} вопросов` : ''}. trueDL известен для ${num(knownDifficultyQuestions)} вопросов.${finite(coverage.unavailableForTraining) && coverage.unavailableForTraining > 0 ? ` Без опубликованного текста/ответа: ${num(coverage.unavailableForTraining)} — недоступны для тренировки.` : ''}</p>${!pool.length ? `<div class="notice training-unavailable"><strong>Вопросы пока не загружены</strong><p>В локальном каталоге пока нет опубликованных вопросов GotQuestions. Обновите данные кнопкой вверху страницы. ${e(meta.statusMessage || meta.message || '')}</p><p>Тренировку можно начать после загрузки реальных вопросов. ${safeUrl(meta.source) ? `<a href="${e(meta.source)}" target="_blank" rel="noopener">Открыть источник ↗</a>` : '<a href="https://gotquestions.online/" target="_blank" rel="noopener">Открыть GotQuestions ↗</a>'}</p></div>` : ''}
      ${config.focusLabel ? `<div class="notice training-focus"><strong>${config.focusKind === 'mistakes' ? 'Работа над ошибками' : 'Подборка из «Фокуса команды»'} · ${e(config.focusLabel)}</strong><p>${e(config.focusDescription || 'Вопросы выбранных авторов; формы и темы могут различаться. Исключены точно сопоставленные сыгранные вопросы команды.')} Сложность пакетов можно сузить ниже; подборка по категории останется строгой.</p><button type="button" class="training-inline" id="trainingClearFocus">Снять подборку и выбрать вручную ↗</button></div>` : ''}${registrationMarkup()}<div class="training-setup"><label>Автор вопросов<select id="trainingAuthor"><option value="all">${config.focusLabel ? (config.focusKind === 'mistakes' ? 'Все авторы категории' : 'Авторы подборки') : config.registrationId ? 'Авторы заявки' : 'Все авторы'}</option>${authors.map(a => `<option value="${e(a.id)}">${e(a.name)} · ${a.questions}</option>`).join('')}</select></label><label>Формат<select id="trainingFormat"><option value="kvrm">ЧГК</option><option value="all">Все, включая СИ</option></select></label><label>Сложность пакетов · trueDL<input id="trainingDifficulty" type="number" step="0.1" min="-5" max="20" value="${e(config.difficulty)}"${config.anyDifficulty ? ' disabled' : ''}></label><label>Близость сложности<select id="trainingTolerance"><option value="0.5">± 0,5 trueDL</option><option value="1">± 1 trueDL</option><option value="2">± 2 trueDL</option></select></label><label>Вопросов<select id="trainingCount">${[5, 10, 15, 24, 36].map(n => `<option value="${n}">${counted(n, 'вопрос', 'вопроса', 'вопросов')}</option>`).join('')}</select></label></div>
      <p class="tiny-note training-difficulty-note">${e(difficultyNote)}</p><div class="training-setup-bottom"><label class="training-checkbox"><input type="checkbox" id="trainingAnyDifficulty"${config.anyDifficulty ? ' checked' : ''}> Все сложности, включая неизвестную</label><label class="training-checkbox"><input type="checkbox" id="trainingExcludeSeen"${config.excludeSeen ? ' checked' : ''}> Не повторять вопросы из моей истории</label><label class="training-checkbox"><input type="checkbox" id="trainingSound"${sound ? ' checked' : ''}> Звуковые сигналы</label><button id="trainingSoundTest" class="training-inline" type="button">Проверить звук ♪</button></div><div class="training-start-row"><div><b id="trainingAvailability"></b><p class="tiny-note">trueDL описывает весь пакет; используется официальный trueDL турнира с наибольшим числом команд из записей GotQuestions. У отдельного вопроса может быть другая сложность. Вопросы выбираются случайно.</p></div><button id="trainingStart" class="training-primary" type="button">Начать тренировку <span>↗</span></button></div><p class="tiny-note">Ответы не раскрываются до завершения тренировки. Совпадения проверяются только по точным вариантам; спорные ответы вы оцениваете сами. Перед каждым вопросом таймер ждёт нажатия «Начать отсчёт». После запуска он продолжает идти при смене вкладки. ${meta.updatedAt ? `Каталог: ${e(new Date(meta.updatedAt).toLocaleDateString('ru-RU'))}.` : ''}</p>${pool.length && meta.source ? `<p class="tiny-note">${e(meta.source)}. ${catalogSourceUrl ? `<a class="training-inline" href="${e(catalogSourceUrl)}" target="_blank" rel="noopener">Открыть каталог ↗</a>` : ''}</p>` : ''}</article>
      <article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ВАШИ ПРЕДЫДУЩИЕ ПОДХОДЫ</div><h3>История тренировок</h3></div><span class="pill">В этом браузере · последние 12</span></div>${historyMarkup()}</article>`;
    const authorNode = mount.querySelector('#trainingAuthor'); authorNode.value = authors.some(a => a.id === config.author) ? config.author : 'all'; config.author = authorNode.value;
    mount.querySelector('#trainingRegistration').value = config.registrationId;
    authorNode.disabled = Boolean(config.registrationId || config.focusLabel);
    const clearFocus = mount.querySelector('#trainingClearFocus');
    if (clearFocus) clearFocus.onclick = () => { config = C.registrationConfig(null, config); hasSavedConfig = true; save(configKey, config); draw(); };
    mount.querySelector('#trainingRegistration').onchange = event => { const preset = C.registrations(registrationData(), Date.now(), true).find(t => String(t.tournamentId) === event.target.value); config = C.registrationConfig(preset, config); hasSavedConfig = true; save(configKey, config); draw(); };
    mount.querySelector('#trainingPastRegistrations').onchange = event => { config.includePastRegistrations = event.target.checked; hasSavedConfig = true; save(configKey, config); draw(); };
    mount.querySelector('#trainingTolerance').value = String(config.tolerance);
    mount.querySelector('#trainingCount').value = String(config.count);
    mount.querySelector('#trainingFormat').value = config.format;
    for (const id of ['trainingAuthor', 'trainingFormat', 'trainingDifficulty', 'trainingTolerance', 'trainingCount', 'trainingExcludeSeen', 'trainingAnyDifficulty']) mount.querySelector(`#${id}`).onchange = updateAvailability;
    mount.querySelector('#trainingSound').onchange = event => { sound = event.target.checked; save('samurai-training-sound-v1', sound); if (sound) unlockAudio(); };
    mount.querySelector('#trainingSoundTest').onclick = () => { unlockAudio(); root.setTimeout(() => beep(false), 100); };
    mount.querySelector('#trainingStart').onclick = start;
    if (root.SamuraiFocusCore && root.SamuraiMistakesView && Array.isArray(context.history)) {
      const mistakes = root.SamuraiFocusCore.build({ selected: context.history, playedData: context.playedData, trainingData: context.data }).mistakes;
      root.SamuraiMistakesView.render({ mount: mount.querySelector('#trainingMistakesRoot'), data: mistakes, openTournament: context.openTournament, onTrain: preset => prepareFocus(preset) });
    }
    bindHistory(); updateAvailability();
  }
  function updateAvailability(event) {
    const author = mount.querySelector('#trainingAuthor'); if (!author) return;
    const difficultyValue = mount.querySelector('#trainingDifficulty').value;
    const anyDifficulty = mount.querySelector('#trainingAnyDifficulty').checked;
    config = { ...config, author: author.value, format: mount.querySelector('#trainingFormat').value, anyDifficulty, difficulty: anyDifficulty || difficultyValue.trim() === '' ? null : Number(difficultyValue), tolerance: Number(mount.querySelector('#trainingTolerance').value), count: Number(mount.querySelector('#trainingCount').value), excludeSeen: mount.querySelector('#trainingExcludeSeen').checked };
    mount.querySelector('#trainingDifficulty').disabled = anyDifficulty;
    mount.querySelector('#trainingTolerance').disabled = anyDifficulty;
    // Read fresh IDs and exclusions instead of trusting a saved preset after
    // the underlying archive/registrations have been refreshed.
    const preset = registrationPreset();
    if (config.registrationId) { config.authors = preset ? (preset.authors || []).map(a => String(a.id)) : []; config.excludePackageIds = preset ? (preset.targetPackageIds || []).map(String) : []; }
    const registrationValid = !config.registrationId || C.registrations(registrationData(), Date.now(), config.includePastRegistrations).some(t => String(t.tournamentId) === config.registrationId);
    const valid = registrationValid && (anyDifficulty || finite(config.difficulty) && config.difficulty >= -5 && config.difficulty <= 20) && [.5, 1, 2].includes(config.tolerance);
    const candidates = valid ? C.candidates(pool, config, seenIds()) : [];
    mount.querySelector('#trainingAvailability').textContent = !registrationValid ? 'Выберите текущую заявку или включите исторические турниры.' : !valid ? 'Укажите сложность пакетов от −5 до 20' : candidates.length ? `Доступно: ${counted(candidates.length, 'вопрос', 'вопроса', 'вопросов')}. В тренировке: ${Math.min(config.count, candidates.length)}.` : 'Подходящих вопросов нет — измените автора, сложность или повторения.';
    mount.querySelector('#trainingStart').disabled = !candidates.length;
    updateRegistrationInfo();
    if (event === true || event && event.target) { hasSavedConfig = true; save(configKey, config); }
  }
  function start() {
    updateAvailability(true); if (mount.querySelector('#trainingStart').disabled) return; if (!config.anyDifficulty && !finite(config.difficulty)) return;
    const available = C.candidates(pool, config, seenIds()); if (!available.length) return;
    unlockAudio(); session = C.createSession(available, config, Date.now()); restored = false; resultSession = null; persist(); draw(); announce('Вопрос открыт для чтения. Нажмите «Начать отсчёт», когда закончите читать.');
  }
  function mediaMarkup(question, review = false, blurred = false) {
    const media = (question.media || []).filter(m => review || !m.role || ['question', 'handout'].includes(m.role));
    const entries = media.map(m => {
      const url = safeUrl(m.url); if (!url) return '';
      const label = m.alt || ({ answer: 'Иллюстрация к ответу', comment: 'Иллюстрация к комментарию', handout: 'Раздаточный материал' }[m.role]) || 'Материал к вопросу';
      if (m.type === 'image') return `<figure><a href="${e(url)}" target="_blank" rel="noopener"><img src="${e(url)}" alt="${e(label)}" loading="lazy"></a><figcaption>${e(label)}</figcaption></figure>`;
      if (['audio', 'video'].includes(m.type)) return `<figure><${m.type} controls preload="none" src="${e(url)}" aria-label="${e(label)}"></${m.type}><figcaption>${e(label)} · <a href="${e(url)}" target="_blank" rel="noopener">Открыть материал ↗</a></figcaption></figure>`;
      return `<a href="${e(url)}" target="_blank" rel="noopener">${e(label)} ↗</a>`;
    }).filter(Boolean);
    return entries.length ? `<div class="training-media${blurred ? ' training-blurred' : ''}">${entries.join('')}<p class="tiny-note">Медиа загружаются из источника; для изображений, аудио и видео нужен интернет.</p></div>` : '';
  }
  function drawQuestion(target) {
    const q = session.questions[session.index], a = C.current(session), locked = session.status === 'locked', reading = session.status === 'reading';
    const count = session.questions.length;
    target.innerHTML = `${restored ? '<div class="notice training-restore">Восстановила вашу тренировку. Чтение не запускает отсчёт; запущенный таймер учитывает время после закрытия страницы, пауза сохраняется.</div>' : ''}<div class="training-session-head"><div><div class="eyebrow muted">ВОПРОС ${session.index + 1} ИЗ ${count}</div><h3>${reading ? 'Прочитайте. Затем запустите минуту.' : 'Один вопрос. Одна минута.'}</h3></div><span class="pill">${e(q.package.name || 'Пакет')} · trueDL ${num(q.package.trueDl, 2)}</span></div><div class="training-progress" aria-label="Прогресс тренировки"><span style="width:${session.index / count * 100}%"></span></div>${q.flags && q.flags.nonstandardTiming || q.package.type === 'si' ? '<div class="notice training-timing-notice">У этого вопроса может быть особый формат или регламент. В тренажёре используется режим 60 + 10 секунд; сверяйтесь с текстом вопроса.</div>' : ''}<div class="training-arena"><article class="panel training-question"><div class="training-question-meta"><span>${q.authors.length ? e(q.authors.map(a => a.name).join(', ')) : 'Автор не указан'}</span><span>${q.number ? `№ ${e(q.number)}` : 'Вопрос'} · ${e(q.package.name || '')}</span></div>${q.form ? `<div class="training-question-form">Форма ответа: ${e(q.form)}</div>` : ''}<div class="training-question-text${session.paused ? ' training-blurred' : ''}">${block(q.text)}</div>${mediaMarkup(q, false, session.paused)}<div class="training-answer-form"><label for="trainingAnswer">Ваш ответ</label><textarea id="trainingAnswer" rows="3" maxlength="2000" placeholder="Напишите версию и сдайте ответ…"${locked || reading || session.paused ? ' disabled' : ''}>${e(a.answer)}</textarea><div class="training-answer-bottom"><span id="trainingAnswerState">${locked ? 'Ответ зафиксирован. Разбор появится после завершения.' : reading ? 'Сначала прочитайте вопрос и запустите отсчёт.' : session.paused ? 'Пауза · ввод ответа приостановлен' : 'Черновик сохраняется автоматически в этом браузере'}</span>${reading ? '<span class="training-reading-label">Время на чтение не ограничено</span>' : !locked ? '<button class="training-primary" id="trainingSubmit" type="button">Сдать ответ ↗</button>' : `<button class="training-primary" id="trainingNext" type="button">${session.index === count - 1 ? 'Завершить тренировку' : 'Следующий вопрос'} ↗</button>`}</div></div></article><aside class="training-clock-panel"><div class="eyebrow" id="trainingPhase">ОБСУЖДЕНИЕ</div><div class="training-clock" id="trainingClock" role="timer" aria-live="off">60</div><div class="training-clock-caption" id="trainingClockCaption">секунд на вопрос</div><div class="training-clock-track"><span id="trainingClockTrack"></span></div><p id="trainingClockNote">Один сигнал — 50 секунд.<br>Два — минута, сдайте ответ за 10 секунд.</p><div class="training-clock-actions">${reading ? '<button id="trainingStartTimer" class="training-primary" type="button">▶ Начать отсчёт</button>' : !locked ? `<button id="trainingPause" type="button">${session.paused ? '▶ Продолжить' : 'Ⅱ Пауза'}</button><button id="trainingSkip" type="button">Пропустить вопрос →</button>` : '<span class="training-lock-note">Ответ сохранён ✓</span>'}<button id="trainingFinish" type="button">Завершить сейчас</button></div><label class="training-checkbox"><input type="checkbox" id="trainingSound"${sound ? ' checked' : ''}> Звуковые сигналы</label></aside></div><p class="tiny-note">Перед каждым вопросом отсчёт начинается только по кнопке «Начать отсчёт». До нажатия доступны текст и раздатки. Запущенный таймер продолжает идти в другой вкладке; время чтения и паузы в результат не входят.</p>`;
    const input = mount.querySelector('#trainingAnswer');
    input.oninput = () => { if (session.status === 'running' && !session.paused) { C.advance(session, Date.now()); if (session.status === 'running') { C.current(session).answer = input.value; persist(); } else draw(); } };
    if (reading) {
      mount.querySelector('#trainingStartTimer').onclick = () => { unlockAudio(); if (C.startTimer(session, Date.now())) { restored = false; persist(); draw(); announce('Начался отсчёт. Шестьдесят секунд на обсуждение.'); } };
    } else if (!locked) {
      mount.querySelector('#trainingSubmit').disabled = session.paused;
      mount.querySelector('#trainingSubmit').onclick = () => { C.advance(session, Date.now()); if (session.status === 'running' && !session.paused) { C.current(session).answer = input.value; C.lock(session, Date.now()); } persist(); draw(); };
      mount.querySelector('#trainingPause').onclick = () => { unlockAudio(); if (session.paused) C.resume(session, Date.now()); else C.pause(session, Date.now()); persist(); draw(); };
      mount.querySelector('#trainingSkip').onclick = () => { C.advance(session, Date.now()); if (session.status === 'running' && !session.paused) C.lock(session, Date.now(), 'skipped'); persist(); draw(); };
      mount.querySelector('#trainingSkip').disabled = session.paused;
    } else mount.querySelector('#trainingNext').onclick = () => { C.next(session, Date.now()); restored = false; persist(); if (session.status === 'complete') remember(); draw(); };
    mount.querySelector('#trainingFinish').onclick = () => { C.advance(session, Date.now()); C.finish(session, Date.now()); remember(); draw(); };
    mount.querySelector('#trainingSound').onchange = event => { sound = event.target.checked; save('samurai-training-sound-v1', sound); if (sound) unlockAudio(); };
    mount.querySelector('#trainingClockNote').innerHTML = reading ? 'Прочитайте текст и изучите раздатки.<br>Начните отсчёт, когда будете готовы.' : 'Один сигнал — 50 секунд.<br>Два — минута, сдайте ответ за 10 секунд.';
    updateClock();
  }
  function updateClock() {
    if (!mount || !session) return;
    const node = mount.querySelector('#trainingClock'); if (!node) return;
    const p = C.phase(session, Date.now()), seconds = C.remaining(session, Date.now()), locked = session.status === 'locked', reading = session.status === 'reading';
    node.textContent = locked ? '✓' : seconds.toString().padStart(2, '0');
    const panel = node.closest('.training-clock-panel'); panel.classList.toggle('submission', p === 'submission'); panel.classList.toggle('paused', session.paused); panel.classList.toggle('locked', locked); panel.classList.toggle('reading', reading);
    mount.querySelector('#trainingPhase').textContent = locked ? 'ОТВЕТ ПРИНЯТ' : reading ? 'ЧТЕНИЕ ВОПРОСА' : session.paused ? 'ПАУЗА' : p === 'submission' ? 'СДАЧА ОТВЕТА' : 'ОБСУЖДЕНИЕ';
    mount.querySelector('#trainingClockCaption').textContent = locked ? 'Можно перейти дальше' : reading ? 'Отсчёт ещё не запущен' : session.paused ? 'Время остановлено' : p === 'submission' ? `${noun(seconds, 'секунда', 'секунды', 'секунд')} на сдачу` : `${noun(seconds, 'секунда', 'секунды', 'секунд')} на вопрос`;
    mount.querySelector('#trainingClockTrack').style.width = `${locked ? 100 : Math.max(0, seconds / (p === 'submission' ? 10 : 60) * 100)}%`;
  }
  function drawComplete(target) {
    remember(); const s = C.summary(session);
    target.innerHTML = `<article class="training-complete"><div class="training-complete-mark" aria-hidden="true">◎</div><div class="eyebrow">ПОДХОД ЗАВЕРШЁН</div><h3>Время разобрать<br>ваши решения<span>.</span></h3><p>Вопросов сыграно: ${s.attempted} из ${s.total}. Нажмите кнопку, чтобы раскрыть ответы, проверить спорные версии и увидеть результаты тренировки.</p><button class="training-primary" id="trainingShowResults" type="button">Посмотреть результаты ↗</button><span class="tiny-note">До этой кнопки ответы остаются скрыты.</span></article>`;
    mount.querySelector('#trainingShowResults').onclick = () => { session.status = 'results'; remember(); draw(); };
  }
  function kpi(label, value, note) { return `<article class="kpi"><div class="kpi-label">${e(label)}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${e(note)}</div></article>`; }
  function gradeName(row) { return row.grade === 1 ? 'Зачтено' : row.grade === 0 ? 'Не взято' : 'Проверить'; }
  function mistakesRecap(result, summary) {
    const r = result.config?.remediation;
    if (result.config?.focusKind !== 'mistakes' || !r) return '';
    return `<article class="training-mistakes-recap"><div class="eyebrow muted">РАБОТА НАД ОШИБКАМИ · ИТОГ ПОДХОДА</div><h4>${e(r.categoryLabel)}</h4><p>Повод: ${e(r.tournamentName)}. В исходном срезе взяли ${pct(r.teamRate)}, поле — ${pct(r.fieldRate)} (${num(r.questions)} вопросов).</p><p>На новых вопросах этой категории зачтено ${summary.correct} из ${summary.judged} оценённых (${pct(summary.rate)}). На проверке: ${summary.pending}; не сыграно: ${summary.unplayed}.</p><small>${e(result.config.focusDescription || '')} Разные вопросы и поля: эти проценты не измеряют изменение перфоманса или доказанный прогресс. После проверки спорных ответов вспомните, что помогло: чтение условия, генерация версий или выбор ответа.</small></article>`;
  }
  function drawResults(target, result) {
    const s = C.summary(result), self = !resultSession;
    const progress = C.progress(history, result);
    target.innerHTML = `<div class="training-results-head"><div><div class="eyebrow muted">РАЗБОР ТРЕНИРОВКИ · ${e(new Date(result.createdAt).toLocaleDateString('ru-RU'))}</div><h3>Ваш опыт превращается в прогресс<span>.</span></h3></div><div class="training-result-actions"><button type="button" id="trainingDownload" class="training-secondary">Скачать результаты ↓</button><button type="button" id="trainingNew" class="training-primary">${resultSession && session && !['complete', 'results'].includes(session.status) ? 'Вернуться к тренировке' : 'Новая тренировка'} ↗</button></div></div><div class="notice">Это ваши ответы на тренировке, а не официальный перфоманс B. Только точные совпадения с опубликованными вариантами засчитываются автоматически. Остальные версии требуют вашей проверки по ответу, зачёту и комментарию. ${s.pending ? `<b>Осталось проверить: ${s.pending}.</b>` : 'Все сыгранные вопросы оценены.'}</div>${mistakesRecap(result, s)}<div class="kpi-grid training-result-kpis">${kpi('Зачтено', `${s.correct}<small>/ ${s.attempted}</small>`, `На проверке: ${s.pending} · Не сыграно: ${s.unplayed}`)}${kpi('Взятие среди оценённых', pct(s.rate), `Оценено вопросов: ${s.judged} из ${s.attempted}`)}${kpi('Среднее время на вопрос', `${num(s.avgTime, 1)}<small>сек</small>`, 'От запуска отсчёта · без чтения и пауз')}${kpi('Средний trueDL пакетов', num(s.meanPackageDifficulty, 2), `Известен у ${num(s.rows.filter(r => finite(r.package.trueDl)).length)} из ${num(s.attempted)} сыгранных вопросов`)}</div><div class="training-insight-grid">${insights(s, result).map((item, i) => `<article class="training-insight"><span class="eyebrow">НАБЛЮДЕНИЕ ${String(i + 1).padStart(2, '0')}</span><h4>${e(item.title)}</h4><p>${e(item.text)}</p></article>`).join('')}</div><div class="grid equal"><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ВРЕМЯ И РЕЗУЛЬТАТ</div><h3>Как проходила тренировка</h3></div></div><p class="chart-note">Время до сдачи, пропуска или таймаута. Цвет показывает вашу итоговую оценку; пунктир — 60 секунд.</p><div id="trainingTimeChart" class="chart" data-chart-scope="training" role="img" aria-label="Время ответа по вопросам тренировки"></div></article><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">КОНТЕКСТ СЛОЖНОСТИ</div><h3>Пакеты в вашей подборке</h3></div></div><p class="chart-note">Зачтённые вопросы и вопросы на проверке по пакету. trueDL относится ко всему пакету.</p><div id="trainingPackageChart" class="chart" data-chart-scope="training" role="img" aria-label="Результаты тренировки по пакетам"></div></article></div><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ИСТОРИЯ ПРАКТИКИ</div><h3>Ритм от тренировки к тренировке</h3></div><span class="pill">Подходов: ${progress.rows.length}</span></div><p class="chart-note">Взятие среди оценённых вопросов и средний trueDL подборки. Непроверенные ответы могут менять процент; разная сложность и повторные вопросы влияют на сравнение.</p><div id="trainingHistoryChart" class="chart" data-chart-scope="training" role="img" aria-label="История результатов тренировок с контекстом сложности"></div><p class="tiny-note">История хранит последние 12 тренировок в этом браузере. Средний trueDL взвешен числом сыгранных вопросов из каждого пакета.</p></article><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">АВТОРСКИЙ ПОЧЕРК</div><h3>С кем находился общий язык</h3></div></div><p class="chart-note">Описательная статистика этой подборки. Вопрос с несколькими авторами учитывается у каждого, поэтому строки нельзя складывать.</p><div class="table-wrap"><table><thead><tr><th>Автор</th><th>Сыграно</th><th>Оценено</th><th>Зачтено</th><th>Взятие оценённых</th></tr></thead><tbody>${s.authors.map(a => `<tr><td class="table-title">${e(a.name)}</td><td class="number">${a.count}</td><td class="number">${a.judged}</td><td class="number">${a.correct}</td><td class="number" data-sort-value="${a.judged ? a.correct / a.judged : ''}">${pct(a.judged ? a.correct / a.judged : null)}</td></tr>`).join('') || '<tr><td colspan="5">Авторы не указаны в источнике.</td></tr>'}</tbody></table></div></article><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ПРОВЕРКА КАЖДОГО ОТВЕТА</div><h3>Версия, ответ и объяснение</h3></div><span class="pill">${s.pending} на проверке</span></div><p class="chart-note">Отметьте «Зачесть» или «Не зачесть» для спорных версий. Самооценка сразу пересчитает все показатели и сохранится в истории.</p><div class="training-review-list">${s.rows.map(row => reviewMarkup(row)).join('')}</div></article>`;
    mount.querySelector('#trainingDownload').onclick = () => download(result);
    mount.querySelector('#trainingNew').onclick = () => {
      if (resultSession) { resultSession = null; if (session && !['complete', 'results'].includes(session.status)) { draw(); return; } session = null; try { root.localStorage.removeItem(key); } catch (_) {} draw(); return; }
      session = null; try { root.localStorage.removeItem(key); } catch (_) { /* Preserve results in history even when storage is restricted. */ } draw();
    };
    mount.querySelectorAll('[data-training-grade]').forEach(button => { button.onclick = () => {
      const index = Number(button.dataset.trainingGrade), value = button.dataset.grade === 'pending' ? null : Number(button.dataset.grade);
      C.grade(result, index, value);
      if (self) remember(); else { history = history.map(s => s.id === result.id ? result : s); save(historyKey, history); if (session && session.id === result.id) { session = result; persist(); } }
      const scrollY = root.scrollY; draw(); root.scrollTo({ top: scrollY, behavior: 'instant' });
    }; });
    drawCharts(s, progress);
  }
  function reviewMarkup(row) {
    const qurl = safeUrl(row.sourceUrl), purl = safeUrl(row.package.url), hasResponse = String(row.submittedAnswer).trim();
    // Published and submitted answers remain explicit separate fields in summaries and exports.
    const result = resultSession || session, original = result.questions[row.index];
    const sourceLabel = /[?&]q=|\/question\//i.test(qurl) ? 'Вопрос в источнике' : 'Пакет в источнике';
    return `<article class="training-review ${row.grade === 1 ? 'correct' : row.grade === 0 ? 'incorrect' : 'pending'}"><div class="training-review-head"><span class="number">${String(row.index + 1).padStart(2, '0')}</span><span>${e(row.package.name)} · trueDL ${num(row.package.trueDl, 2)}</span><b>${gradeName(row)}</b><span>${num(row.elapsed, 1)} с</span></div><details${row.grade === null ? ' open' : ''}><summary>${e(row.text.slice(0, 160))}${row.text.length > 160 ? '…' : ''}</summary><p class="training-review-question">${block(row.text)}</p><div class="training-answer-comparison"><div><span>Ваш ответ</span><p>${hasResponse ? block(row.submittedAnswer) : '<em>Ответ не сдан</em>'}</p></div><div><span>Ответ источника</span><p>${original.answer ? block(original.answer) : '<em>Ответ не указан в источнике; нужна ручная проверка.</em>'}</p>${original.acceptedAnswers && original.acceptedAnswers.length ? `<small>Точные варианты зачёта: ${e(original.acceptedAnswers.join('; '))}</small>` : ''}${original.acceptedText ? `<small>Зачёт из источника: ${block(original.acceptedText)}</small>` : ''}${original.rejectedText ? `<small>Незачёт из источника: ${block(original.rejectedText)}</small>` : ''}</div></div>${mediaMarkup(original, true)}${original.comment ? `<p class="training-review-comment"><b>Комментарий.</b> ${block(original.comment)}</p>` : ''}${original.sources && (Array.isArray(original.sources) ? original.sources.length : String(original.sources).trim()) ? `<p class="training-review-comment"><b>Источники.</b> ${block(Array.isArray(original.sources) ? original.sources.join('\n') : original.sources)}</p>` : ''}${qurl || purl ? `<a class="training-inline" href="${e(qurl || purl)}" target="_blank" rel="noopener">${sourceLabel} ↗</a>` : ''}<p class="tiny-note">${row.gradeSource === 'literal' ? 'Автозачёт: точное совпадение с опубликованным вариантом, без нечёткого поиска.' : row.gradeSource === 'self' ? 'Оценка выставлена вами.' : row.gradeSource === 'empty' ? 'Нет сданного ответа.' : 'Автоматически подтвердить ответ не удалось. Сверьте его с источником.'}</p></details><div class="training-grade-actions"><button type="button" data-training-grade="${row.index}" data-grade="1" aria-pressed="${row.grade === 1}">✓ Зачесть</button><button type="button" data-training-grade="${row.index}" data-grade="0" aria-pressed="${row.grade === 0}">× Не зачесть</button><button type="button" data-training-grade="${row.index}" data-grade="pending" aria-pressed="${row.grade === null}">? На проверку</button></div></article>`;
  }
  function insights(s, result) {
    const items = [];
    items.push(s.pending ? { title: `Нужна проверка: ${s.pending}`, text: `Взятие учитывает только оценённые вопросы (${s.judged}). Пока спорные ответы не разобраны, итог может измениться.` } : { title: `${s.correct} из ${s.attempted} — ваш итог`, text: `Все сыгранные вопросы оценены. ${s.empty ? `Без сданного ответа: ${s.empty}.` : 'На каждый сыгранный вопрос был сдан ответ.'} ${s.attempted < 20 ? 'Короткая подборка показывает результат этого подхода; для устойчивых выводов нужно больше практики.' : 'Сравнивайте этот результат с тренировками похожей сложности и состава авторов.'}` });
    const progress = C.progress(history, result);
    if (progress.comparison) {
      const p = progress.comparison;
      items[0] = { title: `${p.delta > 0 ? '+' : ''}${num(p.delta * 100, 1)} п.п. к похожим подходам`, text: `Взятие ${pct(p.currentRate)} против среднего ${pct(p.previousRate)} по прошлым полностью оценённым тренировкам (${p.count}) с тем же выбором автора и средним trueDL в пределах ±0,5. Каждый подход имеет одинаковый вес; это описательное сравнение.` };
    }
    const submitted = s.rows.filter(r => String(r.submittedAnswer).trim()), late = submitted.filter(r => r.elapsed > 60).length;
    items.push({ title: late ? `${counted(late, 'ответ', 'ответа', 'ответов')} — в десятисекундку` : submitted.length ? 'Ответы — в пределах минуты' : 'Сданных ответов нет', text: `${submitted.length ? late ? `Позже 60 секунд сдано: ${late} из ${submitted.length}.` : `Все сданные ответы (${submitted.length}) зафиксированы за 60 секунд или раньше.` : `Вопросов сыграно: ${s.attempted}.`} Без сданного ответа: ${s.empty}. Среднее время на вопрос ${num(s.avgTime, 1)} с, паузы исключены.` });
    const eligible = s.authors.filter(a => a.judged >= 3).sort((a, b) => b.correct / b.judged - a.correct / a.judged || b.judged - a.judged);
    if (eligible.length) items.push({ title: eligible[0].name, text: `Лучшее взятие среди авторов с 3+ оценёнными вопросами: ${eligible[0].correct}/${eligible[0].judged}. Это наблюдение по этой подборке, а не оценка постоянной силы на авторе.` });
    else items.push({ title: 'Постройте авторскую дистанцию', text: 'Для сравнения авторов пока мало оценённых вопросов. Попробуйте подборку из 10–15 вопросов одного автора при том же trueDL пакетов.' });
    return items;
  }
  function drawCharts(s, progress) {
    if (!context.chart || !context.base || !s.rows.length) return;
    const colors = context.colors || { green: '#7d9a68', red: '#d95140', gray: '#c5cdb7', ink: '#68785a' };
    let o = context.base(); o.grid = { left: 42, right: 17, top: 25, bottom: 34 }; o.xAxis.data = s.rows.map(r => String(r.index + 1)); o.xAxis.name = '№'; o.yAxis.max = 70; o.yAxis.name = 'Секунды';
    o.tooltip.formatter = params => { const row = s.rows[params[0].dataIndex]; return `<b>Вопрос ${row.index + 1}</b><br>${e(row.package.name)}<br>Время на вопрос: ${num(row.elapsed, 1)} с<br>${gradeName(row)}`; };
    o.series = [{ type: 'bar', barMaxWidth: 30, data: s.rows.map(r => ({ value: r.elapsed, itemStyle: { color: r.grade === 1 ? colors.green : r.grade === 0 ? colors.red : colors.gray, borderRadius: [3, 3, 0, 0] } })), markLine: { silent: true, symbol: 'none', data: [{ yAxis: 60 }], lineStyle: { type: 'dashed', color: '#b8a087' }, label: { show: false } } }]; context.chart('trainingTimeChart', o);
    const ps = s.packages;
    o = context.base(); o.grid = { left: 40, right: 17, top: 25, bottom: 55 }; o.xAxis.data = ps.map(p => finite(p.trueDl) ? `trueDL ${num(p.trueDl, 1)}` : 'trueDL неизвестен'); o.xAxis.axisLabel = { ...o.xAxis.axisLabel, rotate: ps.length > 5 ? 25 : 0 }; o.yAxis.minInterval = 1; o.yAxis.name = 'Вопросы';
    o.tooltip.formatter = params => { const p = ps[params[0].dataIndex]; return `<b>${e(p.name)}</b><br>trueDL пакета: ${num(p.trueDl, 2)}<br>Сыграно ${p.count}<br>Зачтено ${p.correct} / оценено ${p.judged}<br>На проверке ${p.count - p.judged}`; };
    o.series = [{ name: 'Зачтено', type: 'bar', stack: 'questions', data: ps.map(p => p.correct), itemStyle: { color: colors.green }, barMaxWidth: 40 }, { name: 'Не взято', type: 'bar', stack: 'questions', data: ps.map(p => p.judged - p.correct), itemStyle: { color: '#e0c3b3' } }, { name: 'На проверке', type: 'bar', stack: 'questions', data: ps.map(p => p.count - p.judged), itemStyle: { color: colors.gray } }]; context.chart('trainingPackageChart', o);
    const rows = progress.rows.slice(-12);
    o = context.base(); o.grid = { left: 45, right: 50, top: 28, bottom: 35 }; o.xAxis.data = rows.map(r => new Date(r.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
    const yAxis = o.yAxis;
    o.yAxis = [{ ...yAxis, min: 0, max: 100, name: 'Взятие, %' }, { ...yAxis, position: 'right', name: 'trueDL', scale: true, splitLine: { show: false } }];
    o.tooltip.formatter = params => { const r = rows[params[0].dataIndex]; return `<b>${e(new Date(r.createdAt).toLocaleString('ru-RU'))}</b><br>Зачтено ${r.correct}/${r.judged} оценённых · ${pct(r.rate)}<br>На проверке ${r.pending}<br>Средний trueDL подборки ${num(r.meanPackageDifficulty, 2)}<br>Сыграно ${r.attempted}`; };
    o.series = [{ name: 'Взятие оценённых', type: 'line', symbol: 'circle', symbolSize: 8, connectNulls: false, data: rows.map(r => r.rate === null ? null : { value: r.rate * 100, itemStyle: { color: r.pending ? colors.gray : colors.green } }), lineStyle: { color: colors.green, width: 2 }, itemStyle: { color: colors.green } }, { name: 'Средний trueDL', type: 'line', yAxisIndex: 1, symbol: 'diamond', symbolSize: 6, data: rows.map(r => r.meanPackageDifficulty), lineStyle: { color: '#b69b83', type: 'dashed', width: 1 }, itemStyle: { color: '#b69b83' } }];
    context.chart('trainingHistoryChart', o);
  }
  function bindHistory() { mount.querySelectorAll('[data-training-history]').forEach(button => { button.onclick = () => { resultSession = history.find(s => s.id === button.dataset.trainingHistory); if (resultSession) draw(); }; }); }
  function download(result) {
    const summary = C.summary(result), payload = { exportedAt: new Date().toISOString(), description: 'Самооценка тренировки. trueDL — сложность пакета; это не официальный перфоманс B.', session: result, summary };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), url = URL.createObjectURL(blob), a = root.document.createElement('a'); a.href = url; a.download = `samurai-training-${new Date(result.createdAt).toISOString().slice(0, 10)}.json`; a.click(); root.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  root.SamuraiTrainingView = { render, prepareFocus, setRegistrationData(data) { root.SAMURAI_REGISTRATION_TRAINING = data || {}; if (context) context.registrationData = data || {}; if (mount && !session && !resultSession && isVisible()) draw(); }, setActive(value) { active = Boolean(value); }, hide() { /* Wall-clock deadlines deliberately continue while another view is open. */ } };
})(typeof window !== 'undefined' ? window : globalThis);
