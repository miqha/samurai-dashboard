/* Tournament debrief -> strictly matched new questions; no answer spoilers. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiMistakesView = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const e = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const n = (x, digits = 0) => finite(x) ? x.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const pct = x => finite(x) ? `${n(x * 100, 1)}%` : '—';
  const pp = x => finite(x) ? `${x > 0 ? '+' : ''}${n(x * 100, 1)} п.п.` : '—';
  const date = x => x && Number.isFinite(Date.parse(x)) ? new Date(x).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—';
  let selectedTournamentId = '';
  const dimensions = [['all', 'Все'], ['difficulty', 'Сложность вопроса'], ['format', 'Формат'], ['forms', 'Форма ответа'], ['handout', 'Раздатка']];
  function rowsOf(data, state) {
    const rows = state.all ? data.categories || [] : data.priorities || [];
    return rows.filter(r => state.dimension === 'all' || r.dimension === state.dimension);
  }
  function currentOf(data, state) {
    const rows = rowsOf(data, state);
    return rows.find(r => r.key === state.category) || rows[0];
  }
  function tournamentSelection(bundle, state) {
    const choices = Array.isArray(bundle?.tournaments) ? bundle.tournaments : [];
    if (!choices.length) return { id: String(bundle?.tournament?.id ?? ''), report: bundle, choice: bundle?.tournament, choices };
    const chosen = choices.find(t => String(t.id) === String(state?.tournamentId))
      || choices.find(t => String(t.id) === String(bundle?.tournament?.id)) || choices[0];
    const id = String(chosen.id);
    const report = bundle.reports && Object.hasOwn(bundle.reports, id) ? bundle.reports[id]
      : { available: false, tournament: chosen, reason: 'Разбор выбранного турнира недоступен. Обновите данные.' };
    return { id, report, choice: chosen, choices };
  }
  function tournamentPicker(bundle, selection) {
    if (!selection.choices.length) return '';
    const origin = t => [t.recentPlayed ? 'последние сыгранные' : '', t.recentPublished ? 'свежие публикации' : ''].filter(Boolean).join(' + ');
    const missing = bundle?.publicationCoverage?.missingPublicationDates || 0;
    return `<div class="mistakes-picker"><label>Турнир для работы над ошибками<select data-mistakes-select aria-label="Турнир для работы над ошибками">${selection.choices.map(t => `<option value="${e(t.id)}"${String(t.id) === selection.id ? ' selected' : ''}>${e(t.name)} · ${e(origin(t))}</option>`).join('')}</select></label><p>Три последних сыгранных из опубликованных и три последних опубликованных из сыгранных. Пересечения объединены: ${n(selection.choices.length)} в списке. Игры упорядочены по началу их окон, публикации — по дате GotQuestions.</p>${missing ? `<small>У ${n(missing)} сопоставленных турниров нет подтверждённой даты публикации: они не участвуют в отборе свежих публикаций.</small>` : ''}</div>`;
  }
  function diagnosticsTable(rows) {
    return `<table><thead><tr><th>Категория</th><th>Вопросов</th><th>Взяли</th><th>Потеряли</th><th>Мы</th><th>Поле</th><th>Разница</th><th>Новых вопросов</th></tr></thead><tbody>${rows.map(r => `<tr><td><button type="button" class="focus-text-link" data-mistakes-category="${e(r.key)}">${e(r.label)} ↗</button>${r.smallSample ? '<span class="table-sub">Малая группа</span>' : ''}</td><td>${n(r.questions)}</td><td>${n(r.takes)}</td><td>${n(r.misses)}</td><td data-sort-value="${r.teamRate ?? ''}">${pct(r.teamRate)}</td><td data-sort-value="${r.fieldRate ?? ''}">${pct(r.fieldRate)}</td><td data-sort-value="${r.gap ?? ''}">${pp(r.gap)}</td><td>${n(r.trainingCount)}</td></tr>`).join('')}</tbody></table>`;
  }
  function sourceTable(rows) {
    return `<table><thead><tr><th>№</th><th>Взятие поля</th><th>Соперников</th><th>Вопрос на GotQuestions</th></tr></thead><tbody>${rows.map(q => `<tr><td>${n(q.number)}</td><td data-sort-value="${q.fieldRate ?? ''}">${pct(q.fieldRate)}</td><td>${n(q.fieldCount)}</td><td>${/^https:\/\/gotquestions\.online\/question\/\d+$/.test(String(q.sourceUrl)) ? `<a href="${e(q.sourceUrl)}" target="_blank" rel="noopener">Открыть вопрос ↗</a>` : 'Нет точной ссылки'}</td></tr>`).join('')}</tbody></table>`;
  }
  function markup(bundle, state = {}) {
    const ui = { dimension: 'all', category: '', all: false, ...state };
    const selection = tournamentSelection(bundle, ui), data = selection.report;
    const picker = tournamentPicker(bundle, selection);
    const heading = '<div class="eyebrow muted">РАБОТА НАД ОШИБКАМИ</div><h3>Игра → следующая тренировка</h3>';
    if (!data?.available) return `<article class="panel mistakes-panel"><div class="panel-head"><div>${heading}</div></div>${picker}<p class="chart-note">${e(data?.reason || 'Пока нет турнира с точным сопоставлением вопросов GotQuestions и известными ответами поля.')}</p></article>`;
    const t = data.tournament || {}, c = data.coverage || {}, s = data.summary || {};
    const rows = rowsOf(data, ui), current = currentOf(data, ui);
    const skipped = data.skippedNewer || [];
    return `<article class="panel mistakes-panel"><div class="panel-head wrap"><div>${heading}</div><span class="pill">Перфоманс B · ${n(t.performance ?? t.meanB ?? t.b)}</span></div>${picker}
      <div class="mistakes-tournament"><div><button type="button" class="focus-text-link" data-mistakes-tournament="${e(t.id ?? t.tournamentId)}">${e(t.name)} ↗</button><span>${date(t.date)} · дата начала окна${selection.choice?.publishedAt ? `<br>Опубликован на GotQuestions: ${date(selection.choice.publishedAt)}` : selection.choices.length ? '<br>Дата публикации не указана' : ''}</span></div><div><b>${n(s.takes)} / ${n(s.questions)}</b><span>взяли в сопоставимом срезе</span></div></div>
      ${skipped.length ? `<p class="mistakes-coverage-note">Более новых турниров без доступного точного разбора: ${n(skipped.length)}. Последний — ${e(skipped[0].name)}. В списке доступны турниры с точно сопоставленными вопросами.</p>` : ''}
      ${!data.priorities?.length ? `<p class="mistakes-positive-note">${(data.categories || []).some(r => r.weak) ? 'Отклонения ниже поля есть только в группах из 1–2 вопросов: этого мало для приоритета.' : 'В этой игре ни одна сопоставимая категория не оказалась ниже поля.'} Можно выбрать категорию для закрепления; это не диагностированная слабость команды.</p>` : ''}
      <p class="chart-note">${data.priorities?.length ? 'Выберите категорию, в которой взятие оказалось ниже поля.' : 'Разберите пропуски и выберите материал для практики.'} На одних и тех же вопросах сравниваем долю команды и среднюю долю остальных команд; минимум 30 известных ответов соперников. Это разбор конкретной игры, а не оценка устойчивого навыка.</p>
      <div class="mistakes-summary"><span>Мы <b>${pct(s.teamRate)}</b></span><span>Поле <b>${pct(s.fieldRate)}</b></span><span>Потеряли <b>${n(s.misses)}</b></span><span>Срез <b>${n(s.questions)} вопросов</b></span></div>
      <div class="focus-practice-toolbar"><div class="focus-chips" role="group" aria-label="Категории работы над ошибками">${dimensions.map(([id, label]) => `<button type="button" data-mistakes-dimension="${id}" aria-pressed="${ui.dimension === id}" class="${ui.dimension === id ? 'active' : ''}">${label}</button>`).join('')}</div><label class="focus-small-toggle"><input type="checkbox" data-mistakes-all${ui.all ? ' checked' : ''}> Все категории, включая успешные</label></div>
      ${rows.length ? `<div class="mistakes-grid"><div class="mistakes-categories" role="group" aria-label="Выбор задачи для тренировки">${rows.map(r => `<button type="button" data-mistakes-category="${e(r.key)}" aria-pressed="${current?.key === r.key}" class="${current?.key === r.key ? 'active' : ''}"><span>${e(r.label)}<small>${n(r.takes)} / ${n(r.questions)} · ${r.smallSample ? 'малая группа' : 'вопросов'}</small></span><b>${pp(r.gap)}<small>к полю</small></b></button>`).join('')}</div>
      <div class="mistakes-mission"><div class="eyebrow muted">ФОКУС ЭТОГО ПОДХОДА</div><h4>${e(current.label)}</h4><div class="mistakes-bars">${[['teamRate', 'Мы'], ['fieldRate', 'Поле']].map(([key, label]) => `<div><span>${label}</span><div aria-hidden="true"><i style="width:${finite(current[key]) ? Math.max(0, Math.min(100, current[key] * 100)) : 0}%"></i></div><b>${pct(current[key])}</b></div>`).join('')}</div><p>Взяли ${n(current.takes)} из ${n(current.questions)}; не взяли ${n(current.misses)}. ${current.smallSample ? 'Мало вопросов: используйте наблюдение как повод для практики, а не вывод о слабости команды.' : 'Группы могут пересекаться; складывать их потери нельзя.'}</p><ol class="mistakes-plan"><li><b>Разобрать</b> исходные пропуски</li><li><b>Сыграть</b> новые вопросы этой категории</li><li><b>Проверить</b> ответы и время после финиша</li></ol><button type="button" class="focus-train-button" data-mistakes-train${current.trainingQuestionIds?.length ? '' : ' disabled'}>Тренировать категорию <span>↗</span></button><small>${n(current.trainingCount)} новых вопросов в годовом банке. В подходе — до 10, повторы из вашей истории тренажёра исключаются.</small><p class="mistakes-match-note">${e(current.trainingExplanation || 'Только вопросы с подтверждёнными признаками этой категории. Условия не расширяются при нехватке вопросов.')}</p><div class="focus-action-message" data-mistakes-message role="status"></div></div></div>
      <details class="focus-details"><summary>Исходные пропуски выбранной категории · ${n(current.missed?.length || 0)}</summary><p class="tiny-note">Ссылки раскрывают ответы на GotQuestions. В тренировке будут другие вопросы.</p><div class="table-wrap">${sourceTable(current.missed || [])}</div></details>` : `<div class="focus-empty compact"><p>${ui.all ? 'В этой категории нет сопоставимых вопросов.' : 'В этой группе нет категорий со взятием ниже поля и пропусками.'}</p><small>Можно открыть все категории или выбрать другую группу.</small></div>`}
      <details class="focus-details"><summary>Все числа выбранной игры · ${n(data.categories?.length || 0)} категорий</summary><div class="table-wrap">${diagnosticsTable(data.categories || [])}</div></details>
      <p class="tiny-note">Подтверждённые сыгранные вопросы и связанные пакеты исключены из подбора; из несопоставленных игр возможны неизвестные повторы. Сложность отдельного вопроса определяем по взятию поля, trueDL — характеристика целого пакета. ${e(c.note || '')}</p></article>`;
  }
  function render(context) {
    const mount = context.mount; if (!mount) return;
    const initial = tournamentSelection(context.data, { tournamentId: selectedTournamentId });
    const ui = context.state || { dimension: 'all', category: '', all: !initial.report?.priorities?.length, tournamentId: initial.id };
    const selection = tournamentSelection(context.data, ui), data = selection.report;
    ui.tournamentId = selection.id;
    if (selection.choices.length) selectedTournamentId = selection.id;
    mount.innerHTML = markup(context.data, ui);
    const refresh = () => render({ ...context, state: ui });
    const picker = mount.querySelector('[data-mistakes-select]');
    if (picker) picker.onchange = event => {
      const id = String(event.target.value);
      if (!selection.choices.some(t => String(t.id) === id)) return;
      const next = tournamentSelection(context.data, { tournamentId: id });
      selectedTournamentId = id; ui.tournamentId = id; ui.category = ''; ui.dimension = 'all'; ui.all = !next.report?.priorities?.length;
      refresh();
    };
    mount.querySelectorAll('[data-mistakes-dimension]').forEach(button => button.onclick = () => { ui.dimension = button.dataset.mistakesDimension; ui.category = ''; refresh(); });
    mount.querySelectorAll('[data-mistakes-category]').forEach(button => button.onclick = () => { const row = data?.categories?.find(r => r.key === button.dataset.mistakesCategory); if (!row) return; if (!rowsOf(data, ui).some(r => r.key === row.key)) { ui.all = true; ui.dimension = 'all'; } ui.category = row.key; refresh(); });
    const all = mount.querySelector('[data-mistakes-all]'); if (all) all.onchange = event => { ui.all = event.target.checked; ui.category = ''; refresh(); };
    mount.querySelectorAll('[data-mistakes-tournament]').forEach(button => button.onclick = () => context.openTournament?.(button.dataset.mistakesTournament));
    const train = mount.querySelector('[data-mistakes-train]');
    if (train) train.onclick = () => {
      const row = currentOf(data, ui); if (!row?.trainingQuestionIds?.length) return;
      const accepted = context.onTrain?.(row.preset || { questionIds: row.trainingQuestionIds.slice(), focusKind: 'mistakes', focusLabel: row.label, focusDescription: row.trainingExplanation });
      if (accepted === false || accepted?.accepted === false) { const node = mount.querySelector('[data-mistakes-message]'); if (node) node.textContent = 'У вас есть незавершённая тренировка. Завершите её и вернитесь к разбору.'; }
    };
  }
  return { markup, render, diagnosticsTable, rowsOf, currentOf, tournamentSelection };
});
