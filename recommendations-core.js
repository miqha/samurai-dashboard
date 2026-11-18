/* Public-data recommendations. This is an empirical team fit, not an official rating. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiRecommendations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const REMOTE_TYPES = new Set([3, 6, 8]);
  const number = value => typeof value === 'number' && Number.isFinite(value);
  const validDL = value => number(value) && value >= 0 && value <= 10;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const asArray = input => Array.isArray(input) ? input : (input && Array.isArray(input.tournaments) ? input.tournaments : []);
  const timestamp = value => {
    if (value instanceof Date) return value.getTime();
    if (number(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return NaN;
    // Timestamps from Rating carry offsets. A date-only input is explicitly UTC,
    // never interpreted in the browser's local time zone.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(value + 'T00:00:00Z');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) return Date.parse(value + 'Z');
    return Date.parse(value);
  };
  const typeId = tournament => Number(tournament.type && typeof tournament.type === 'object' ? tournament.type.id : tournament.type);
  const totalQuestions = tournament => {
    if (number(tournament.totalQuestions) && tournament.totalQuestions > 0) return tournament.totalQuestions;
    const values = Array.isArray(tournament.questionQty) ? tournament.questionQty : Object.values(tournament.questionQty || {});
    const total = values.reduce((sum, value) => sum + (number(value) && value > 0 ? value : 0), 0);
    return total || null;
  };
  const indexDifficulty = difficulty => {
    const values = asArray(difficulty);
    if (values.length) return new Map(values.map(row => [String(row.id), row]));
    if (difficulty && typeof difficulty === 'object') {
      const source = difficulty.byId || difficulty;
      return new Map(Object.entries(source).filter(([, value]) => value && typeof value === 'object').map(([key, value]) => [String(value.id || key), value]));
    }
    return new Map();
  };
  const metadata = (tournament, index) => ({ ...(index.get(String(tournament.id)) || {}), ...tournament });
  const published = tournament => tournament.included === true || (tournament.resultsAvailable === true && number(tournament.score));

  function answers(tournament) {
    const canceled = new Set((tournament.canceledQuestions || []).filter(value => value !== null && value !== undefined).map(value => Number(typeof value === 'object' ? value.questionNumber || value.number : value)));
    const mask = typeof tournament.mask === 'string' ? tournament.mask : '';
    const limit = totalQuestions(tournament) || mask.length;
    let takes = 0, questions = 0;
    for (let i = 0; i < Math.min(mask.length, limit); i++) {
      if (!canceled.has(i + 1) && (mask[i] === '0' || mask[i] === '1')) {
        questions++;
        takes += Number(mask[i]);
      }
    }
    // A missing mask is not a zero result. Only an explicitly published score
    // can supply a fallback, and only with a known valid denominator.
    if (!mask && published(tournament) && number(tournament.score) && limit && tournament.score >= 0 && tournament.score <= limit - canceled.size) {
      return { takes: tournament.score, questions: limit - canceled.size, source: 'published-score' };
    }
    return { takes, questions, source: 'mask' };
  }

  function availability(tournament, now = Date.now()) {
    const current = timestamp(now), start = timestamp(tournament.dateStart || tournament.date), end = timestamp(tournament.dateEnd);
    const requests = timestamp(tournament.dateRequestsAllowedTo), download = timestamp(tournament.dateDownloadQuestionsFrom), downloadTo = timestamp(tournament.dateDownloadQuestionsTo);
    const explicitlyCanceled = tournament.cancelled === true || tournament.canceled === true || tournament.isCancelled === true || tournament.isCanceled === true || tournament.cancellationStatus === 'cancelled' || tournament.cancellationStatus === 'canceled';
    let status = 'unknown';
    if (explicitlyCanceled) status = 'cancelled';
    else if ([current, start, end].every(Number.isFinite) && end > start) {
      status = current < start ? 'upcoming' : current >= end ? 'expired' : 'active';
    }
    return { status, opensAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
      closesAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
      millisecondsRemaining: Number.isFinite(end) && Number.isFinite(current) ? Math.max(0, end - current) : null,
      daysRemaining: Number.isFinite(end) && Number.isFinite(current) ? Math.max(0, (end - current) / DAY) : null,
      requestsAllowedTo: Number.isFinite(requests) ? new Date(requests).toISOString() : null,
      registrationClosed: Number.isFinite(requests) && Number.isFinite(current) ? current >= requests : false,
      registrationDeadlineKnown: Number.isFinite(requests),
      downloadQuestionsFrom: Number.isFinite(download) ? new Date(download).toISOString() : null,
      downloadQuestionsTo: Number.isFinite(downloadTo) ? new Date(downloadTo).toISOString() : null,
      downloadClosed: Number.isFinite(downloadTo) && Number.isFinite(current) ? current >= downloadTo : false,
      downloadable: Number.isFinite(downloadTo) && Number.isFinite(current) && current >= downloadTo ? false : Number.isFinite(download) && Number.isFinite(current) ? current >= download : null,
      archived: tournament.archive === true,
      venueRequired: true, remoteFormat: REMOTE_TYPES.has(typeId(tournament)) };
  }

  function trainingRows(history, difficulty, kind) {
    const index = indexDifficulty(difficulty);
    return asArray(history).filter(tournament => tournament.included !== false && published(tournament)).map(tournament => {
      const data = metadata(tournament, index), count = answers(tournament);
      return { id: tournament.id, name: tournament.name, date: tournament.dateStart || tournament.date,
        value: data[kind], takes: count.takes, questions: count.questions, takeRate: count.questions ? count.takes / count.questions : null };
    }).filter(row => validDL(row.value) && row.questions > 0)
      .sort((a, b) => (timestamp(a.date) || 0) - (timestamp(b.date) || 0)).slice(-24);
  }

  const probability = (value, level, scale) => 1 / (1 + Math.exp(clamp((value - level) / scale, -30, 30)));

  function fitModel(samples, kind) {
    const games = samples.length, questions = samples.reduce((sum, row) => sum + row.questions, 0);
    const takes = samples.reduce((sum, row) => sum + row.takes, 0);
    const values = samples.map(row => row.value), min = values.length ? Math.min(...values) : null, max = values.length ? Math.max(...values) : null;
    const result = { kind, ready: games >= 6 && questions >= 120 && max - min >= 0.4,
      games, n: games, questions, takes, recentTakeRate: questions ? takes / questions : null,
      range: min === null ? null : [min, max], samples, level: null, scale: null, mae: null, residualSpread: null,
      method: 'recency-weighted-binomial-logistic', recentWindow: 24, halfLifeGames: 8,
      reason: null };
    if (!result.ready) {
      result.reason = games < 6 ? 'Для калибровки нужно не менее 6 опубликованных игр с этой оценкой сложности.' : questions < 120 ? 'Для калибровки нужно не менее 120 известных ответов.' : 'Слишком узкий диапазон сложности для калибровки.';
      return result;
    }
    // Constrained decreasing logistic fit. Grid-search the scale, then solve
    // the weighted likelihood optimum in the intercept by monotone bisection.
    // A weak log-scale penalty avoids unstable extreme slopes in small samples.
    const weighted = samples.map((row, i) => ({ ...row, weight: Math.pow(0.5, (games - 1 - i) / 8) }));
    let best = null;
    for (let step = 0; step <= 100; step++) {
      const scale = 0.30 * Math.pow(20, step / 100);
      let low = -30, high = 40;
      for (let iteration = 0; iteration < 55; iteration++) {
        const level = (low + high) / 2;
        const derivative = weighted.reduce((sum, row) => sum + row.weight * (row.takes - row.questions * probability(row.value, level, scale)), 0);
        if (derivative > 0) low = level; else high = level;
      }
      const level = (low + high) / 2;
      const loss = weighted.reduce((sum, row) => {
        const p = clamp(probability(row.value, level, scale), 1e-9, 1 - 1e-9);
        return sum - row.weight * (row.takes * Math.log(p) + (row.questions - row.takes) * Math.log(1 - p));
      }, 0) + 2 * Math.pow(Math.log(scale / 1.5), 2);
      if (!best || loss < best.loss) best = { scale, level, loss };
    }
    const weightSum = weighted.reduce((sum, row) => sum + row.weight, 0);
    result.level = best.level;
    result.scale = best.scale;
    result.mae = weighted.reduce((sum, row) => sum + row.weight * Math.abs(row.takeRate - probability(row.value, best.level, best.scale)), 0) / weightSum;
    result.residualSpread = Math.sqrt(weighted.reduce((sum, row) => sum + row.weight * Math.pow(row.takeRate - probability(row.value, best.level, best.scale), 2), 0) / weightSum);
    return result;
  }

  function buildModel(history, difficulty) {
    const trueDL = fitModel(trainingRows(history, difficulty, 'trueDL'), 'trueDL');
    const forecast = fitModel(trainingRows(history, difficulty, 'difficultyForecast'), 'difficultyForecast');
    const recent = asArray(history).filter(tournament => tournament.included !== false && published(tournament)).sort((a, b) => (timestamp(a.dateStart || a.date) || 0) - (timestamp(b.dateStart || b.date) || 0)).slice(-24);
    const sum = recent.map(answers).reduce((acc, row) => ({ takes: acc.takes + row.takes, questions: acc.questions + row.questions }), { takes: 0, questions: 0 });
    return { method: 'empirical-team-fit', ready: trueDL.ready || forecast.ready,
      models: { trueDL, difficultyForecast: forecast }, recentGames: recent.length,
      recentTakeRate: sum.questions ? sum.takes / sum.questions : null,
      trainingTarget: [0.30, 0.65],
      notes: [
        'Это эмпирический ориентир по последним 24 опубликованным играм, а не официальный рейтинг команды или гарантия результата.',
        'Фактический trueDL и предварительная оценка редактора калибруются раздельно; единицы этих оценок не подменяют друг друга.',
        'trueDL описывает турнир целиком. Индивидуальная сложность каждого вопроса из него не восстанавливается.',
        'Открытый период проведения не подтверждает наличие площадки, свободных мест или право команды на участие.'
      ] };
  }

  function classify(value, model, kind = 'trueDL', options = {}) {
    const fitted = model && model.models ? model.models[kind] : model;
    const min = number(options.targetMin) ? options.targetMin : 0.30, max = number(options.targetMax) ? options.targetMax : 0.65;
    if (!validDL(value) || !fitted || !fitted.ready) return { fit: 'unrated', label: 'Недостаточно данных', predictedTakeRate: null, extrapolated: false };
    const p = probability(value, fitted.level, fitted.scale);
    const fit = p > max ? 'easy' : p < min ? 'hard' : 'balanced';
    return { fit, label: { easy: 'Разминка', hard: 'Вызов', balanced: 'По уровню' }[fit],
      predictedTakeRate: p, extrapolated: value < fitted.range[0] || value > fitted.range[1] };
  }

  function gotQuestionsUrls(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(tag => tag !== null && tag !== undefined && typeof tag !== 'boolean').map(tag => typeof tag === 'object' ? tag.id : tag).filter(tag => typeof tag !== 'boolean').map(Number).filter(id => Number.isInteger(id) && id > 0))].map(id => 'https://gotquestions.online/pack/' + id);
  }

  function packetIds(tournament) {
    return gotQuestionsUrls(tournament.gotQuestionsTags).map(url => Number(url.split('/').pop()));
  }

  function packageBaseName(name) {
    const formatOnly = /^(?:(?:асинхрон|синхрон|онлайн|офлайн|async|sync|online|offline|а\/о|а\/с|а\/синхрон)[\s,/+·—–-]*)+$/i;
    return String(name || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/\(([^)]*)\)/g, (whole, inner) => formatOnly.test(inner.trim()) ? ' ' : whole)
      .replace(/\s*(?:[—–-]\s*)?(?:асинхрон|синхрон|онлайн|async|sync|online)\s*$/i, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }

  function packageDuplicates(tournament, registered) {
    const ids = new Set(packetIds(tournament)), base = packageBaseName(tournament.name);
    const evidence = [];
    for (const own of registered) {
      if (String(own.id) === String(tournament.id)) continue;
      const shared = packetIds(own).filter(id => ids.has(id));
      if (shared.length) evidence.push({ id: own.id, name: own.name, kind: 'gotquestions-pack-id', packetIds: shared });
      else if (base.length >= 4 && base === packageBaseName(own.name)) evidence.push({ id: own.id, name: own.name, kind: 'normalized-name', packetIds: [] });
    }
    return { confirmedDuplicate: evidence.some(row => row.kind === 'gotquestions-pack-id'),
      possibleDuplicate: evidence.some(row => row.kind === 'normalized-name'), duplicateEvidence: evidence };
  }

  function questionIntersections(tournament, registered, intersections) {
    const own = new Map(registered.map(row => [String(row.id), row]));
    const matched = new Set();
    for (const row of asArray(intersections)) {
      const related = (Array.isArray(row.relatedIds) ? row.relatedIds : []).map(String);
      if (own.has(String(row.id)) && related.includes(String(tournament.id))) matched.add(String(row.id));
      if (String(row.id) === String(tournament.id)) for (const id of related) if (own.has(id)) matched.add(id);
    }
    matched.delete(String(tournament.id));
    return { knownIntersection: matched.size > 0,
      intersectionEvidence: [...matched].map(id => ({ id: own.get(id).id, name: own.get(id).name || 'Турнир ' + id })) };
  }

  function knownForeignLanguage(tournament) {
    const value = tournament.languages || tournament.language;
    if (!value || (Array.isArray(value) && !value.length)) return false;
    const values = (Array.isArray(value) ? value : [value]).map(item => String(typeof item === 'object' ? item.code || item.name || item.shortName || '' : item).toLowerCase());
    return values.some(Boolean) && !values.some(item => /^(ru|rus|russian|русский|рус|русский язык)$/.test(item));
  }

  function rank(catalog, history, difficulty, options = {}) {
    const now = options.now === undefined ? Date.now() : timestamp(options.now);
    const targetMin = number(options.targetMin) ? clamp(options.targetMin) : 0.30;
    const targetMax = number(options.targetMax) ? clamp(options.targetMax) : 0.65;
    if (!Number.isFinite(now)) throw new TypeError('rank: invalid current time');
    if (targetMin >= targetMax) throw new RangeError('rank: targetMin must be below targetMax');
    const model = options.model || buildModel(history, difficulty), index = indexDifficulty(difficulty);
    const historical = new Map(asArray(history).map(row => [String(row.id), row]));
    // Fresh team registrations may be newer than the performance snapshot. An
    // ID seen in either source must never be suggested as a fresh tournament.
    const registeredIds = new Set(historical.keys());
    for (const value of (catalog && Array.isArray(catalog.teamTournamentIds) ? catalog.teamTournamentIds : [])) {
      const id = value && typeof value === 'object' ? value.id : value;
      if (typeof id !== 'boolean' && id !== null && id !== undefined && /^\d+$/.test(String(id))) registeredIds.add(String(id));
    }
    const catalogIndex = new Map(asArray(catalog).map(row => [String(row.id), row]));
    const ownPackages = [...registeredIds].map(id => metadata({ ...(catalogIndex.get(id) || {}), ...(historical.get(id) || {}), id: Number(id) }, index));
    const seen = new Set();
    const all = asArray(catalog).filter(row => row && row.id !== undefined && !seen.has(String(row.id)) && seen.add(String(row.id))).map(tournament => {
      const data = metadata(tournament, index), own = historical.get(String(tournament.id));
      const window = availability(data, now), played = Boolean(own && published(own)), planned = registeredIds.has(String(tournament.id)) && !played;
      const duplicate = packageDuplicates(data, ownPackages);
      const overlap = questionIntersections(data, ownPackages, options.intersections);
      const kind = validDL(data.trueDL) ? 'trueDL' : validDL(data.difficultyForecast) ? 'difficultyForecast' : 'unknown';
      const value = kind === 'unknown' ? null : data[kind];
      const classified = classify(value, model, kind, { targetMin, targetMax });
      const questions = totalQuestions(data), p = classified.predictedTakeRate;
      const gap = p === null ? null : p < targetMin ? targetMin - p : p > targetMax ? p - targetMax : 0;
      const center = (targetMin + targetMax) / 2;
      const fitScore = p === null ? null : clamp(1 - Math.abs(p - center) / Math.max(center, 1 - center));
      const foreignLanguage = knownForeignLanguage(data);
      const eligible = window.remoteFormat && !played && !planned && !foreignLanguage && window.status === 'active' && !window.registrationClosed && !window.archived && !window.downloadClosed && !duplicate.confirmedDuplicate && !duplicate.possibleDuplicate && !overlap.knownIntersection;
      const recommendation = played ? 'Уже сыгран' : planned ? 'Есть в истории или заявках команды; опубликованного результата в снимке нет' : overlap.knownIntersection ? 'Есть пересечения вопросов с турниром из истории или заявок команды' : duplicate.confirmedDuplicate ? 'Пакет уже связан с турниром из истории команды' : duplicate.possibleDuplicate ? 'Возможно, этот пакет уже есть в истории команды' : window.status === 'cancelled' ? 'Отменён' : window.archived ? 'Турнир в архиве; доступ нужно уточнить' : window.registrationClosed ? 'Приём заявок завершён' : window.downloadClosed ? 'Срок получения пакета завершён' : window.status === 'upcoming' ? 'Откроется позже' : !window.remoteFormat ? 'Очный турнир: нужны место и регистрация' : classified.label;
      return { ...data, availability: window, played, planned, foreignLanguage, ...duplicate, ...overlap,
        remotePlayable: window.remoteFormat, eligible,
        difficulty: { value, kind, label: kind === 'trueDL' ? 'Фактический trueDL' : kind === 'difficultyForecast' ? 'Прогноз редактора' : 'Сложность не указана' },
        ...classified, totalQuestions: questions, expectedTaken: p === null || !questions ? null : p * questions,
        fitScore, score: p === null ? -1 : 100 * fitScore - 100 * (gap || 0),
        recommendation, gqUrls: gotQuestionsUrls(data.gotQuestionsTags) };
    });
    const sort = (a, b) => (Number(b.fit === 'balanced') - Number(a.fit === 'balanced')) || (b.score - a.score) || ((timestamp(a.dateEnd) || Infinity) - (timestamp(b.dateEnd) || Infinity)) || String(a.id).localeCompare(String(b.id));
    const notOwned = row => !row.played && !row.planned && !row.confirmedDuplicate && !row.knownIntersection && !row.foreignLanguage && row.availability.status !== 'cancelled';
    const active = all.filter(row => notOwned(row) && row.remotePlayable && row.availability.status === 'active').sort(sort);
    const suggested = active.filter(row => row.eligible && row.fit === 'balanced');
    const upcoming = all.filter(row => notOwned(row) && row.remotePlayable && row.availability.status === 'upcoming').sort(sort);
    const offline = all.filter(row => notOwned(row) && !row.remotePlayable && typeId(row) === 2 && ['active', 'upcoming'].includes(row.availability.status)).sort(sort);
    const planned = all.filter(row => row.planned && ['active', 'upcoming'].includes(row.availability.status)).sort(sort);
    const duplicates = all.filter(row => !row.played && !row.planned && row.confirmedDuplicate);
    const intersections = all.filter(row => !row.played && !row.planned && row.knownIntersection);
    const excluded = all.filter(row => row.played || row.confirmedDuplicate || row.knownIntersection || row.foreignLanguage || ['expired', 'cancelled', 'unknown'].includes(row.availability.status));
    return { model, now: new Date(now).toISOString(), targetMin, targetMax,
      items: [...active, ...upcoming], all, active, suggested, upcoming, offline, planned, duplicates, intersections,
      availableWindow: active, unrated: active.filter(row => row.fit === 'unrated'), excluded,
      summary: { total: all.length, active: active.length, suggested: suggested.length, upcoming: upcoming.length,
        offline: offline.length, planned: planned.length, registrationClosed: active.filter(row => row.availability.registrationClosed).length,
        trueDL: active.filter(row => row.difficulty.kind === 'trueDL').length,
        forecast: active.filter(row => row.difficulty.kind === 'difficultyForecast').length,
        confirmedDuplicates: duplicates.length, possibleDuplicates: active.filter(row => row.possibleDuplicate).length,
        knownIntersections: intersections.length, teamRegistrationsCheckedAt: catalog && catalog.teamHistoryCheckedAt || null,
        unrated: active.filter(row => row.fit === 'unrated').length,
        catalogComplete: Boolean(catalog && catalog.complete), fetchedAt: catalog && catalog.fetchedAt || null } };
  }

  function analysisByDifficulty(history, difficulty, options = {}) {
    const index = indexDifficulty(difficulty), model = options.model || buildModel(history, difficulty);
    const edges = [0, 2, 3, 4, 5, 6, 8, 10.000001];
    const groups = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1], label: from + '–' + Math.min(10, edges[i + 1]), games: 0, questions: 0, takes: 0, sumDL: 0 }));
    const points = [], unknown = [];
    for (const tournament of asArray(history)) {
      if (tournament.included === false || !published(tournament)) continue;
      const data = metadata(tournament, index), count = answers(tournament);
      if (!count.questions) continue;
      if (!number(data.trueDL) || data.trueDL < 0 || data.trueDL > 10) { unknown.push(tournament.id); continue; }
      const bucket = groups.find(row => data.trueDL >= row.from && data.trueDL < row.to);
      bucket.games++; bucket.questions += count.questions; bucket.takes += count.takes; bucket.sumDL += data.trueDL;
      const predicted = classify(data.trueDL, model).predictedTakeRate;
      points.push({ id: data.id, name: data.name, date: data.dateStart || data.date, trueDL: data.trueDL,
        difficultyForecast: number(data.difficultyForecast) ? data.difficultyForecast : null,
        takes: count.takes, questions: count.questions, takeRate: count.takes / count.questions,
        predictedTakeRate: predicted, residual: predicted === null ? null : count.takes / count.questions - predicted,
        gqUrls: gotQuestionsUrls(data.gotQuestionsTags) });
    }
    return { groups: groups.map(row => ({ ...row, takeRate: row.questions ? row.takes / row.questions : null, averageTrueDL: row.games ? row.sumDL / row.games : null })),
      points, measuredGames: points.length, unknownGames: unknown.length, unknownIds: unknown,
      questionRatingsAvailable: false, questionGroups: [],
      note: 'Группировка по фактическому trueDL турнира. Это не оценка отдельных вопросов: Rating не отдаёт их индивидуальную сложность GotQuestions.' };
  }

  return { buildModel, rank, availability, classify, analysisByDifficulty, answers, totalQuestions, gotQuestionsUrls, packageBaseName, packageDuplicates, probability };
});
