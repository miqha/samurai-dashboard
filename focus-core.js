/* Descriptive team focus: official B for outcomes, question rates for diagnosis. */
(function (root, factory) {
  'use strict';
  const stats = root?.SamuraiStats || (typeof module === 'object' && module.exports ? require('./analytics.js') : null);
  const api = factory(stats);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiFocusCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function (Stats) {
  'use strict';
  const MIN_OPPONENTS = 30, MIN_BAND = 15;
  const numeric = x => typeof x === 'number' && Number.isFinite(x);
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (s[Math.floor((n - 1) / 2)] + s[Math.ceil((n - 1) / 2)]) / 2 : null; };
  const unique = a => [...new Set(a)];
  const bands = [
    { id: 'hard', label: 'Поле берёт менее 20%', min: 0, max: .2 },
    { id: 'challenge', label: 'Поле берёт 20–40%', min: .2, max: .4 },
    { id: 'middle', label: 'Поле берёт 40–60%', min: .4, max: .6 },
    { id: 'accessible', label: 'Поле берёт от 60%', min: .6, max: 1.01 }
  ];
  const labels = {
    handout: { with: 'С раздаткой', without: 'Без раздатки в записи' },
    format: { ordinary: 'Обычные вопросы', duplet: 'Дуплеты', blitz: 'Блицы', tetra: 'Тетраблицы', other: 'Другие / смешанные форматы' },
    forms: { same_vowels: 'Одинаковые гласные', paired_initials: 'Парные буквы', same_initials: 'Одинаковые начальные буквы', adjacent_initials: 'Соседние буквы', same_endings: 'Одинаковые окончания', rhyme: 'Рифма', anagram: 'Анаграмма', palindrome: 'Палиндром', word_length: 'Число букв', unmarked: 'Без распознанного признака формы' }
  };
  const performance = t => Stats.performance(t);
  const dateOf = t => /^\d{4}-\d{2}-\d{2}/.test(String(t.date || '')) ? String(t.date).slice(0, 10) : null;
  const keyOf = q => String(q.tournamentId) + ':' + q.number;
  function tally(rows) {
    const takes = rows.reduce((s, q) => s + q.result, 0), n = rows.length;
    return { questions: n, takes, misses: n - takes, games: unique(rows.map(q => String(q.tournamentId))).length,
      teamRate: n ? takes / n : null, fieldRate: mean(rows.map(q => q.fieldRate)),
      opponentResponses: rows.reduce((s, q) => s + q.fieldCount, 0) };
  }
  function authorsOf(source) {
    return [...new Map((source?.authors || []).filter(a => a && /^gq-person-\d+$/.test(String(a.id)) && !a.ambiguous && !a.tentative)
      .map(a => [String(a.id), { id: String(a.id), name: String(a.name || a.id) }])).values()];
  }
  // Export only locators and structural metadata. No question/answer text or
  // classification evidence appears in this view or its drill-down payloads.
  function safeQuestion(q) {
    const s = q.source;
    return { tournamentId: q.tournamentId, tournamentName: q.tournamentName, date: q.date, number: q.number,
      questionId: s?.questionId ?? null, packageId: s?.packageId ?? null,
      sourceUrl: /^https:\/\/gotquestions\.online\/question\/\d+$/.test(String(s?.sourceUrl)) ? s.sourceUrl : null,
      tournamentUrl: 'https://rating.chgk.info/tournament/' + encodeURIComponent(String(q.tournamentId)),
      fieldRate: q.fieldRate, fieldCount: q.fieldCount, result: q.result,
      authors: authorsOf(s), format: s?.format || null, forms: Array.isArray(s?.forms) ? s.forms.slice() : [], handout: s?.handout || null };
  }
  function metadata(data) {
    const map = new Map(), conflicts = new Set();
    for (const q of data?.questions || []) {
      if (!q || !Number.isInteger(q.number) || q.number < 1 || q.tournamentId == null) continue;
      const k = keyOf(q);
      if (conflicts.has(k)) continue;
      if (map.has(k)) {
        const before = map.get(k);
        if (before.questionId !== q.questionId || before.packageId !== q.packageId || before.handout !== q.handout || before.format !== q.format || JSON.stringify(before.forms) !== JSON.stringify(q.forms) || JSON.stringify(authorsOf(before)) !== JSON.stringify(authorsOf(q))) {
          map.delete(k); conflicts.add(k);
        }
      } else map.set(k, q);
    }
    return { map, conflicts };
  }
  function windowInfo(games, rows) {
    const ids = new Set(games.map(t => String(t.id))), qs = rows.filter(q => ids.has(String(q.tournamentId)));
    const b = games.map(performance).filter(numeric);
    return { ...tally(qs), games: games.length, ids: [...ids], from: games.length ? dateOf(games[0]) : null,
      to: games.length ? dateOf(games[games.length - 1]) : null, meanB: mean(b), medianB: median(b), performanceGames: b.length };
  }
  function atlasOf(games, rows) {
    const dated = games.filter(dateOf).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
    const size = Math.min(10, Math.floor(dated.length / 2)), available = size >= 5;
    const firstGames = available ? dated.slice(0, size) : [], lastGames = available ? dated.slice(-size) : [];
    const first = windowInfo(firstGames, rows), last = windowInfo(lastGames, rows);
    const f = new Set(first.ids), l = new Set(last.ids);
    return { available, reason: available ? null : 'Нужно хотя бы 10 турниров с известными датами: по 5 в каждом непересекающемся окне.', size: available ? size : 0,
      minimumQuestions: MIN_BAND, gamesWithoutDate: games.length - dated.length, first, last,
      bands: bands.map(b => {
        const inBand = rows.filter(q => q.fieldRate >= b.min && q.fieldRate < b.max);
        const a = tally(inBand.filter(q => f.has(String(q.tournamentId)))), z = tally(inBand.filter(q => l.has(String(q.tournamentId))));
        const enough = available && a.questions >= MIN_BAND && z.questions >= MIN_BAND;
        return { id: b.id, label: b.label, first: a, last: z, available: enough,
          deltaTeam: enough ? z.teamRate - a.teamRate : null, deltaField: enough ? z.fieldRate - a.fieldRate : null };
      }) };
  }
  function trainingIndex(data, playedData) {
    const packages = new Map((data?.packages || []).map(p => [String(p.id), p]));
    const played = new Set((playedData?.questions || []).filter(q => q?.questionId != null).map(q => String(q.questionId)));
    const playedGames = new Set((playedData?.tournaments || []).filter(t => t?.tournamentId != null).map(t => String(t.tournamentId)));
    const byAuthor = new Map(), seen = new Set();
    for (const q of data?.questions || []) {
      const p = q?.package || packages.get(String(q?.packageId));
      if (!q || q.id == null || seen.has(String(q.id)) || !p || p.type !== 'kvrm') continue;
      seen.add(String(q.id));
      const canonicalId = q.canonicalQuestionId ?? q.provenance?.gotQuestionsQuestionId;
      if (canonicalId != null && played.has(String(canonicalId))) continue;
      if ((p.ratingTournamentIds || []).some(id => playedGames.has(String(id)))) continue;
      const hasMedia = (q.media || []).some(m => ['question', 'handout'].includes(m?.role) && typeof m.url === 'string' && m.url.trim());
      if (q.flags?.missingAnswer || typeof q.answer !== 'string' || !q.answer.trim() || !(typeof q.text === 'string' && q.text.trim()) && !hasMedia) continue;
      for (const a of authorsOf(q)) {
        if (!byAuthor.has(a.id)) byAuthor.set(a.id, []);
        byAuthor.get(a.id).push(String(q.id));
      }
    }
    return byAuthor;
  }
  function opportunitiesOf(rows, training) {
    const accessible = rows.filter(q => q.fieldRate >= .6), groups = new Map();
    function add(dimension, id, label, q) {
      const key = dimension + ':' + id;
      if (!groups.has(key)) groups.set(key, { key, dimension, id, label, rows: [] });
      groups.get(key).rows.push(q);
    }
    for (const q of accessible) {
      const s = q.source;
      if (!s) continue;
      for (const dimension of ['handout', 'format']) if (labels[dimension][s[dimension]]) add(dimension, s[dimension], labels[dimension][s[dimension]], q);
      for (const id of unique((s.forms || []).filter(id => labels.forms[id]))) add('forms', id, labels.forms[id], q);
      for (const a of authorsOf(s)) add('authors', a.id, a.name, q);
    }
    const categories = [...groups.values()].map(g => {
      const misses = g.rows.filter(q => q.result === 0);
      // A named author card promises this author's work. For a format/form
      // card the verified authors of its missed questions are the practice pool.
      const authorIds = g.dimension === 'authors' ? (misses.length ? [g.id] : []) : unique(misses.flatMap(q => authorsOf(q.source).map(a => a.id)));
      const ids = unique(authorIds.flatMap(id => training.get(id) || []));
      return { key: g.key, dimension: g.dimension, id: g.id, label: g.label, ...tally(g.rows), eligible: g.rows.length >= 10 && unique(g.rows.map(q => String(q.tournamentId))).length >= 3,
        missed: misses.map(safeQuestion), authorIds, trainingQuestionIds: ids, trainingCount: ids.length, trainingLabel: 'Вопросы этих авторов' };
    }).sort((a, b) => b.misses - a.misses || b.questions - a.questions || a.label.localeCompare(b.label, 'ru'));
    return { summary: { ...tally(accessible), matchedQuestions: accessible.filter(q => q.source).length,
      matchedMisses: accessible.filter(q => q.source && q.result === 0).length },
      missed: accessible.filter(q => q.result === 0).sort((a, b) => b.fieldRate - a.fieldRate || String(b.date).localeCompare(String(a.date))).map(safeQuestion),
      categories, authors: categories.filter(g => g.dimension === 'authors'), formats: categories.filter(g => g.dimension === 'format'),
      forms: categories.filter(g => g.dimension === 'forms'), handouts: categories.filter(g => g.dimension === 'handout') };
  }
  function rhythmOf(rows, games) {
    const lengths = new Map();
    for (const t of games) {
      const qty = Array.isArray(t.questionQty) ? t.questionQty : [];
      if (qty.length && qty.every(n => Number.isInteger(n) && n > 0)) lengths.set(String(t.id), qty);
    }
    const firstRows = [], lastRows = [];
    for (const q of rows) {
      const length = lengths.get(String(q.tournamentId))?.[q.round - 1];
      if (!length || length < 3 || q.slot < 1 || q.slot > length || q.fieldRate < .6) continue;
      const third = Math.floor(length / 3);
      if (q.slot <= third) firstRows.push(q);
      if (q.slot > length - third) lastRows.push(q);
    }
    const first = tally(firstRows), last = tally(lastRows);
    const available = first.questions >= MIN_BAND && last.questions >= MIN_BAND && first.games >= 3 && last.games >= 3;
    return { available, reason: available ? null : 'Нужно по 15 доступных вопросов минимум из 3 турниров в первой и последней трети туров.',
      first, last, questions: first.questions + last.questions, minimumQuestions: MIN_BAND, minimumGames: 3,
      difference: available ? last.teamRate - first.teamRate : null, lastMinusFirstField: available ? last.fieldRate - first.fieldRate : null };
  }
  function validId(value) { return Number.isInteger(value) && value > 0; }
  function exactSource(source) {
    return source && validId(source.questionId) && validId(source.packageId)
      && source.sourceUrl === 'https://gotquestions.online/question/' + source.questionId;
  }
  function publishedQuestionRate(q) {
    // Recompute ratios from exact paired counts. A rounded percentage and a
    // packet trueDL never stand in for this question's observed take rate.
    const rows = (Array.isArray(q.difficultyObservations) ? q.difficultyObservations : []).filter(s =>
      s && Number.isInteger(s.teamsCount) && s.teamsCount >= MIN_OPPONENTS
      && Number.isInteger(s.correctAnswers) && s.correctAnswers >= 0 && s.correctAnswers <= s.teamsCount);
    rows.sort((a, b) => b.teamsCount - a.teamsCount || (numeric(a.sourceIndex) ? a.sourceIndex : Infinity) - (numeric(b.sourceIndex) ? b.sourceIndex : Infinity));
    return rows.length ? rows[0].correctAnswers / rows[0].teamsCount : null;
  }
  function remediationPool(data, playedData) {
    const packages = new Map((data?.packages || []).map(p => [String(p.id), p]));
    const playedIds = new Set((playedData?.questions || []).filter(q => q?.questionId != null).map(q => String(q.questionId)));
    const playedGames = new Set((playedData?.tournaments || []).filter(t => t?.tournamentId != null).map(t => String(t.tournamentId)));
    const playedPacks = new Set((playedData?.questions || []).filter(q => q?.packageId != null).map(q => String(q.packageId)));
    for (const t of playedData?.tournaments || []) for (const id of [t.packageId, ...(t.packageIds || [])]) if (id != null) playedPacks.add(String(id));
    const seen = new Set(), canonicalSeen = new Set(), result = [];
    let playable = 0, classified = 0, withPublishedRate = 0;
    for (const q of data?.questions || []) {
      const p = q?.package || packages.get(String(q?.packageId));
      const id = String(q?.id ?? ''), canonicalId = q?.canonicalQuestionId ?? q?.provenance?.gotQuestionsQuestionId;
      if (!id || seen.has(id) || !validId(canonicalId) || canonicalSeen.has(canonicalId) || !p || p.type !== 'kvrm' || p.published === false) continue;
      seen.add(id); canonicalSeen.add(canonicalId);
      if (playedIds.has(String(canonicalId)) || playedPacks.has(String(p.id)) || [...(p.ratingTournamentIds || []), p.ratingTournamentId].some(t => t != null && playedGames.has(String(t)))) continue;
      const hasMedia = (q.media || []).some(m => ['question', 'handout'].includes(m?.role) && typeof m.url === 'string' && m.url.trim());
      if (q.flags?.missingAnswer || q.flags?.takenDown || typeof q.answer !== 'string' || !q.answer.trim() || !(typeof q.text === 'string' && q.text.trim()) && !hasMedia) continue;
      playable++;
      const c = q.classification, rate = publishedQuestionRate(q);
      if (c && labels.format[c.format] && labels.handout[c.handout] && Array.isArray(c.forms)) classified++;
      if (rate !== null) withPublishedRate++;
      result.push({ id, classification: c || null, fieldRate: rate });
    }
    return { questions: result, coverage: { playableNewQuestions: playable, classifiedNewQuestions: classified, questionsWithPublishedRate: withPublishedRate,
      linkedPlayedPackages: playedPacks.size, minOpponents: MIN_OPPONENTS } };
  }
  function publicationDate(value) {
    // Only GotQuestions' real publication timestamp is eligible. Fetch/check
    // times and an invalid calendar day must never order this list.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
    const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
    if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) return null;
    const day = value.slice(0, 10), midnight = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day || !Number.isFinite(Date.parse(value))) return null;
    return value;
  }
  function mistakesReport(tournament, games, dated, comparable, allDetails, pool, safeTournament, mappedIds) {
    const id = tournament ? String(tournament.id) : null;
    const rows = tournament ? comparable.filter(q => String(q.tournamentId) === id && exactSource(q.source)) : [];
    const known = tournament ? allDetails.filter(q => String(q.tournamentId) === id && (q.result === 0 || q.result === 1)) : [];
    const summary = tally(rows), overallGap = rows.length ? summary.teamRate - summary.fieldRate : null;
    const groups = new Map();
    function add(dimension, categoryId, label, q) {
      const key = dimension + ':' + categoryId;
      if (!groups.has(key)) groups.set(key, { key, dimension, id: categoryId, label, rows: [] });
      groups.get(key).rows.push(q);
    }
    for (const q of rows) {
      for (const band of bands) if (q.fieldRate >= band.min && q.fieldRate < band.max) add('difficulty', band.id, band.label, q);
      for (const dimension of ['format', 'handout']) if (labels[dimension][q.source[dimension]]) add(dimension, q.source[dimension], labels[dimension][q.source[dimension]], q);
      for (const form of unique((q.source.forms || []).filter(x => labels.forms[x]))) add('forms', form, labels.forms[form], q);
    }
    const categories = [...groups.values()].map(g => {
      const counts = tally(g.rows), gap = counts.teamRate - counts.fieldRate, weak = gap < -1e-12 && counts.misses > 0;
      const practice = pool.questions.filter(q => {
        if (g.dimension === 'difficulty') {
          const b = bands.find(b => b.id === g.id);
          return q.fieldRate !== null && q.fieldRate >= b.min && q.fieldRate < b.max;
        }
        return g.dimension === 'forms' ? Array.isArray(q.classification?.forms) && q.classification.forms.includes(g.id) : q.classification?.[g.dimension] === g.id;
      });
      const ids = practice.map(q => q.id);
      const explanation = g.dimension === 'difficulty'
        ? 'Новые вопросы той же категории опубликованной доли взятия GotQuestions, минимум 30 команд; для каждого выбрана самая большая опубликованная выборка. Состав и сила поля могли отличаться. Это доля взятия вопроса, не trueDL пакета.'
        : 'Новые вопросы с тем же признаком в опубликованном тексте и инструкциях GotQuestions. Только точное совпадение категории; сложность пакетов может отличаться.';
      const focusLabel = tournament.name + ' · ' + g.label;
      return { key: g.key, dimension: g.dimension, id: g.id, label: g.label, ...counts, gap,
        deficit: g.rows.reduce((s, q) => s + q.fieldRate - q.result, 0), relativeGap: gap - overallGap,
        smallSample: counts.questions < 5, weak, priorityEligible: weak && counts.questions >= 3,
        missed: g.rows.filter(q => q.result === 0).map(safeQuestion), trainingQuestionIds: ids, trainingCount: ids.length,
        trainingLabel: 'Тренировать категорию', trainingExplanation: explanation,
        preset: { questionIds: ids.slice(), authors: [], focusLabel, focusKind: 'mistakes', focusDescription: explanation,
          remediation: { tournamentId: tournament.id, tournamentName: tournament.name, categoryKey: g.key,
            categoryLabel: g.label, teamRate: counts.teamRate, fieldRate: counts.fieldRate, questions: counts.questions } } };
    }).sort((a, b) => b.deficit - a.deficit || b.questions - a.questions || a.key.localeCompare(b.key));
    return { available: rows.length > 0, reason: !tournament ? 'В выбранных играх ещё нет точного сопоставления вопросов с опубликованным пакетом GotQuestions.'
      : !rows.length ? 'У выбранного турнира нет вопросов с известным ответом команды и минимум 30 известными ответами соперников.' : null,
      latestTournament: safeTournament(dated[0]), tournament: safeTournament(tournament),
      skippedNewer: dated.filter(t => (!tournament || Date.parse(t.date) > Date.parse(tournament.date)) && !mappedIds.has(String(t.id))).map(safeTournament),
      dateBasis: 'official_start', gamesWithoutDate: games.length - dated.length,
      coverage: { knownQuestions: known.length, mappedKnownQuestions: known.filter(q => exactSource(q.source)).length,
        comparableQuestions: rows.length, minOpponents: MIN_OPPONENTS, selectedGames: games.length },
      summary: { ...summary, gap: overallGap }, categories, priorities: categories.filter(g => g.priorityEligible),
      trainingCoverage: pool.coverage, minimumPriorityQuestions: 3, smallSampleBelow: 5 };
  }
  function mistakesOf(games, comparable, allDetails, playedData, trainingData) {
    const descendingId = (a, b) => String(b.id).localeCompare(String(a.id), 'en', { numeric: true });
    const dated = games.filter(t => dateOf(t) && Number.isFinite(Date.parse(t.date))).slice()
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || descendingId(a, b));
    const statuses = new Map((playedData?.tournaments || []).filter(Boolean).map(t => [String(t.tournamentId), t]));
    const sourceIds = new Set(allDetails.filter(q => exactSource(q.source)).map(q => String(q.tournamentId)));
    const eligible = [...new Map(games.filter(t => sourceIds.has(String(t.id))
      && (!statuses.has(String(t.id)) || statuses.get(String(t.id)).status === 'matched')).map(t => [String(t.id), t])).values()];
    const mappedIds = new Set(eligible.map(t => String(t.id)));
    const publication = new Map(eligible.map(t => [String(t.id), publicationDate(statuses.get(String(t.id))?.publishedAt)]));
    const recentPlayed = dated.filter(t => mappedIds.has(String(t.id))).slice(0, 3);
    const recentPublished = eligible.filter(t => publication.get(String(t.id))).sort((a, b) =>
      Date.parse(publication.get(String(b.id))) - Date.parse(publication.get(String(a.id))) || descendingId(a, b)).slice(0, 3);
    const playedIds = new Set(recentPlayed.map(t => String(t.id))), publishedIds = new Set(recentPublished.map(t => String(t.id)));
    const safeTournament = t => t ? { id: t.id, name: t.name, date: dateOf(t), performance: performance(t),
      url: 'https://rating.chgk.info/tournament/' + encodeURIComponent(String(t.id)),
      publishedAt: publication.get(String(t.id)) || null, recentPlayed: playedIds.has(String(t.id)), recentPublished: publishedIds.has(String(t.id)) } : null;
    const choices = [...new Map([...recentPlayed, ...recentPublished].map(t => [String(t.id), t])).values()];
    const pool = remediationPool(trainingData, playedData), reports = {};
    for (const tournament of choices) reports[String(tournament.id)] = mistakesReport(tournament, games, dated, comparable, allDetails, pool, safeTournament, mappedIds);
    const first = choices[0], report = first ? reports[String(first.id)]
      : mistakesReport(null, games, dated, comparable, allDetails, pool, safeTournament, mappedIds);
    const knownPublicationDates = eligible.filter(t => publication.get(String(t.id))).length;
    return { ...report, tournaments: choices.map(safeTournament), reports, publicationDateBasis: 'gotquestions_pubDate',
      publicationCoverage: { mappedGames: eligible.length, knownPublicationDates, missingPublicationDates: eligible.length - knownPublicationDates } };
  }
  function build(options) {
    const o = options || {}, games = (o.selected || []).filter(t => t && t.included !== false);
    const gameMap = new Map(games.map(t => [String(t.id), t])), meta = metadata(o.playedData);
    const details = Stats.questionDetails(games).map(q => {
      const game = gameMap.get(String(q.tournamentId)), count = q.fieldCount, successes = game?.fieldSuccesses?.[q.number - 1];
      const rate = numeric(successes) && numeric(count) && count > 0 && successes >= 0 && successes <= count ? successes / count : q.fieldRate;
      return { ...q, fieldRate: rate, source: meta.map.get(keyOf(q)) || null };
    });
    const known = details.filter(q => q.result === 0 || q.result === 1);
    const validField = known.filter(q => numeric(q.fieldCount) && q.fieldCount > 0 && numeric(q.fieldRate) && q.fieldRate >= 0 && q.fieldRate <= 1);
    const comparable = validField.filter(q => q.fieldCount >= MIN_OPPONENTS), mapped = details.filter(q => q.source);
    const rareRows = comparable.filter(q => q.fieldRate <= .2), timeline = games.filter(t => performance(t) !== null).slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id)))
      .map((t, i, a) => { const window = a.slice(Math.max(0, i - 4), i + 1).map(performance); return {
        id: t.id, name: t.name, date: dateOf(t), performance: performance(t), rollingMedian: window.length >= 5 ? median(window) : null, rollingCount: window.length }; });
    return { coverage: { games: games.length, questions: details.length, knownQuestions: known.length, comparableQuestions: comparable.length,
      opponentBelowMinimum: validField.length - comparable.length, missingOpponentData: known.length - validField.length,
      matchedQuestions: mapped.length, matchedComparableQuestions: comparable.filter(q => q.source).length,
      matchedGames: unique(mapped.map(q => String(q.tournamentId))).length, unmatchedGames: games.length - unique(mapped.map(q => String(q.tournamentId))).length,
      conflictingMetadata: details.filter(q => meta.conflicts.has(keyOf(q))).length, minOpponents: MIN_OPPONENTS },
      atlas: atlasOf(games, comparable), opportunities: opportunitiesOf(comparable, trainingIndex(o.trainingData, o.playedData)), rhythm: rhythmOf(comparable, games),
      mistakes: mistakesOf(games, comparable, details, o.playedData, o.trainingData),
      rareWins: { ...tally(rareRows), items: rareRows.filter(q => q.result === 1).sort((a, b) => a.fieldRate - b.fieldRate || String(b.date).localeCompare(String(a.date))).map(safeQuestion) },
      performance: { games: timeline.length, meanB: mean(timeline.map(t => t.performance)), medianB: median(timeline.map(t => t.performance)), timeline } };
  }
  return { version: '1.2.0', build, bands: bands.map(b => ({ ...b })), labels };
});
