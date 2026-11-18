/* Results of the team while a selected player was in its published roster. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiPersonalStats = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null;
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b), n = sorted.length;
    return n ? sorted[Math.floor((n - 1) / 2)] / 2 + sorted[Math.ceil((n - 1) / 2)] / 2 : null;
  };
  const dateYear = date => /^\d{4}-/.test(String(date || '')) ? String(date).slice(0, 4) : null;
  const chronological = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id || '').localeCompare(String(b.id || ''));
  const requireAnalytics = A => {
    if (!A || ['filter', 'summarize', 'trend', 'performance', 'byPlayer'].some(key => typeof A[key] !== 'function')) {
      throw new TypeError('Provide SamuraiStats as the analytics dependency.');
    }
  };
  const published = (ts, A) => A.filter(Array.isArray(ts) ? ts : [], {});
  const interval = (values, R) => {
    const valid = values.filter(isNumber);
    if (R && typeof R.meanInterval === 'function') return R.meanInterval(valid, { confidence: .95 });
    // An optional absent interval dependency must never create a zero-width CI.
    return { count: valid.length, mean: mean(valid), median: median(valid), sd: null, se: null,
      lower: null, upper: null, confidence: .95, method: 'unavailable' };
  };

  function registry(tournaments, A) {
    requireAnalytics(A);
    const ts = published(tournaments, A);
    return A.byPlayer(ts).map(player => {
      const games = A.filter(ts, { player: player.id }).slice().sort(chronological);
      const dates = games.map(t => t.date).filter(date => typeof date === 'string' && date);
      return { id: String(player.id), name: player.name, games: games.length,
        firstDate: dates[0] || null, lastDate: dates.length ? dates[dates.length - 1] : null,
        years: Array.from(new Set(games.map(t => dateYear(t.date)).filter(Boolean))).sort().reverse() };
    });
  }

  function groupSummary(games, A, R) {
    const summary = A.summarize(games);
    const ci = interval(games.map(A.performance), R);
    return { games: summary.games, performanceGames: summary.performanceGames,
      missingPerformanceGames: summary.missingPerformanceGames,
      mean: summary.avgPerformance, median: summary.medianPerformance,
      lower: ci.lower, upper: ci.upper, interval: ci, summary };
  }

  function grouped(games, A, R, keyOf, labelOf) {
    const groups = new Map();
    games.forEach(t => {
      const key = keyOf(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });
    return Array.from(groups, ([key, rows]) => ({ ...labelOf(key, rows), ...groupSummary(rows, A, R) }));
  }

  function recentProgress(timeline) {
    // Only official B observations form these fixed windows. Unrated games do
    // not become zeros, and incomplete windows never produce a change value.
    const rated = timeline.filter(t => isNumber(t.performance));
    const window = 5;
    const segment = rows => ({ count: rows.length, mean: mean(rows.map(t => t.performance)),
      median: median(rows.map(t => t.performance)), firstDate: rows[0].date,
      lastDate: rows[rows.length - 1].date, ids: rows.map(t => t.id) });
    const last = rated.length >= window ? segment(rated.slice(-window)) : null;
    const previous = rated.length >= window * 2 ? segment(rated.slice(-window * 2, -window)) : null;
    return { eligible: !!(last && previous), window, ratedGames: rated.length,
      missingPerformanceGames: timeline.length - rated.length, last, previous,
      delta: last && previous ? last.mean - previous.mean : null };
  }

  function profile(tournaments, options, A, R) {
    requireAnalytics(A);
    const o = options || {}, ts = published(tournaments, A), players = registry(ts, A);
    const requestedId = o.playerId === undefined || o.playerId === null ? (players[0] ? players[0].id : null) : String(o.playerId);
    const player = players.find(p => p.id === requestedId) || null;
    const year = o.year === undefined || o.year === null ? 'all' : String(o.year);
    const type = o.type === undefined || o.type === null ? 'all' : String(o.type);
    const minCommonGames = Number.isInteger(o.minCommonGames) && o.minCommonGames > 0 ? o.minCommonGames : 3;
    const playerGames = player ? A.filter(ts, { player: player.id }) : [];
    const games = A.filter(playerGames, { year, type }).slice().sort(chronological);
    const summary = A.summarize(games), ci = interval(games.map(A.performance), R);
    const byId = new Map(games.map(t => [String(t.id), t]));
    const ratedSeen = [];
    const timeline = A.trend(games).map(t => {
      if (isNumber(t.performance)) ratedSeen.push(t.performance);
      const raw = byId.get(String(t.id));
      return { ...t, rolling: isNumber(t.performance) && ratedSeen.length >= 5 ? mean(ratedSeen.slice(-5)) : null,
        rollingGames: Math.min(5, ratedSeen.length),
        rosterSize: R && typeof R.rosterSize === 'function' ? R.rosterSize(raw) : null };
    });
    const years = grouped(games, A, R, t => dateYear(t.date) || 'unknown', key => ({ year: key, name: key === 'unknown' ? 'Без даты' : key }))
      .sort((a, b) => a.year === 'unknown' ? 1 : b.year === 'unknown' ? -1 : a.year.localeCompare(b.year));
    const formats = grouped(games, A, R, t => t.type === null || t.type === undefined ? 'unknown' : String(t.type), (key, rows) => ({
      id: key, name: rows[0].typeName || (key === 'unknown' ? 'Формат не указан' : 'Формат ' + key)
    })).sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, 'ru'));
    const rosterSizes = grouped(games, A, R, t => R && typeof R.rosterSize === 'function' ? R.rosterSize(t) : null,
      size => ({ size, name: size === null ? 'Состав не указан' : String(size) }))
      .sort((a, b) => a.size === null ? 1 : b.size === null ? -1 : a.size - b.size);

    const teammates = A.byPlayer(games).filter(p => !player || p.id !== player.id).map(p => {
      const shared = A.filter(games, { player: p.id });
      const stats = groupSummary(shared, A, R);
      return { id: p.id, name: p.name, ...stats,
        eligible: stats.performanceGames >= minCommonGames,
        smallSample: stats.performanceGames < minCommonGames };
    }).sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, 'ru'));
    const bestTeammates = teammates.filter(p => p.eligible).slice().sort((a, b) => b.mean - a.mean || b.performanceGames - a.performanceGames || a.name.localeCompare(b.name, 'ru'))
      .map((p, i) => ({ ...p, rank: i + 1 }));

    return {
      player, players, options: { playerId: requestedId, year, type, minCommonGames }, games,
      summary, interval: ci, timeline, years, yearly: years, formats, rosterSizes,
      availableYears: player ? player.years.slice() : [],
      recent: recentProgress(timeline), teammates, bestTeammates,
      smallSampleTeammates: teammates.filter(p => p.smallSample),
      best: summary.best, worst: summary.worst,
      coverage: { teamGames: ts.length, playerGames: playerGames.length, selectedGames: games.length,
        performanceGames: summary.performanceGames, missingPerformanceGames: summary.missingPerformanceGames,
        knownAnswerGames: summary.maskGames, knownAnswers: summary.knownAnswers,
        questions: summary.totalQuestions }
    };
  }

  return { version: '1.0.0', registry, profile,
    methodology: {
      scope: 'Результаты Самурайской самоизоляции в турнирах с игроком в опубликованной заявке. Это результаты команды, а не личные взятия или индивидуальный вклад.',
      performance: 'Перфоманс — официальный турнирный балл B. Каждый турнир с известным B имеет одинаковый вес; пропуски не заменяются нулём.',
      teammates: 'Средний B команды в совместных турнирах выбранного игрока и тиммейта. Рейтинг включает минимум три совместные игры с известным B; остальные показаны отдельно. Сравнение описательное: сезоны, турниры и составы различаются.',
      recent: 'Последние пять турниров с известным B сравниваются с предыдущими пятью. Для изменения нужны десять таких турниров в выбранном срезе.',
      intervals: '95% доверительный интервал среднего B по Стьюденту. При одной игре интервал не оценивается; связанные по времени игры и повторяющиеся составы ограничивают интерпретацию.'
    }
  };
});
