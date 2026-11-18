/* Practical next steps from observed games; no player attribution or skill scores. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiFocusView = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const e = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (x, d = 0) => finite(x) ? x.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const pct = x => finite(x) ? `${num(x * 100, 1)}%` : '—';
  const delta = x => finite(x) ? `${x > 0 ? '+' : ''}${num(x * 100, 1)} п.п.` : '—';
  const date = x => x && Number.isFinite(Date.parse(x)) ? new Date(x).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
  const dimensions = [['formats', 'Форматы'], ['forms', 'Приёмы'], ['authors', 'Авторы'], ['handouts', 'Раздатка']];
  const bandLabel = row => ({ hard: '<20%', challenge: '20–<40%', middle: '40–<60%', accessible: '≥60%' }[row?.id] || row?.label || '—');
  const state = { dimension: 'authors', category: '', band: '', showSmall: false, allMisses: false, trainMessage: '' };
  const safeUrl = value => /^https:\/\/gotquestions\.online\/(question|pack)\/\d+(?:[?#].*)?$/.test(String(value || '')) ? value : '';

  function windowCard(window, label, tone) {
    return `<div class="focus-window ${tone}"><span>${label}</span><strong>${date(window?.from)} <i>—</i> ${date(window?.to)}</strong><small>${num(window?.games)} турниров · средний B <b>${num(window?.meanB)}</b> · ${num(window?.performanceGames)} с B</small></div>`;
  }

  function bandTable(rows) {
    return `<table class="focus-band-table"><thead><tr><th>Взятие поля</th><th>Раньше · команда</th><th>Сейчас · команда</th><th>Изменение</th><th>Поле · раньше</th><th>Поле · сейчас</th></tr></thead><tbody>${rows.map(r => `<tr><td data-sort-value="${e(bandLabel(r))}"><button type="button" class="focus-text-link" data-focus-band="${e(r.id)}">${e(bandLabel(r))} ↗</button></td><td data-sort-value="${r.first?.teamRate ?? ''}">${pct(r.first?.teamRate)}<span class="table-sub">${num(r.first?.takes)} / ${num(r.first?.questions)} · ${num(r.first?.games)} игр</span></td><td data-sort-value="${r.last?.teamRate ?? ''}">${pct(r.last?.teamRate)}<span class="table-sub">${num(r.last?.takes)} / ${num(r.last?.questions)} · ${num(r.last?.games)} игр</span></td><td data-sort-value="${r.available && finite(r.deltaTeam) ? r.deltaTeam : ''}" class="${r.available && r.deltaTeam > 0 ? 'green' : ''}">${r.available ? delta(r.deltaTeam) : '<span class="focus-low-sample">мало вопросов</span>'}</td><td data-sort-value="${r.first?.fieldRate ?? ''}">${pct(r.first?.fieldRate)}</td><td data-sort-value="${r.last?.fieldRate ?? ''}">${pct(r.last?.fieldRate)}</td></tr>`).join('')}</tbody></table>`;
  }

  function atlasOptions(atlas, context) {
    const rows = atlas.bands || [], o = context.base();
    o.grid = { left: 112, right: 30, top: 23, bottom: 40 };
    o.xAxis = { ...o.xAxis, type: 'value', min: 0, max: 100, interval: 20, axisLabel: { ...o.xAxis?.axisLabel, formatter: '{value}%' } };
    o.yAxis = { type: 'category', inverse: true, data: rows.map(r => `Поле ${bandLabel(r)}`), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { fontSize: 10, color: '#66785c' }, splitLine: { show: true, lineStyle: { color: '#edf0e5', type: 'dashed' } } };
    o.tooltip = { ...o.tooltip, trigger: 'item', formatter: p => {
      const r = rows[p.data?.[1]]; if (!r) return '';
      return `<b>Поле: ${e(bandLabel(r))}</b><br>Раньше: <b>${pct(r.first?.teamRate)}</b> · ${num(r.first?.takes)} / ${num(r.first?.questions)} вопросов<br>Сейчас: <b>${pct(r.last?.teamRate)}</b> · ${num(r.last?.takes)} / ${num(r.last?.questions)} вопросов<br>Изменение взятия команды: ${r.available ? delta(r.deltaTeam) : 'недостаточно вопросов'}<br>Поле на этих же вопросах: ${pct(r.first?.fieldRate)} → ${pct(r.last?.fieldRate)}<br><small>Нажмите для подробностей. Это доли взятия, не перфоманс.</small>`;
    } };
    const points = key => rows.flatMap((r, i) => finite(r[key]?.teamRate) ? [[r[key].teamRate * 100, i]] : []);
    o.series = [{ name: 'Изменение взятия', type: 'custom', silent: false, tooltip: { show: false }, data: rows.flatMap((r, i) => r.available && finite(r.first?.teamRate) && finite(r.last?.teamRate) ? [[r.first.teamRate * 100, i, r.last.teamRate * 100]] : []), renderItem: (params, api) => {
      const first = api.coord([api.value(0), api.value(1)]), last = api.coord([api.value(2), api.value(1)]);
      return { type: 'line', shape: { x1: first[0], y1: first[1], x2: last[0], y2: last[1] }, style: { stroke: '#becbb1', lineWidth: 5, lineCap: 'round' } };
    } }, { name: 'Раньше', type: 'scatter', data: points('first'), symbolSize: 11, itemStyle: { color: '#c0c8b4', borderColor: '#fffefa', borderWidth: 2 }, emphasis: { scale: 1.4 }, z: 3 }, { name: 'Сейчас', type: 'scatter', data: points('last'), symbolSize: 13, itemStyle: { color: context.colors?.red || '#d95140', borderColor: '#fffefa', borderWidth: 2 }, emphasis: { scale: 1.4 }, z: 4 }];
    return o;
  }

  function atlasMarkup(atlas, selectedBand) {
    if (!atlas?.available) return `<article class="panel focus-atlas"><div class="eyebrow muted">01 / КАРТА ИЗМЕНЕНИЙ</div><h3>Два отрезка одной истории</h3><div class="focus-empty"><span>↔</span><p>Для сравнения нужны два непересекающихся отрезка хотя бы по 5 турниров с известными датами.</p><small>Расширьте фильтр года, формата или состава, чтобы собрать оба отрезка.</small></div></article>`;
    const bands = atlas.bands || [], notable = bands.filter(r => r.available && finite(r.deltaTeam)).slice().sort((a, b) => Math.abs(b.deltaTeam) - Math.abs(a.deltaTeam))[0];
    const band = bands.find(r => r.id === selectedBand) || notable || bands[0];
    return `<article class="panel focus-atlas"><div class="panel-head wrap"><div><div class="eyebrow muted">01 / КАРТА ИЗМЕНЕНИЙ</div><h3>На каких вопросах меняется взятие</h3></div><span class="pill">Два отрезка по ${num(atlas.size)} игр</span></div><p class="chart-note">Сравните ранний и последний отрезки выбранной истории. Полосы разделяют вопросы по доле ответивших соперников; рядом — B команды на тех же отрезках.</p><div class="focus-windows">${windowCard(atlas.first, 'РАНЬШЕ', 'early')}${windowCard(atlas.last, 'СЕЙЧАС', 'recent')}</div><div id="focusAtlasChart" class="chart focus-atlas-chart" role="img" aria-label="Доли взятия команды на раннем и последнем отрезках по взятию поля"></div><div class="focus-chart-legend"><span><i class="early"></i> Раньше</span><span><i class="recent"></i> Сейчас</span><small>Нажмите полосу или выберите диапазон</small></div><div class="focus-chips" role="group" aria-label="Диапазон взятия поля">${bands.map(r => `<button type="button" data-focus-band="${e(r.id)}" class="${band?.id === r.id ? 'active' : ''}" aria-pressed="${band?.id === r.id}">${e(bandLabel(r))}</button>`).join('')}</div>${band ? `<div class="focus-band-story"><div><span>КОМАНДА · ПОЛЕ ${e(bandLabel(band))}</span><strong>${band.available ? delta(band.deltaTeam) : 'Пока мало вопросов'}</strong></div><p>${band.available ? `Наше взятие: ${pct(band.first.teamRate)} → ${pct(band.last.teamRate)}. Поле на этих же вопросах: ${pct(band.first.fieldRate)} → ${pct(band.last.fieldRate)}.` : `Для линии изменения нужно хотя бы 15 вопросов на каждом отрезке. Сейчас ${num(band.first?.questions)} и ${num(band.last?.questions)}.`}<small>Разные пакеты, соперники и составы. Изменение доли взятия описывает эти игры; перфоманс измеряем баллом B.</small></p></div>` : ''}<details class="focus-details"><summary>Все числа карты</summary><div class="table-wrap">${bandTable(bands)}</div></details><p class="tiny-note">Учитываем только неснятые вопросы с известным ответом команды и минимум 30 ответами соперников. Среднее поля — среднее долей по тем же вопросам. Даты — начало окон турниров, а не дата отыгрыша. Между отрезками могут оставаться игры; отрезки не пересекаются.</p></article>`;
  }

  function sourceTable(rows) {
    if (!rows.length) return '<div class="focus-empty compact"><p>В этой подборке пока нет подходящих вопросов.</p></div>';
    return `<table><thead><tr><th>Турнир</th><th>№</th><th>Взятие поля</th><th>Соперников</th><th>Авторы и источник</th></tr></thead><tbody>${rows.map(q => {
      const url = safeUrl(q.sourceUrl);
      return `<tr><td class="table-title" data-sort-value="${e(q.tournamentName)}"><button type="button" class="focus-text-link" data-focus-tournament="${e(q.tournamentId)}">${e(q.tournamentName)} ↗</button><span class="table-sub">${date(q.date)}</span></td><td class="number" data-sort-value="${q.number}">${num(q.number)}</td><td class="number" data-sort-value="${q.fieldRate ?? ''}">${pct(q.fieldRate)}</td><td class="number" data-sort-value="${q.fieldCount ?? ''}">${num(q.fieldCount)}</td><td data-sort-value="${e(q.authors?.map(a => a.name).join(', ') || '')}">${e(q.authors?.map(a => a.name).join(', ') || 'Автор не указан')}${url ? `<span class="table-sub"><a href="${e(url)}" target="_blank" rel="noopener noreferrer">Вопрос на GotQuestions ↗</a></span>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function opportunityRows(opportunities, ui) {
    return (opportunities?.[ui.dimension] || []).filter(r => ui.showSmall || r.eligible).slice().sort((a, b) => b.misses - a.misses || b.questions - a.questions || a.label.localeCompare(b.label, 'ru'));
  }

  function opportunitiesMarkup(opportunities, coverage, ui) {
    const rows = opportunityRows(opportunities, ui), current = rows.find(r => r.key === ui.category) || rows[0], summary = opportunities?.summary || {};
    const missed = current?.missed || [], shown = ui.allMisses ? missed : missed.slice(0, 15);
    const canTrain = !!current?.trainingQuestionIds?.length;
    return `<article class="panel focus-practice"><div class="panel-head wrap"><div><div class="eyebrow muted">02 / СЛЕДУЮЩАЯ ТРЕНИРОВКА</div><h3>Начать с того, что было доступно</h3></div><div class="focus-accessible-total"><b>${num(summary.matchedMisses)}</b><span>не взяли из ${num(summary.matchedQuestions)}<br>вопросов с полем ≥60%</span></div></div><p class="chart-note">Выберите группу потерь и перейдите к новым вопросам её авторов. Для групп ниже берём только проверенные сопоставления GotQuestions. Во всём срезе — ${num(summary.misses)} потерь из ${num(summary.questions)} доступных вопросов; ${num(summary.matchedMisses)} потерь сопоставлены.</p><div class="focus-practice-toolbar"><div class="focus-chips" role="group" aria-label="Группировка точек практики">${dimensions.map(([id, label]) => `<button type="button" data-focus-dimension="${id}" class="${ui.dimension === id ? 'active' : ''}" aria-pressed="${ui.dimension === id}">${label}</button>`).join('')}</div><label class="focus-small-toggle"><input type="checkbox" id="focusShowSmall"${ui.showSmall ? ' checked' : ''}> Показывать малые группы</label></div>${rows.length ? `<div class="focus-practice-grid"><div class="focus-category-list" role="group" aria-label="Выбор группы для практики">${rows.map(r => `<button type="button" data-focus-category="${e(r.key)}" class="${r.key === current?.key ? 'active' : ''}" aria-pressed="${r.key === current?.key}"><span>${e(r.label)}${!r.eligible ? '<small>мало наблюдений</small>' : ''}</span><b>${num(r.misses)}<small>потерь / ${num(r.questions)}</small></b></button>`).join('')}</div><div class="focus-category-detail"><span class="focus-detail-kicker">ВЫБРАННЫЙ ФОКУС</span><h4>${e(current.label)}</h4><div class="focus-category-number"><strong>${num(current.misses)}</strong><span>доступных вопросов<br>не взяли</span></div><p>Взяли ${num(current.takes)} из ${num(current.questions)} на ${num(current.games)} турнирах. Наше взятие ${pct(current.teamRate)}, поле ${pct(current.fieldRate)}.</p>${!current.eligible ? '<p class="focus-sample-note">Малая группа: меньше 10 вопросов или 3 турниров. Это список для разбора, оснований для вывода о навыке мало.</p>' : ''}<button type="button" id="focusTrain" class="focus-train-button"${canTrain ? '' : ' disabled'}>${e(current.trainingLabel || 'Вопросы этих авторов')} <span>↗</span></button><small>${canTrain ? `${num(current.trainingCount)} вопросов из годового банка. Подтверждённые сыгранные вопросы и пакеты исключены; возможны повторы из несопоставленных игр.` : 'В годовом банке нет новых вопросов с известными авторами этих потерь.'}</small><p class="focus-training-note">Подбор по авторам пропущенных вопросов. В тренировке могут быть другие форматы и приёмы; одинаковый автор не означает одинаковую тему или сложность.</p><div class="focus-action-message" id="focusTrainMessage" role="status">${e(ui.trainMessage)}</div></div></div><details class="focus-details" open><summary>Какие вопросы привели к этому фокусу · ${num(missed.length)}</summary><p class="tiny-note">Ссылки GotQuestions открывают вопрос вместе с ответом. В таблице показаны ${num(shown.length)} из ${num(missed.length)}.</p><div class="table-wrap focus-source-table">${sourceTable(shown)}</div>${missed.length > 15 ? `<button type="button" id="focusAllMisses" class="focus-more">${ui.allMisses ? 'Свернуть до 15' : 'Показать все ' + num(missed.length)}</button>` : ''}</details>` : `<div class="focus-empty compact"><span>◎</span><p>Для этих групп пока не хватает наблюдений.</p><small>Покажите малые группы или расширьте фильтры. Для обычного списка нужно 10 вопросов хотя бы на 3 турнирах.</small></div>`}<p class="tiny-note">Метаданные покрывают ${num(coverage.matchedGames)} из ${num(coverage.games)} турниров выбранного среза. Группы авторов и приёмов могут пересекаться. Число потерь помогает выбрать материал для разбора; оно не оценивает силу навыка.</p></article>`;
  }

  function rhythmMarkup(rhythm) {
    if (!rhythm?.available) return `<article class="panel focus-rhythm"><div class="eyebrow muted">03 / РИТМ ТУРА</div><h3>Что происходит к концу тура</h3><div class="focus-empty compact"><span>≋</span><p>Пока мало сопоставимых вопросов в начале и конце туров.</p><small>Нужно по 15 доступных вопросов хотя бы на 3 турнирах в каждой части. Вопросы без известной длины тура исключены.</small></div></article>`;
    return `<article class="panel focus-rhythm"><div class="eyebrow muted">03 / РИТМ ТУРА</div><h3>Удерживаем ли доступные вопросы к финишу</h3><p class="chart-note">Первая и последняя треть официальных туров. Только вопросы с взятием поля ≥60% и минимум 30 ответами соперников.</p><div class="focus-rhythm-track">${[['first', 'ПЕРВАЯ ТРЕТЬ'], ['last', 'ПОСЛЕДНЯЯ ТРЕТЬ']].map(([key, label]) => `<div><span>${label}</span><strong>${pct(rhythm[key]?.teamRate)}</strong><div class="focus-meter" aria-hidden="true"><i style="width:${finite(rhythm[key]?.teamRate) ? Math.max(0, Math.min(100, rhythm[key].teamRate * 100)) : 0}%"></i></div><small>${num(rhythm[key]?.takes)} / ${num(rhythm[key]?.questions)} · ${num(rhythm[key]?.games)} турниров<br>Поле ${pct(rhythm[key]?.fieldRate)}</small></div>`).join('<span class="focus-rhythm-arrow" aria-hidden="true">→</span>')}</div><div class="focus-rhythm-delta"><strong>${delta(rhythm.difference)}</strong><span>последняя треть к первой<br>поле: ${delta(rhythm.lastMinusFirstField)}</span></div><p class="tiny-note">Доли относятся к разным вопросам; середина тура исключена. Порядок вопросов, их сложность и состав могли влиять на результат. Этот срез не измеряет усталость.</p></article>`;
  }

  function rareMarkup(rareWins) {
    const rows = (rareWins?.items || []).slice(0, 4);
    return `<article class="panel focus-rare"><div class="eyebrow muted">04 / СОХРАНИТЬ УДАЧНЫЕ РЕШЕНИЯ</div><h3>Коллекция редких взятий</h3><p class="chart-note">Вопросы, которые взяли мы и не более 20% соперников. Минимум 30 известных ответов поля.</p>${rows.length ? `<div class="focus-rare-list">${rows.map((q, i) => `<div class="focus-rare-item"><div class="focus-rare-seal" aria-hidden="true">${String(i + 1).padStart(2, '0')}</div><div><button type="button" class="focus-text-link" data-focus-tournament="${e(q.tournamentId)}">${e(q.tournamentName)} ↗</button><span>Вопрос ${num(q.number)} · ${date(q.date)}</span></div><strong>${pct(q.fieldRate)}<small>взяло поле</small></strong></div>`).join('')}</div><p class="focus-rare-prompt">Вспомните ход обсуждения: какая версия сдвинула мысль, кто связал детали, как выбрали ответ. Короткая заметка после игры помогает сохранить удачный приём.</p>` : '<div class="focus-empty compact"><span>✦</span><p>В выбранном срезе нет взятий с таким порогом поля.</p></div>'}</article>`;
  }

  function markup(stats, ui = state) {
    const c = stats.coverage || {}, summary = stats.opportunities?.summary || {};
    return `<div class="focus-hero"><div class="focus-hero-copy"><div class="eyebrow">ПЛАН СЛЕДУЮЩЕГО ШАГА</div><h3>Вернуть доступное.<br><em>Закрепить редкое.</em></h3><p>След истории ведёт к материалу для новой тренировки. Выберите наблюдение, проверьте конкретные вопросы и попробуйте авторов в новой подборке.</p><div class="focus-hero-ledger"><span><b>${num(c.comparableQuestions)}</b> вопросов для карты</span><span><b>${num(summary.matchedMisses)}</b> доступных потерь с метаданными</span></div></div><div class="focus-target" aria-hidden="true"><div><span>観</span><small>наблюдать</small></div><i class="focus-target-dot"></i><b>01 — 04</b></div></div><div id="focusMistakesRoot"></div>${atlasMarkup(stats.atlas, ui.band)}${opportunitiesMarkup(stats.opportunities, c, ui)}<div class="focus-bottom-grid">${rhythmMarkup(stats.rhythm)}${rareMarkup(stats.rareWins)}</div><div class="focus-source-note">Карта и ритм используют повопросные маски рейтинга; авторы, форматы и приёмы — только точно сопоставленные записи GotQuestions. Здесь нет оценок личного вклада или доказательства причин. Глобальные фильтры меняют весь раздел.</div>`;
  }

  function render(context) {
    const mount = root.document?.querySelector('#focusRoot'); if (!mount) return;
    const Core = root.SamuraiFocusCore;
    if (!Core?.build) { mount.innerHTML = '<div class="notice">Не удалось загрузить расчёты фокуса команды.</div>'; return; }
    const stats = Core.build({ selected: context.selected, playedData: context.playedData, trainingData: context.trainingData });
    const refresh = () => render(context);
    state.trainMessage = '';
    mount.innerHTML = markup(stats, state);
    root.SamuraiMistakesView?.render({ mount: mount.querySelector('#focusMistakesRoot'), data: stats.mistakes, onTrain: context.onTrain, openTournament: context.openTournament });
    mount.querySelectorAll('[data-focus-band]').forEach(button => button.onclick = () => { state.band = button.dataset.focusBand; refresh(); });
    mount.querySelectorAll('[data-focus-dimension]').forEach(button => button.onclick = () => { state.dimension = button.dataset.focusDimension; state.category = ''; state.allMisses = false; state.trainMessage = ''; refresh(); });
    mount.querySelectorAll('[data-focus-category]').forEach(button => button.onclick = () => { state.category = button.dataset.focusCategory; state.allMisses = false; state.trainMessage = ''; refresh(); });
    mount.querySelectorAll('[data-focus-tournament]').forEach(button => button.onclick = () => context.openTournament?.(button.dataset.focusTournament));
    const small = mount.querySelector('#focusShowSmall'); if (small) small.onchange = event => { state.showSmall = event.target.checked; state.category = ''; state.allMisses = false; refresh(); };
    const more = mount.querySelector('#focusAllMisses'); if (more) more.onclick = () => { state.allMisses = !state.allMisses; refresh(); };
    const train = mount.querySelector('#focusTrain');
    if (train) train.onclick = () => {
      const rows = opportunityRows(stats.opportunities, state), current = rows.find(r => r.key === state.category) || rows[0];
      if (!current?.trainingQuestionIds?.length || typeof context.onTrain !== 'function') return;
      const accepted = context.onTrain({ questionIds: current.trainingQuestionIds.slice(), authors: (current.authorIds || []).slice(), format: 'kvrm', focusLabel: current.label });
      if (accepted === false) { state.trainMessage = 'У вас есть незавершённая тренировка. Завершите её и вернитесь к этому фокусу.'; const message = mount.querySelector('#focusTrainMessage'); if (message) message.textContent = state.trainMessage; }
    };
    if (stats.atlas?.available && context.chart) context.chart('focusAtlasChart', atlasOptions(stats.atlas, context), p => { const row = stats.atlas.bands?.[p.data?.[1]]; if (row) { state.band = row.id; refresh(); } });
  }
  return { render, markup, atlasOptions, sourceTable, opportunityRows };
});
