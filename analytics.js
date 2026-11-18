/* Samurai dashboard statistics. No external dependencies; rates are fractions. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiStats = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const divide = (a, b) => b > 0 ? a / b : null;
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const median = values => {
    const a = values.slice().sort((x, y) => x - y);
    return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2 : null;
  };
  const unique = values => Array.from(new Set(values));
  const validGames = tournaments => (Array.isArray(tournaments) ? tournaments : []).filter(t => t && t.included !== false);
  const maskArray = t => Array.isArray(t.mask) ? t.mask.slice() : typeof t.mask === 'string' ? t.mask.replace(/[\s,|]/g, '').split('') : [];
  const personName = p => typeof p === 'string' ? p : (p && (p.name || [p.surname, p.firstname, p.patronymic].filter(Boolean).join(' '))) || 'Без имени';
  const personKey = p => p && typeof p === 'object' && p.id !== undefined && p.id !== null ? String(p.id) : personName(p);
  const people = values => {
    const map = new Map();
    for (const p of Array.isArray(values) ? values : []) {
      if (!p) continue;
      const id = personKey(p);
      if (!map.has(id)) map.set(id, { id, name: personName(p) });
    }
    return Array.from(map.values());
  };
  const canceledSet = t => new Set((Array.isArray(t.canceledQuestions) ? t.canceledQuestions : []).map(x => finite(typeof x === 'object' && x ? x.number : x)).filter(x => x !== null));
  const roundsOf = t => (Array.isArray(t.questionQty) ? t.questionQty : []).map(finite).filter(q => q !== null && q > 0).map(Math.floor);
  const questionCount = t => {
    const rounds = roundsOf(t);
    return Math.max(0, Math.floor(finite(t.totalQuestions) || 0), rounds.reduce((a, b) => a + b, 0), maskArray(t).length, Array.isArray(t.fieldRates) ? t.fieldRates.length : 0);
  };
  const percentile = t => {
    const n = finite(t.fieldSize), p = finite(t.position);
    return n !== null && n > 1 && p !== null && p >= 1 && p <= n ? 100 * (n - p) / (n - 1) : null;
  };
  // The user selected the official tournament score B. inRating controls
  // crediting the bonus, not whether a computed B is a valid performance.
  // Never substitute pre-game ratings, bonus changes or answer percentages.
  const performance = t => {
    const value = t?.rating?.b;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const chronology = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id || '').localeCompare(String(b.id || ''));
  const groupIdentity = authors => authors.map(p => p.id).sort().join('|');
  const creditedPeople = values => {
    const result = [], seen = new Set();
    for (const p of Array.isArray(values) ? values : []) {
      if (!p) continue;
      if (p.tentative || p.ambiguous) {
        const names = unique((Array.isArray(p.candidates) ? p.candidates : []).map(c => c && c.name).filter(Boolean));
        const rawName = p.name || (names.length === 1 ? names[0] : 'Нераспознанная запись автора');
        const id = 'unresolved:' + rawName;
        if (!seen.has(id)) result.push({ id, name: rawName + ' (ID не подтверждён)', unresolved: true });
        seen.add(id);
      } else {
        const id = personKey(p);
        if (!seen.has(id)) result.push({ id, name: personName(p), unmatched: !!p.unmatched });
        seen.add(id);
      }
    }
    return result;
  };
  const questionScope = value => ({ ...value, questionScope: true, contextOfficialScore: value.officialScore, contextAvgScore: value.avgScore, contextAvgPerformance: value.avgPerformance, avgPerformance: null, medianPerformance: null, minPerformance: null, maxPerformance: null, performanceGames: 0, officialScore: null, score: value.takes, avgScore: divide(value.takes, value.games) });

  function filter(tournaments, options) {
    const o = options || {};
    const query = String(o.search || '').trim().toLocaleLowerCase('ru');
    return validGames(tournaments).filter(t => {
      if (o.year && String(o.year) !== 'all' && String(t.date || '').slice(0, 4) !== String(o.year)) return false;
      if (o.type && String(o.type) !== 'all' && String(t.type) !== String(o.type) && String(t.typeName) !== String(o.type)) return false;
      if (o.player && String(o.player) !== 'all' && !people(t.players).some(p => p.id === String(o.player))) return false;
      return !query || [t.name, t.teamName, t.typeName, ...people(t.editors).map(p => p.name)].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(query);
    });
  }

  function questionDetails(tournaments) {
    const rows = [];
    validGames(tournaments).forEach((t, ti) => {
      const count = questionCount(t), mask = maskArray(t), canceled = canceledSet(t), rounds = roundsOf(t);
      const players = people(t.players), editors = people(t.editors);
      const credits = (Array.isArray(t.questionCredits) ? t.questionCredits : []).map(c => {
        const authors = creditedPeople(c.authors);
        const from = finite(c.from !== undefined && c.from !== null ? c.from : Array.isArray(c.questions) && c.questions[0] !== null ? c.questions[0] : 1);
        const to = finite(c.to !== undefined && c.to !== null ? c.to : Array.isArray(c.questions) && c.questions[1] !== null ? c.questions[1] : count);
        return authors.length && from !== null && to !== null ? { id: groupIdentity(authors), name: authors.map(p => p.name).join(' · '), authors, from, to, tour: c.tour } : null;
      }).filter(Boolean);
      let round = 1, roundStart = 0, roundEnd = rounds[0] || count;
      for (let number = 1; number <= count; number++) {
        while (number > roundEnd && round < rounds.length) { roundStart = roundEnd; round++; roundEnd += rounds[round - 1]; }
        if (canceled.has(number)) continue;
        const raw = mask[number - 1];
        const result = raw === 1 || raw === '1' ? 1 : raw === 0 || raw === '0' ? 0 : null;
        const rawRate = finite(Array.isArray(t.fieldRates) ? t.fieldRates[number - 1] : null);
        const rate = rawRate !== null && rawRate >= 0 && rawRate <= 1 ? rawRate : null;
        const authorGroups = new Map();
        for (const c of credits) if (number >= c.from && number <= c.to && !authorGroups.has(c.id)) authorGroups.set(c.id, { id: c.id, name: c.name, authors: c.authors });
        rows.push({
          tournamentId: t.id, tournamentKey: t.id !== undefined ? String(t.id) : '@' + ti,
          tournamentName: t.name || 'Без названия', date: t.date || '',
          number, round, slot: number - roundStart, result, raw: raw === undefined ? null : raw,
          fieldRate: rate, fieldCount: finite(Array.isArray(t.fieldCounts) ? t.fieldCounts[number - 1] : null),
          editors, players, authorGroups: Array.from(authorGroups.values()),
          authors: Array.from(new Map(Array.from(authorGroups.values()).flatMap(g => g.authors).map(a => [a.id, a])).values()),
          ambiguousAuthors: authorGroups.size > 1
        });
      }
    });
    return rows;
  }

  function tallyQuestions(details) {
    let takes = 0, misses = 0, unknownAnswers = 0, fieldQuestions = 0, expected = 0, fieldTakes = 0;
    let rareTakes = 0, popularMisses = 0, rareQuestions = 0, popularQuestions = 0;
    for (const q of details) {
      if (q.result === null) { unknownAnswers++; continue; }
      takes += q.result; misses += 1 - q.result;
      if (q.fieldRate !== null) {
        fieldQuestions++; expected += q.fieldRate; fieldTakes += q.result;
        if (q.fieldRate <= .2) { rareQuestions++; rareTakes += q.result; }
        if (q.fieldRate >= .6) { popularQuestions++; popularMisses += 1 - q.result; }
      }
    }
    const knownAnswers = takes + misses;
    return {
      questions: details.length, knownAnswers, answered: knownAnswers, takes, misses, unknownAnswers,
      takeRate: divide(takes, knownAnswers), coverage: divide(knownAnswers, details.length),
      fieldQuestions, fieldExpected: fieldQuestions ? expected : null,
      expected: fieldQuestions ? expected : null, fieldTakeRate: divide(expected, fieldQuestions),
      fieldActual: fieldQuestions ? fieldTakes : null,
      excess: fieldQuestions ? fieldTakes - expected : null,
      excessPerQuestion: fieldQuestions ? (fieldTakes - expected) / fieldQuestions : null,
      rareTakes, popularMisses, rareQuestions, popularQuestions
    };
  }

  function firstRank(t) {
    const score = finite(t.score);
    const dist = Array.isArray(t.scoreDistribution) ? t.scoreDistribution : [];
    if (score !== null && dist.some(d => finite(d.score) === score && finite(d.count) > 0)) return 1 + dist.reduce((n, d) => n + (finite(d.score) > score ? finite(d.count) || 0 : 0), 0);
    return finite(t.position);
  }

  function longestStreak(tournaments, result) {
    let longest = 0;
    for (const t of validGames(tournaments)) {
      const mask = maskArray(t), canceled = canceledSet(t);
      let current = 0;
      for (let i = 0; i < questionCount(t); i++) {
        const v = mask[i];
        current = !canceled.has(i + 1) && (v === result || v === String(result)) ? current + 1 : 0;
        longest = Math.max(longest, current);
      }
    }
    return longest;
  }

  function aggregate(tournaments, details) {
    const ts = validGames(tournaments), qs = details || questionDetails(ts), tally = tallyQuestions(qs);
    const scores = ts.map(t => finite(t.score)).filter(v => v !== null);
    const percentiles = ts.map(percentile).filter(v => v !== null);
    const performances = ts.map(performance).filter(v => v !== null);
    const maskGames = ts.filter(t => {
      const canceled = canceledSet(t);
      return maskArray(t).some((v, i) => !canceled.has(i + 1) && (v === 0 || v === 1 || v === '0' || v === '1'));
    }).length;
    return {
      games: ts.length, tournaments: ts.length, ...tally,
      totalQuestions: qs.length, scheduledQuestions: ts.reduce((n, t) => n + questionCount(t), 0),
      canceledQuestions: ts.reduce((n, t) => n + Array.from(canceledSet(t)).filter(q => q >= 1 && q <= questionCount(t)).length, 0),
      officialScore: scores.reduce((a, b) => a + b, 0), score: scores.reduce((a, b) => a + b, 0),
      officialScoreGames: scores.length, avgScore: mean(scores),
      avgPercentile: mean(percentiles), percentile: mean(percentiles), medianPercentile: median(percentiles), percentileGames: percentiles.length,
      avgPerformance: mean(performances), medianPerformance: median(performances),
      minPerformance: performances.length ? Math.min(...performances) : null,
      maxPerformance: performances.length ? Math.max(...performances) : null,
      performanceGames: performances.length, missingPerformanceGames: ts.length - performances.length,
      wins: ts.filter(t => firstRank(t) === 1).length,
      podiums: ts.filter(t => firstRank(t) !== null && firstRank(t) <= 3).length,
      topQuartile: percentiles.filter(p => p >= 75).length,
      maskGames, masksPresentGames: ts.filter(t => maskArray(t).length > 0).length,
      masksCoverage: { games: divide(maskGames, ts.length), questions: divide(tally.knownAnswers, qs.length) },
      eligible: ts.length >= 3
    };
  }

  function trend(tournaments) {
    return validGames(tournaments).slice().sort(chronology).map(t => ({
      ...aggregate([t]), id: t.id, name: t.name || 'Без названия', date: t.date || '',
      type: t.type, typeName: t.typeName, position: finite(t.position), fieldSize: finite(t.fieldSize),
      percentile: percentile(t), performance: performance(t), editors: people(t.editors), players: people(t.players)
    }));
  }

  function summarize(tournaments) {
    const ts = validGames(tournaments), qs = questionDetails(ts), result = aggregate(ts, qs);
    const timeline = trend(ts);
    const ranked = timeline.filter(t => t.performance !== null).sort((a, b) => b.performance - a.performance || chronology(a, b));
    const rankedLargeField = ranked.filter(t => t.fieldSize >= 20);
    const lastRound = new Map(ts.map((t, i) => [t.id !== undefined ? String(t.id) : '@' + i, roundsOf(t).length || 1]));
    return {
      ...result,
      excludedGames: (Array.isArray(tournaments) ? tournaments : []).filter(t => t && t.included === false).length,
      longestTakeStreak: longestStreak(ts, 1), longestMissStreak: longestStreak(ts, 0),
      firstRoundRate: tallyQuestions(qs.filter(q => q.round === 1)).takeRate,
      lastRoundRate: tallyQuestions(qs.filter(q => q.round === lastRound.get(q.tournamentKey))).takeRate,
      best: ranked[0] || null, worst: ranked.length ? ranked[ranked.length - 1] : null,
      bestLargeField: rankedLargeField[0] || null, worstLargeField: rankedLargeField.length ? rankedLargeField[rankedLargeField.length - 1] : null,
      firstDate: timeline.length ? timeline[0].date : null, lastDate: timeline.length ? timeline[timeline.length - 1].date : null
    };
  }

  function questionGroups(tournaments, keyOf, labelOf) {
    const ts = validGames(tournaments), details = questionDetails(ts), groups = new Map();
    const tournamentMap = new Map(ts.map((t, i) => [t.id !== undefined ? String(t.id) : '@' + i, t]));
    for (const q of details) {
      const key = keyOf(q);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    }
    return Array.from(groups, ([key, qs]) => {
      const games = unique(qs.map(q => q.tournamentKey)).map(k => tournamentMap.get(k));
      return { ...questionScope(aggregate(games, qs)), id: key, ...labelOf(key) };
    });
  }

  function byQuestion(tournaments, mode) {
    const relative = mode === 'round';
    return questionGroups(tournaments, q => relative ? q.slot : q.number, number => ({ number, name: 'Вопрос ' + number, mode: relative ? 'round' : 'absolute' })).sort((a, b) => a.number - b.number);
  }
  function byRound(tournaments) {
    return questionGroups(tournaments, q => q.round, round => ({ round, name: 'Тур ' + round })).sort((a, b) => a.round - b.round);
  }

  function rosterGroups(tournaments, kind) {
    const groups = new Map();
    for (const t of validGames(tournaments)) {
      const roster = people(t[kind]);
      const entries = kind === 'pairs' ? [] : roster.map(p => ({ id: p.id, name: p.name }));
      if (kind === 'pairs') {
        const players = people(t.players).sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) entries.push({ id: players[i].id + '|' + players[j].id, name: players[i].name + ' + ' + players[j].name, players: [players[i], players[j]] });
      }
      for (const e of entries) {
        if (!groups.has(e.id)) groups.set(e.id, { entry: e, tournaments: [] });
        groups.get(e.id).tournaments.push(t);
      }
    }
    return Array.from(groups.values(), g => ({ ...aggregate(g.tournaments), ...g.entry, association: kind === 'editors' ? 'full-package-editor' : 'registered-team-roster' })).sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, 'ru'));
  }
  const byPlayer = tournaments => rosterGroups(tournaments, 'players');
  const pairs = tournaments => rosterGroups(tournaments, 'pairs');
  const byEditor = tournaments => rosterGroups(tournaments, 'editors');

  function byAuthor(tournaments) {
    const ts = validGames(tournaments), details = questionDetails(ts), groups = new Map();
    const gameMap = new Map(ts.map((t, i) => [t.id !== undefined ? String(t.id) : '@' + i, t]));
    for (const q of details) for (const g of q.authorGroups) {
      if (!groups.has(g.id)) groups.set(g.id, { group: g, questions: new Map() });
      groups.get(g.id).questions.set(q.tournamentKey + ':' + q.number, q);
    }
    return Array.from(groups.values(), g => {
      const qs = Array.from(g.questions.values()), games = unique(qs.map(q => q.tournamentKey)).map(k => gameMap.get(k));
      return { ...questionScope(aggregate(games, qs)), ...g.group, creditType: 'question-author-group', association: 'credited-question-range', unresolvedAuthors: g.group.authors.filter(a => a.unresolved).length, unmatchedAuthors: g.group.authors.filter(a => a.unmatched).length, overlapQuestions: qs.filter(q => q.ambiguousAuthors).length, ambiguousQuestions: qs.filter(q => q.ambiguousAuthors).length };
    }).sort((a, b) => b.knownAnswers - a.knownAnswers || a.name.localeCompare(b.name, 'ru'));
  }

  function insights(tournaments) {
    const ts = validGames(tournaments), s = summarize(ts), output = [];
    const pct = n => (n * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
    const num = n => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    if (!s.games) return [{ type: 'coverage', title: 'Нет завершённых турниров', text: 'Измените фильтры, чтобы увидеть статистику.', value: 0 }];
    const best = s.best;
    if (best) output.push({ type: 'best', title: 'Лучший перфоманс', text: best.name + ': ' + num(best.performance) + ' балла; место ' + num(best.position) + ' из ' + best.fieldSize + '. Показатель относится ко всему выступлению.', value: best.performance, tournamentId: best.id });
    if (s.performanceGames) output.push({ type: 'performance', title: 'Средний уровень выступлений', text: 'Средний перфоманс — ' + num(s.avgPerformance) + ', медиана — ' + num(s.medianPerformance) + '. Оценка есть для ' + s.performanceGames + ' из ' + s.games + ' игр; каждый турнир имеет одинаковый вес.', value: s.avgPerformance });
    const rounds = byRound(ts).filter(r => r.games >= Math.max(3, Math.ceil(ts.length / 2)) && r.knownAnswers >= 15);
    if (rounds.length > 1) {
      const ranked = rounds.slice().sort((a, b) => b.takeRate - a.takeRate), best = ranked[0], worst = ranked[ranked.length - 1];
      output.push({ type: 'round', title: 'Ритм по турам', text: best.name + ' — ' + pct(best.takeRate) + ' (игр: ' + best.games + '), ' + worst.name.toLocaleLowerCase('ru') + ' — ' + pct(worst.takeRate) + ' (игр: ' + worst.games + '). Здесь только туры, встречающиеся хотя бы в половине выборки; сложность и составы различаются.', value: best.takeRate - worst.takeRate });
    }
    if (s.popularQuestions) output.push({ type: 'opportunity', title: 'Резерв на популярных вопросах', text: s.popularMisses + ' невзятых вопросов из ' + s.popularQuestions + ', которые взяли хотя бы 60% опубликованного поля.', value: s.popularMisses });
    if (s.rareQuestions) output.push({ type: 'positive', title: 'Редкие взятия', text: s.rareTakes + ' взятий из ' + s.rareQuestions + ' вопросов, которые взяли не более 20% опубликованного поля.', value: s.rareTakes });
    if (s.longestTakeStreak) output.push({ type: 'streak', title: 'Лучшая серия', text: s.longestTakeStreak + ' взятых вопросов подряд в одном турнире. Неизвестная или снятая отметка прерывает серию.', value: s.longestTakeStreak });
    const qrows = byQuestion(ts).filter(q => q.games >= 3 && q.knownAnswers >= 10 && q.fieldQuestions >= 10);
    if (qrows.length) {
      const q = qrows.slice().sort((a, b) => a.excessPerQuestion - b.excessPerQuestion)[0];
      output.push({ type: 'question', title: 'Номер с наибольшим отставанием', text: '№' + q.number + ': ' + pct(q.fieldActual / q.fieldQuestions) + ' взятий против ' + pct(q.fieldTakeRate) + ' у поля на ' + q.fieldQuestions + ' сопоставимых вопросах. Позиция вопроса не доказывает причину результата.', value: q.excessPerQuestion, question: q.number });
    }
    const authors = byAuthor(ts).filter(a => a.eligible && a.knownAnswers >= 20 && a.fieldQuestions >= 20);
    if (authors.length > 1) {
      const a = authors.slice().sort((x, y) => y.excessPerQuestion - x.excessPerQuestion)[0];
      output.push({ type: 'author', title: 'Удачная авторская группа', text: a.name + ': ' + (a.excess >= 0 ? '+' : '') + num(a.excess) + ' к среднему полю на ' + a.fieldQuestions + ' вопросах из диапазонов в титрах. Это связь с группой авторов, а не доказательство индивидуального авторства.', value: a.excess, authorId: a.id });
    }
    const roster = byPlayer(ts).filter(p => p.eligible && p.performanceGames >= 3);
    if (roster.length > 1) {
      const p = roster.slice().sort((a, b) => b.avgPerformance - a.avgPerformance)[0];
      output.push({ type: 'player', title: 'Перфоманс с игроком в составе', text: p.name + ': средний перфоманс команды ' + num(p.avgPerformance) + ' по ' + p.performanceGames + ' играм. Это результат всей команды при участии игрока; его личный вклад и причинный эффект из этих данных не видны.', value: p.avgPerformance, playerId: p.id });
    }
    const frequentPair = pairs(ts).filter(p => p.eligible)[0];
    if (frequentPair) output.push({ type: 'pair', title: 'Самая частая связка в составе', text: frequentPair.name + ': совместных турниров — ' + frequentPair.games + (frequentPair.performanceGames ? ', средний перфоманс команды — ' + num(frequentPair.avgPerformance) + ' по ' + frequentPair.performanceGames + ' играм.' : '.'), value: frequentPair.games, pairId: frequentPair.id });
    const timeline = trend(ts).filter(t => t.performance !== null);
    if (timeline.length >= 8) {
      const midpoint = Math.floor(timeline.length / 2), before = timeline.slice(0, midpoint), after = timeline.slice(midpoint);
      const oldMedian = median(before.map(t => t.performance)), newMedian = median(after.map(t => t.performance)), change = newMedian - oldMedian;
      output.push({ type: 'trend', title: 'Динамика перфоманса', text: 'Медианный перфоманс: ' + num(oldMedian) + ' в первых ' + before.length + ' играх и ' + num(newMedian) + ' в последних ' + after.length + '. Изменение ' + (change >= 0 ? '+' : '') + num(change) + ' балла; это описательная динамика, а не оценка причины изменений.', value: change });
    }
    if (s.missingPerformanceGames) output.push({ type: 'coverage', title: 'Покрытие перфоманса', text: 'Для ' + s.missingPerformanceGames + ' из ' + s.games + ' игр нет оценки. Они исключены из среднего перфоманса, а не заменены нулём.', value: s.performanceGames / s.games });
    if (s.knownAnswers < s.totalQuestions) output.push({ type: 'coverage', title: 'Покрытие вопросной статистики', text: 'Известны ответы на ' + s.knownAnswers + ' из ' + s.totalQuestions + ' неснятых вопросов (' + pct(s.masksCoverage.questions || 0) + '). Пропуски не считаются невзятиями.', value: s.masksCoverage.questions });
    return output;
  }

  return {
    version: '2.0.0', filter, summarize, byQuestion, byRound, byPlayer, pairs, byEditor, byAuthor, questionDetails, insights, trend, percentile, performance,
    methodology: {
      rates: 'Все доли 0..1; перцентили 0..100. Доли взятий взвешены числом известных ответов 0/1. Неизвестные и снятые вопросы исключены.',
      performance: 'Перфоманс — официальный турнирный балл B (rating.b), выбранный пользователем. Среднее и медиана считаются по турнирам с известным B; каждый турнир имеет одинаковый вес. B=0 и рассчитанный B при inRating=false сохраняются. B учитывает место и силу поля, но не включает trueDL напрямую. Полный балл турнира не приписывается отдельным вопросам, турам и авторским диапазонам.',
      officialScore: 'Сумма официальных очков считается отдельно от суммы единиц в опубликованной маске.',
      field: 'Среднее поля и разница с полем рассчитаны только по тем же вопросам с известным ответом команды и долей поля. Это не рейтинговый прогноз. Команда может входить в поле.',
      percentile: '100 × (число команд − официальное место) / (число команд − 1); дробное официальное место учитывает ничьи.',
      players: 'Статистика результатов команды в турнирах с игроком в опубликованной заявке. Не личные взятия и не причинный эффект игрока.',
      editors: 'Результаты на полных пакетах, где редактор указан в титрах. Не индивидуальное авторство вопросов.',
      authors: 'Группы соавторов из титров диапазонов вопросов. Титры рейтинга распознаны автоматически, возможны ошибки. Внутри группы вопрос учитывается один раз. Разные группы могут пересекаться; их итоги нельзя складывать. Авторы в группе не приписываются каждому вопросу индивидуально. Неоднозначные кандидаты не разворачиваются в соавторов.',
      comparisons: 'Все строки видны; eligible=true для групп минимум из трёх турниров. Размер и сложность выборок различаются; сравнения описательные.',
      streaks: 'Серии считаются внутри одного турнира. Неизвестная или снятая отметка прерывает серию.',
      podiums: 'При доступном распределении очков учитывается стартовая позиция группы равных результатов (включая разделённые места). Иначе используется официальное место.'
    }
  };
});
