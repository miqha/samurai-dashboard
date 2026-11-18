/* Personal profiles describe the team's games with a player in the roster. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiPersonalView = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const num = (value, digits = 0) => finite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const date = value => value ? new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }) : '—';
  const shortDate = value => value ? new Date(value).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit', timeZone: 'Europe/Moscow' }) : '';
  const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${num(value)}` : '—';
  const interval = row => finite(row.lower) && finite(row.upper) ? `${num(row.lower)} – ${num(row.upper)}` : 'не рассчитан';
  const small = count => count < 3 ? '<span class="sample-small">мало игр</span>' : '';
  let minCommonGames = 3;

  function kpi(label, value, note) {
    return `<article class="kpi"><div class="kpi-label">${e(label)}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${e(note)}</div></article>`;
  }

  function render(context) {
    const doc = root.document;
    const mount = doc && doc.querySelector('#personalRoot');
    if (!mount) return;
    const P = root.SamuraiPersonalStats, A = root.SamuraiStats, R = root.SamuraiRosterStats;
    if (!P || !A || !R) { delete mount.dataset.personalToolbarKey; mount.innerHTML = '<div class="notice">Не удалось загрузить статистику профиля. Проверьте, что рядом с HTML есть файлы личной статистики.</div>'; return; }
    const all = context.allTournaments || [], players = P.registry(all, A).slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const years = [...new Set(all.filter(t => t.included !== false).map(t => String(t.date || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
    const playerId = String(context.playerId || ''), year = String(context.year || 'all');
    // Keep focused selects alive while their change callbacks redraw a profile.
    // Only an actual change of available names/years recreates the toolbar.
    const toolbarKey = JSON.stringify([players.map(p => [p.id, p.name]), years]);
    if (mount.dataset.personalToolbarKey !== toolbarKey) {
      mount.innerHTML = `<div class="personal-toolbar"><label class="personal-player-label">Кто вы за столом?<select id="personalPlayer"><option value="">Выберите своё имя</option>${players.map(p => `<option value="${e(p.id)}">${e(p.name)}</option>`).join('')}</select></label><label>Год выступлений<select id="personalYear"><option value="all">Вся история</option>${years.map(y => `<option value="${y}">${y} год</option>`).join('')}</select></label><span class="personal-toolbar-note">Ваш путь в составе команды<br>Перфоманс — турнирный балл B</span></div><div id="personalContent"></div>`;
      mount.dataset.personalToolbarKey = toolbarKey;
    }
    doc.querySelector('#personalPlayer').value = playerId;
    doc.querySelector('#personalYear').value = year;
    doc.querySelector('#personalPlayer').onchange = event => context.onPlayerChange(event.target.value);
    doc.querySelector('#personalYear').onchange = event => context.onYearChange(event.target.value);
    const content = doc.querySelector('#personalContent');
    if (!playerId || !players.some(p => String(p.id) === playerId)) {
      content.innerHTML = '<article class="personal-welcome"><div class="personal-enso" aria-hidden="true">◎</div><div class="eyebrow">ВАША ИСТОРИЯ ЗА СТОЛОМ</div><h3>У каждого самурая свой путь.</h3><p>Выберите имя, чтобы увидеть прогресс и свои отыгрыши за «Самурайскую самоизоляцию», а также партнёров, с которыми команда выступала успешнее.</p><span>В списке — все участники опубликованных составов команды.</span></article>';
      return;
    }
    const profile = P.profile(all, { playerId, year, type: context.type || 'all', minCommonGames }, A, R);
    const s = profile.summary, games = profile.games || [], player = profile.player;
    content.innerHTML = `<div class="personal-heading"><div><div class="eyebrow">ЛИЧНЫЙ МАРШРУТ В КОМАНДЕ</div><h3>${e(player.name)}<span class="red">.</span></h3><p>${games.length ? `${date(s.firstDate)} — ${date(s.lastDate)} · ${num(games.length)} турниров в выбранном срезе` : 'В выбранном срезе нет выступлений'}</p></div><span class="personal-identity" aria-hidden="true">${e(player.name.split(/\s+/).slice(0, 2).map(w => w[0]).join(''))}</span></div><div class="notice personal-method-note">Здесь — только выступления за «Самурайскую самоизоляцию». Все результаты принадлежат команде на турнирах с вашим участием в заявленном составе. Личные ответы и вклад отдельного игрока протокол не фиксирует.</div>`;
    if (!games.length) {
      content.insertAdjacentHTML('beforeend', '<article class="personal-empty"><span aria-hidden="true">∅</span><h3>В этом году или формате игр пока нет</h3><p>Выберите другой год или формат. Имя остаётся выбранным.</p></article>');
      return;
    }
    const recent = profile.recent, rated = s.performanceGames;
    const recentNote = recent.eligible ? `Последние 5 против предыдущих 5 игр с B` : `Нужно 10 игр с B; сейчас ${num(recent.ratedGames)}`;
    const best = profile.best;
    const allTeammates = profile.teammates || [];
    const visibleTeammates = () => allTeammates.filter(t => t.performanceGames >= minCommonGames).slice().sort((a, b) => (finite(b.mean) ? b.mean : -Infinity) - (finite(a.mean) ? a.mean : -Infinity) || b.performanceGames - a.performanceGames || a.name.localeCompare(b.name, 'ru'));
    const teammates = visibleTeammates();
    const history = games.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
    content.insertAdjacentHTML('beforeend', `<div class="kpi-grid personal-kpis" id="personalKpis">${kpi('Турниров в составе', num(s.games), `${num(rated)} с известным баллом B`)}${kpi('Средний перфоманс B', num(s.avgPerformance), `95% ДИ среднего: ${interval(profile.interval)}`)}${kpi('Медианный перфоманс B', num(s.medianPerformance), 'Середина результатов игр с B')}${kpi('Изменение формы', signed(recent.delta), recentNote)}</div>
      <div class="grid two-one personal-progress-grid"><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ПРОГРЕСС В ВЫСТУПЛЕНИЯХ</div><h3>Каждая игра продолжает историю</h3></div><span class="pill">B · выше лучше</span></div><p class="chart-note">Результат команды с вами в составе. Пунктир — среднее последних 5 игр с известным B; нажмите точку для разбора.</p><div id="personalTrendChart" class="chart personal-trend" role="img" aria-label="Динамика перфоманса команды с выбранным игроком"></div><div class="chart-footer"><span class="legend"><i class="red-bg"></i> Перфоманс B <i class="gray-bg"></i> Последние 5 игр с B</span><span>Выделите область для увеличения</span></div><p class="tiny-note">${num(rated)} из ${num(s.games)} игр с B. Пропуски не заменяем нулём; среднее пропускает игры без B. Даты — начало окон турниров.</p></article>
      <article class="panel personal-best"><div class="eyebrow">ЛУЧШЕЕ ВЫСТУПЛЕНИЕ В СРЕЗЕ</div><div class="personal-best-symbol" aria-hidden="true">✦</div>${best ? `<div class="personal-best-value">${num(best.performance)}<small>баллов B</small></div><h3>${e(best.name)}</h3><p>${date(best.date)} · ${e(best.typeName || '')}</p><p>Место ${num(best.position, 1)} из ${num(best.fieldSize)}</p><button type="button" class="personal-best-button" data-tournament="${e(best.id)}">Разобрать выступление <span>↗</span></button>` : '<h3>Перфоманс пока не опубликован</h3><p>Отыгрыши доступны в таблице ниже.</p>'}</article></div>
      <div class="grid equal personal-detail-grid"><article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ГОДЫ И ОПЫТ</div><h3>Ваш ритм по сезонам</h3></div></div><p class="chart-note">Средний B по календарному году в выбранном срезе. Число игр и 95% ДИ — в подсказке.</p><div id="personalYearChart" class="chart" role="img" aria-label="Средний перфоманс команды с выбранным игроком по годам"></div><p class="tiny-note">График следует выбранному году и формату. Межсезонные сравнения описательные.</p></article><article class="panel personal-experience"><div class="eyebrow muted">ВАШИ ОТЫГРЫШИ В ДЕТАЛЯХ</div><h3>В каком ритме играли</h3><div class="personal-extra-metrics"><div><b>${num(s.officialScore)}</b><span>взято всей командой<br>на ваших турнирах</span></div><div><b>${num(s.podiums)}</b><span>мест в первой тройке<br>в общем зачёте</span></div></div><div class="personal-formats">${(profile.formats || []).map(f => `<div><span>${e(f.name)}</span><strong>${num(f.games)} игр</strong><small>B ${num(f.mean)} · ${num(f.performanceGames)} с оценкой</small></div>`).join('')}</div><p class="tiny-note">Каждая игра имеет одинаковый вес. Формат и состав могут меняться вместе с силой команды.</p></article></div>
      <article class="panel"><div class="panel-head wrap"><div><div class="eyebrow muted">ЛУЧШИЕ ТИММЕЙТЫ ПО СОВМЕСТНОМУ B</div><h3>С кем складывались выступления</h3></div><label class="personal-threshold">Совместных игр с B<select id="personalMinGames"><option value="3"${minCommonGames === 3 ? ' selected' : ''}>Не менее 3</option><option value="1"${minCommonGames === 1 ? ' selected' : ''}>Все · от 1 игры</option></select></label></div><p class="chart-note">Порядок — по среднему перфомансу всей команды в ваших общих играх. 95% ДИ оценивает неопределённость среднего. Это связь, а не рейтинг личного вклада.</p><div id="personalTeammateTable" class="table-wrap">${teammateTable(teammates)}</div><p class="tiny-note" id="personalTeammatesCoverage">${num(teammates.length)} из ${num(allTeammates.length)} партнёров. Порог относится к играм с известным B, не ко всем заявкам. При одной игре ДИ не рассчитывается; при 1–2 играх отмечаем малую выборку. Строки пересекаются — их нельзя складывать.</p></article>
      <article class="panel"><div class="panel-head"><div><div class="eyebrow muted">ВАШ АРХИВ</div><h3>Все отыгрыши в выбранном срезе</h3></div><span class="pill">${num(games.length)} турниров</span></div><p class="chart-note">От новых к первым. Нажмите на турнир, чтобы открыть вопросы, состав и полный результат.</p><div id="personalHistory" class="table-wrap">${context.tournamentTable(history, false)}</div></article>`);
    const teammateTableNode = doc.querySelector('#personalTeammateTable');
    doc.querySelector('#personalMinGames').onchange = event => {
      minCommonGames = event.target.value === '1' ? 1 : 3;
      const visible = visibleTeammates();
      teammateTableNode.innerHTML = teammateTable(visible);
      doc.querySelector('#personalTeammatesCoverage').textContent = `${num(visible.length)} из ${num(allTeammates.length)} партнёров. Порог относится к играм с известным B, не ко всем заявкам. При одной игре ДИ не рассчитывается; при 1–2 играх отмечаем малую выборку. Строки пересекаются — их нельзя складывать.`;
    };
    teammateTableNode.onclick = event => { const target = event.target.closest('[data-personal-player]'); if (target) context.onPlayerChange(target.dataset.personalPlayer); };
    drawTrend(profile, context);
    drawYears(profile, context);
  }

  function teammateTable(rows) {
    if (!rows.length) return '<div class="no-data">Партнёров с таким числом совместных игр с B пока нет. Выберите «Все · от 1 игры», чтобы увидеть небольшие выборки.</div>';
    return `<table><thead><tr><th>Тиммейт</th><th>Общих игр</th><th>Игр с B</th><th>Средний B</th><th>Медианный B</th><th title="Сортировка по нижней границе интервала">95% ДИ среднего</th></tr></thead><tbody>${rows.map(p => `<tr><td class="table-title" data-sort-value="${e(p.name)}"><button class="personal-teammate-link" type="button" data-personal-player="${e(p.id)}" title="Открыть профиль ${e(p.name)}">${e(p.name)} <span>↗</span></button>${small(p.performanceGames)}</td><td class="number" data-sort-value="${p.games}">${num(p.games)}</td><td class="number" data-sort-value="${p.performanceGames}">${num(p.performanceGames)}</td><td data-sort-value="${finite(p.mean) ? p.mean : ''}"><span class="performance-tag">${num(p.mean)}</span></td><td class="number" data-sort-value="${finite(p.median) ? p.median : ''}">${num(p.median)}</td><td class="number" data-sort-value="${finite(p.lower) ? p.lower : ''}">${interval(p)}</td></tr>`).join('')}</tbody></table>`;
  }

  function drawTrend(profile, context) {
    const rows = profile.timeline, colors = context.colors;
    if (!rows.some(t => finite(t.performance))) { root.document.querySelector('#personalTrendChart').innerHTML = '<div class="no-data">У этих отыгрышей пока нет опубликованного B.</div>'; return; }
    const o = context.base();
    o.grid = { left: 55, right: 20, top: 22, bottom: 50 };
    o.xAxis = { ...o.xAxis, data: rows.map(t => shortDate(t.date)), axisLabel: { ...o.xAxis.axisLabel, interval: Math.max(0, Math.floor(rows.length / 7)) } };
    o.yAxis = { ...o.yAxis, scale: true, name: 'Перфоманс B', nameTextStyle: { color: colors.ink, fontSize: 9 } };
    o.dataZoom = [{ type: 'inside', filterMode: 'none' }, { type: 'slider', height: 10, bottom: 0, borderColor: 'transparent', backgroundColor: '#f2f4eb', fillerColor: '#d6dfc7', handleSize: 10, showDetail: false }];
    o.tooltip.formatter = params => { const row = rows[params[0].dataIndex]; return `<b>${e(row.name)}</b><br>${date(row.date)} · ${e(row.typeName || '')}<br>Перфоманс B: <b>${num(row.performance)}</b><br>Последние 5 игр с B: ${num(row.rolling)}<br>Состав: ${num(row.rosterSize)} участников<br><small>Нажмите точку для разбора</small>`; };
    o.series = [{ name: 'Перфоманс B', type: 'line', data: rows.map(t => t.performance), smooth: .16, symbol: 'circle', symbolSize: 6, connectNulls: false, lineStyle: { color: colors.red, width: 2 }, itemStyle: { color: colors.red, borderColor: '#fffefa', borderWidth: 1 }, areaStyle: { color: '#d9514009' } }, { name: 'Последние 5 игр с B', type: 'line', data: rows.map(t => t.rolling), smooth: false, connectNulls: false, symbol: 'none', lineStyle: { color: colors.green, type: 'dashed', width: 2 } }];
    context.chart('personalTrendChart', o, params => { const row = rows[params.dataIndex]; if (row) context.openTournament(row.id); });
  }

  function drawYears(profile, context) {
    const rows = profile.years, colors = context.colors;
    if (!rows.some(row => finite(row.mean))) { root.document.querySelector('#personalYearChart').innerHTML = '<div class="no-data">Для среднего B пока нет опубликованных результатов.</div>'; return; }
    const o = context.base();
    o.grid = { left: 55, right: 20, top: 32, bottom: 32 };
    o.xAxis = { ...o.xAxis, data: rows.map(row => String(row.year)) };
    o.yAxis = { ...o.yAxis, name: 'Средний B', nameTextStyle: { color: colors.ink, fontSize: 9 } };
    o.tooltip.formatter = params => { const row = rows[params[0].dataIndex]; return `<b>${e(row.year)} год</b><br>Всего отыгрышей: ${num(row.games)}<br>С B: ${num(row.performanceGames)}<br>Средний B: <b>${num(row.mean)}</b><br>Медианный B: ${num(row.median)}<br>95% ДИ среднего: ${interval(row)}${row.performanceGames < 3 ? '<br><small>Малая выборка</small>' : ''}`; };
    o.series = [{ name: 'Средний B', type: 'bar', barMaxWidth: 65, data: rows.map((row, i) => ({ value: row.mean, itemStyle: { color: i === rows.length - 1 ? colors.red : colors.green, borderRadius: [4, 4, 0, 0] } })), label: { show: true, position: 'top', color: '#596c48', fontSize: 10, formatter: params => num(params.value) } }];
    context.chart('personalYearChart', o);
  }

  return { render };
});
