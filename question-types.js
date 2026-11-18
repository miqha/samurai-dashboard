/* Exact GotQuestions metadata joined to Rating response positions. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiQuestionTypes = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const e = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = (x, d = 0) => finite(x) ? x.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const pct = x => finite(x) ? num(x * 100, 1) + '%' : '—';
  const gap = x => finite(x) ? (x > 0 ? '+' : '') + num(x * 100, 1) + ' п.п.' : '—';
  const groups = {
    handout: { label: 'Раздаточный материал', categories: [['with', 'С раздаткой'], ['without', 'Без раздатки в записи']] },
    format: { label: 'Формат вопроса', categories: [['ordinary', 'Обычные'], ['duplet', 'Дуплеты'], ['blitz', 'Блицы'], ['tetra', 'Тетраблицы'], ['other', 'Другие / смешанные']] },
    forms: { label: 'Подсказки к форме ответа', categories: [['same_vowels', 'Одинаковые гласные'], ['paired_initials', 'Парные буквы'], ['same_initials', 'Одинаковые начальные буквы'], ['adjacent_initials', 'Соседние буквы'], ['same_endings', 'Одинаковые окончания'], ['rhyme', 'Рифма'], ['anagram', 'Анаграмма'], ['palindrome', 'Палиндром'], ['word_length', 'Число букв'], ['unmarked', 'Без распознанного признака']] }
  };
  let dimension = 'handout', detailKey = 'all', showAll = false;

  function summarize(data, selected) {
    const games = (selected || []).filter(t => t.included !== false), byId = new Map(games.map(t => [String(t.id), t]));
    const joined = [], mapped = new Set(), seen = new Set();
    let classifiedKnown = 0, known = 0, sourceCount = 0;
    for (const t of games) {
      const canceled = new Set(t.canceledQuestions || []);
      for (let i = 0; i < (t.totalQuestions || 0); i++) if (!canceled.has(i + 1) && /^[01]$/.test(String(t.mask || '')[i] || '')) known++;
    }
    for (const source of data?.questions || []) {
      const t = byId.get(String(source.tournamentId));
      if (!t || !Number.isInteger(source.number) || source.number < 1 || source.number > t.totalQuestions) continue;
      const key = String(t.id) + ':' + source.number;
      if (seen.has(key)) continue; // Invalid duplicates cannot double the denominator.
      seen.add(key); sourceCount++; mapped.add(String(t.id));
      const i = source.number - 1, char = String(t.mask || '')[i];
      if ((t.canceledQuestions || []).includes(source.number) || (char !== '0' && char !== '1')) continue;
      classifiedKnown++;
      const count = t.fieldCounts?.[i], success = t.fieldSuccesses?.[i];
      const rate = finite(success) && finite(count) && count > 0 && success >= 0 && success <= count ? success / count : t.fieldRates?.[i];
      if (!finite(count) || count <= 0 || !finite(rate) || rate < 0 || rate > 1) continue;
      joined.push({ ...source, result: Number(char), fieldRate: rate, fieldCount: count, tournamentName: t.name, date: t.date });
    }
    const output = {};
    for (const [key, group] of Object.entries(groups)) {
      output[key] = group.categories.map(([id, label]) => {
        const rows = joined.filter(q => key === 'forms' ? Array.isArray(q.forms) && q.forms.includes(id) : q[key] === id);
        const n = rows.length, takes = rows.reduce((s, q) => s + q.result, 0), expectation = rows.reduce((s, q) => s + q.fieldRate, 0);
        return { id, label, questions: n, games: new Set(rows.map(q => q.tournamentId)).size, takes,
          teamRate: n ? takes / n : null, fieldRate: n ? expectation / n : null,
          difference: n ? (takes - expectation) / n : null, expectedTakes: expectation, opponentResponses: rows.reduce((s, q) => s + q.fieldCount, 0) };
      });
    }
    const statuses = (data?.tournaments || []).filter(t => byId.has(String(t.tournamentId)));
    return { groups: output, questions: joined, coverage: { games: games.length, mappedGames: mapped.size,
      totalQuestions: games.reduce((s, t) => s + (t.totalQuestions || 0), 0), sourceQuestions: sourceCount,
      knownQuestions: known, classifiedKnown, comparableQuestions: joined.length,
      missingOpponentData: classifiedKnown - joined.length, unmatchedGames: games.length - mapped.size }, statuses };
  }

  function table(rows) {
    return `<table><thead><tr><th>Вид вопроса</th><th>Вопросов</th><th>Турниров</th><th>Взяли</th><th>Команда</th><th>Поле</th><th>Разница</th></tr></thead><tbody>${rows.map(r => `<tr><td class="table-title" data-sort-value="${e(r.label)}"><button type="button" class="question-type-link" data-question-type="${r.id}">${e(r.label)} <span>↗</span></button></td><td class="number" data-sort-value="${r.questions}">${num(r.questions)}</td><td class="number" data-sort-value="${r.games}">${num(r.games)}</td><td class="number" data-sort-value="${r.takes}">${num(r.takes)}</td><td class="number" data-sort-value="${r.teamRate ?? ''}">${pct(r.teamRate)}</td><td class="number" data-sort-value="${r.fieldRate ?? ''}">${pct(r.fieldRate)}</td><td class="number ${r.difference > 0 ? 'green' : r.difference < 0 ? 'red' : ''}" data-sort-value="${r.difference ?? ''}">${gap(r.difference)}</td></tr>`).join('')}</tbody></table>`;
  }

  function draw(stats, context) {
    const rows = stats.groups[dimension].filter(r => r.questions), o = context.base();
    if (!rows.length) { root.document.querySelector('#questionTypesChart').innerHTML = '<div class="no-data">В этом срезе нет вопросов с точным сопоставлением и известными ответами команды и поля.</div>'; return; }
    o.grid = { left: 188, right: 35, top: 25, bottom: 28 };
    o.xAxis = { ...o.xAxis, type: 'value', min: 0, max: 100, axisLabel: { ...o.xAxis?.axisLabel, formatter: '{value}%' } };
    o.yAxis = { type: 'category', inverse: true, data: rows.map(r => r.label), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { fontSize: 10, color: '#6c7c60', width: 175, overflow: 'truncate' } };
    o.tooltip = { ...o.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: p => {
      const r = rows[p[0].dataIndex]; return `<b>${e(r.label)}</b><br>Команда: ${pct(r.teamRate)} · ${r.takes}/${r.questions}<br>Остальные команды: ${pct(r.fieldRate)}<br>Разница: <b>${gap(r.difference)}</b><br>${r.questions} вопросов · ${r.games} турниров${r.questions < 10 ? '<br><small>Малая выборка</small>' : ''}<br><small>Нажмите для правил и источников</small>`;
    } };
    o.series = [{ name: 'Команда', type: 'bar', data: rows.map(r => r.teamRate * 100), barMaxWidth: 14, itemStyle: { color: context.colors?.red || '#bc5940', borderRadius: [0, 3, 3, 0] } },
      { name: 'Поле', type: 'bar', data: rows.map(r => r.fieldRate * 100), barMaxWidth: 14, itemStyle: { color: '#a8b797', borderRadius: [0, 3, 3, 0] } }];
    context.chart('questionTypesChart', o, p => { if (rows[p.dataIndex]) { detailKey = rows[p.dataIndex].id; render(context); root.document.querySelector('#questionTypeDetails')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); } });
  }

  function evidenceTable(rows) {
    if (!rows.length) return '<div class="no-data">В этой категории нет сопоставленных вопросов в выбранном срезе.</div>';
    return `<table><thead><tr><th>Турнир</th><th>№</th><th>Результат</th><th>Поле</th><th>Признак и источник</th></tr></thead><tbody>${rows.map(q => {
      const evidence = (q.evidence?.[dimension] || []), labels = dimension === 'forms' ? groups.forms.categories.filter(([id]) => q.forms?.includes(id)).map(([, label]) => label).join(', ') : groups[dimension].categories.find(([id]) => id === q[dimension])?.[1] || 'Не определён';
      return `<tr><td class="table-title" data-sort-value="${e(q.tournamentName)}"><span>${e(q.tournamentName)}</span><span class="table-sub">${e(String(q.date || '').slice(0, 10))}</span></td><td class="number" data-sort-value="${q.number}">${q.number}</td><td data-sort-value="${q.result}">${q.result ? '✓ Взяли' : '× Не взяли'}</td><td class="number" data-sort-value="${q.fieldRate}">${pct(q.fieldRate)}</td><td data-sort-value="${e(labels)}"><strong>${e(labels)}</strong>${evidence.map(x => `<span class="table-sub">${e(x.excerpt || x.rule)}</span>`).join('')}<a href="${e(q.sourceUrl)}" target="_blank" rel="noopener noreferrer">GotQuestions · вопрос ${q.questionId} ↗</a>${q.authors?.length ? `<span class="table-sub">${e(q.authors.map(a => a.name).join(', '))}</span>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function render(context) {
    const mount = root.document?.querySelector('#' + (context.mountId || 'questionTypes'));
    if (!mount) return;
    if (!context.data?.questions) { mount.innerHTML = '<article class="panel"><h3>Виды вопросов</h3><p class="chart-note">Данные GotQuestions ещё не загружены. Обновите полный снимок дашборда.</p></article>'; return; }
    const stats = summarize(context.data, context.selected), c = stats.coverage, rows = stats.groups[dimension], nonempty = rows.filter(r => r.questions >= 10).sort((a, b) => b.difference - a.difference);
    const detailRows = stats.questions.filter(q => detailKey === 'all' || (dimension === 'forms' ? q.forms?.includes(detailKey) : q[dimension] === detailKey));
    const shown = showAll ? detailRows : detailRows.slice(0, 60), unmatched = stats.statuses.filter(s => s.status !== 'matched');
    mount.innerHTML = `<article class="panel question-types-panel"><div class="panel-head wrap"><div><div class="eyebrow muted">ПРИЁМЫ И ФОРМАТЫ · GOTQUESTIONS</div><h3>Какие вопросы нам поддаются</h3></div><span class="pill">${num(c.comparableQuestions)} сопоставленных вопросов</span></div><p class="chart-note">Сравниваем взятие команды и остальных команд на одних и тех же вопросах. Каждый вопрос имеет одинаковый вес. Перфоманс B оценивается в других разделах.</p><div class="question-types-coverage"><div><strong>${num(c.mappedGames)} / ${num(c.games)}</strong><span>турниров с точным<br>сопоставлением пакета</span></div><div><strong>${num(c.sourceQuestions)} / ${num(c.totalQuestions)}</strong><span>позиций с метаданными<br>GotQuestions</span></div><div><strong>${num(c.comparableQuestions)} / ${num(c.knownQuestions)}</strong><span>из известных ответов<br>в сравнении с полем</span></div></div><div class="segmented question-types-tabs" role="group" aria-label="Разбивка по видам вопросов">${Object.entries(groups).map(([key, group]) => `<button type="button" data-question-dimension="${key}" class="${dimension === key ? 'active' : ''}">${e(group.label)}</button>`).join('')}</div><p class="tiny-note">${dimension === 'handout' ? 'Раздатка определяется по опубликованным полям источника. «Без раздатки в записи» означает отсутствие этих полей.' : dimension === 'format' ? 'Дуплеты и блицы учитываются по одному баллу рейтинговой маски. Смешанные инструкции вынесены отдельно; обычные — без обнаруженного указания на составной формат.' : 'Категории формы пересекаются. Это явные словесные признаки в тексте и примечаниях; «без распознанного признака» не означает доказанное отсутствие ограничения.'}</p><div id="questionTypesChart" class="chart question-types-chart" style="height:${Math.max(230, rows.filter(r => r.questions).length * 47 + 65)}px" role="img" aria-label="Взятие команды и поля по видам вопросов"></div><div class="chart-footer"><span class="legend"><i class="red-bg"></i> Команда <i class="gray-bg"></i> Поле</span><span>Нажмите категорию для источников</span></div>${nonempty.length ? `<div class="question-types-insight"><strong>${e(nonempty[0].label)}: ${gap(nonempty[0].difference)}</strong><span>${nonempty[0].difference >= 0 ? 'Самое большое превышение взятия поля' : 'Наименьшее отставание от поля'} среди категорий с 10+ вопросами в этой разбивке. ${num(nonempty[0].takes)} взятий из ${num(nonempty[0].questions)}.</span>${nonempty.length > 1 ? `<span>Наибольшее отставание / наименьшее преимущество: ${e(nonempty[nonempty.length - 1].label)} · ${gap(nonempty[nonempty.length - 1].difference)}.</span>` : ''}</div>` : '<p class="tiny-note">Для вывода о сильных и слабых категориях нужно хотя бы 10 вопросов в категории.</p>'}<div class="table-wrap">${table(rows)}</div><p class="tiny-note">Разница в процентных пунктах описательная: состав, время и сила поля могут различаться между видами вопросов. ${num(c.missingOpponentData)} вопросов с метаданными не включены из-за отсутствия ответа поля.</p><details class="question-types-method"><summary>Сопоставление и полнота источников</summary>${(context.data.methodology || []).map(x => `<p>${e(x)}</p>`).join('')}<p>Открытый поиск пакетов проверен: ${e(String(context.data.catalogFetchedAt || '').slice(0, 10))}. Полный список несопоставленных турниров в этом срезе:</p>${unmatched.length ? `<ul>${unmatched.map(s => `<li>${e(s.name)} — ${s.reason === 'no_published_rating_packet_link' ? 'нет опубликованной связи с ID пакета' : s.status === 'ambiguous' ? 'несколько подходящих пакетов, требуется проверка' : 'нумерация / число вопросов не совпадает'}.</li>`).join('')}</ul>` : '<p>Все турниры этого среза сопоставлены.</p>'}</details></article><article class="panel" id="questionTypeDetails"><div class="panel-head wrap"><div><div class="eyebrow muted">ПРОВЕРЯЕМЫЕ ПРИЗНАКИ</div><h3>От категории к конкретному вопросу</h3></div><label class="question-types-filter">Категория<select id="questionTypeEvidenceFilter"><option value="all">Все категории</option>${rows.map(r => `<option value="${r.id}"${detailKey === r.id ? ' selected' : ''}>${e(r.label)} · ${r.questions}</option>`).join('')}</select></label></div><p class="chart-note">Показано ${num(shown.length)} из ${num(detailRows.length)} вопросов. Короткая цитата объясняет метку; ссылка открывает исходный вопрос вместе с ответом.</p><div class="table-wrap question-types-evidence">${evidenceTable(shown)}</div>${detailRows.length > 60 ? `<button type="button" id="questionTypesShowAll" class="question-types-show">${showAll ? 'Показать первые 60' : 'Показать все ' + num(detailRows.length)}</button>` : ''}</article>`;
    mount.querySelectorAll('[data-question-dimension]').forEach(b => b.onclick = () => { dimension = b.dataset.questionDimension; detailKey = 'all'; showAll = false; render(context); });
    mount.querySelectorAll('[data-question-type]').forEach(b => b.onclick = () => { detailKey = b.dataset.questionType; showAll = false; render(context); root.document.querySelector('#questionTypeDetails')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); });
    mount.querySelector('#questionTypeEvidenceFilter').onchange = event => { detailKey = event.target.value; showAll = false; render(context); };
    const all = mount.querySelector('#questionTypesShowAll'); if (all) all.onclick = () => { showAll = !showAll; render(context); };
    draw(stats, context);
  }
  return { summarize, render, groups };
});
