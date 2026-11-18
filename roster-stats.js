/* Tournament-level associations between declared roster size and performance. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiRosterStats = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b), n = sorted.length;
    return n ? sorted[Math.floor((n - 1) / 2)] / 2 + sorted[Math.ceil((n - 1) / 2)] / 2 : null;
  };

  // A roster is the API teamMembers list, not attendance at the playing table.
  // Empty or partly unidentifiable lists cannot establish an exact headcount.
  function rosterSize(tournament) {
    const players = tournament && tournament.players;
    if (!Array.isArray(players) || !players.length) return null;
    const ids = new Set();
    for (const player of players) {
      let identity;
      if (player && typeof player === 'object' && player.id !== null && player.id !== undefined && String(player.id).trim()) {
        identity = 'id:' + String(player.id);
      } else {
        const name = typeof player === 'string' ? player : player && typeof player.name === 'string' ? player.name : '';
        if (!name.trim()) return null;
        identity = 'name:' + name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
      }
      ids.add(identity);
    }
    return ids.size || null;
  }

  // Lanczos log-gamma and the continued fraction for regularized beta give
  // Student-t quantiles without a charting/statistics dependency or simulation.
  function logGamma(z) {
    const c = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < .5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z--;
    let x = .99999999999980993;
    for (let i = 0; i < c.length; i++) x += c[i] / (z + i + 1);
    const t = z + c.length - .5;
    return .5 * Math.log(2 * Math.PI) + (z + .5) * Math.log(t) - t + Math.log(x);
  }

  function betaFraction(a, b, x) {
    const floor = 1e-300, eps = 3e-14;
    const nonzero = value => Math.abs(value) < floor ? (value < 0 ? -floor : floor) : value;
    let c = 1, d = 1 / nonzero(1 - (a + b) * x / (a + 1)), result = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((a - 1 + m2) * (a + m2));
      d = 1 / nonzero(1 + aa * d); c = nonzero(1 + aa / c); result *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + 1 + m2));
      d = 1 / nonzero(1 + aa * d); c = nonzero(1 + aa / c);
      const delta = d * c; result *= delta;
      if (Math.abs(delta - 1) < eps) return result;
    }
    return result;
  }

  function regularizedBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
    return x < (a + 1) / (a + b + 2)
      ? factor * betaFraction(a, b, x) / a
      : 1 - factor * betaFraction(b, a, 1 - x) / b;
  }

  function tCritical(df, confidence) {
    const p = (1 + confidence) / 2;
    const cdf = t => 1 - .5 * regularizedBeta(df / (df + t * t), df / 2, .5);
    let lower = 0, upper = 1;
    while (cdf(upper) < p) upper *= 2;
    for (let i = 0; i < 70; i++) {
      const middle = lower + (upper - lower) / 2;
      if (cdf(middle) < p) lower = middle; else upper = middle;
    }
    return lower + (upper - lower) / 2;
  }

  function meanInterval(values, options) {
    const confidence = options && options.confidence !== undefined ? options.confidence : .95;
    if (!isNumber(confidence) || confidence <= 0 || confidence >= 1) throw new RangeError('Confidence must be between 0 and 1.');
    const valid = (Array.isArray(values) ? values : []).filter(isNumber), count = valid.length;
    if (!count) return { count: 0, mean: null, median: null, sd: null, se: null, lower: null, upper: null, confidence, method: 'student-t' };
    // Scaling first prevents overflow when summing a long list of large values.
    const mean = valid.reduce((sum, value) => sum + value / count, 0);
    const variance = count > 1 ? valid.reduce((sum, value) => sum + Math.pow(value - mean, 2) / (count - 1), 0) : null;
    const sd = variance !== null && isNumber(variance) ? Math.sqrt(variance) : null;
    const se = sd !== null ? sd / Math.sqrt(count) : null;
    const halfWidth = se !== null ? tCritical(count - 1, confidence) * se : null;
    const low = halfWidth !== null ? mean - halfWidth : null, high = halfWidth !== null ? mean + halfWidth : null;
    return {
      count, mean: isNumber(mean) ? mean : null, median: median(valid), sd, se,
      lower: isNumber(low) ? low : null, upper: isNumber(high) ? high : null,
      confidence, method: 'student-t'
    };
  }

  function summarize(tournaments, options) {
    const o = options || {};
    if (typeof o.performance !== 'function') throw new TypeError('Provide an official performance accessor.');
    const confidence = o.confidence === undefined ? .95 : o.confidence;
    // Validate even when there are no games.
    meanInterval([], { confidence });
    const groups = new Map();
    const ensure = size => {
      if (!groups.has(size)) groups.set(size, { size, games: 0, missingPerformance: 0, individualGames: [] });
      return groups.get(size);
    };
    for (const size of o.sizes || [1, 2, 3, 4, 5, 6]) if (Number.isInteger(size) && size > 0) ensure(size);
    const totals = { totalGames: 0, knownRosterGames: 0, unknownRosterGames: 0, performanceGames: 0, groupedPerformanceGames: 0, missingPerformanceGames: 0, excludedGames: 0 };
    for (const t of Array.isArray(tournaments) ? tournaments : []) {
      if (!t || t.included === false) { if (t) totals.excludedGames++; continue; }
      totals.totalGames++;
      const performance = o.performance(t), valid = isNumber(performance), size = rosterSize(t);
      if (valid) totals.performanceGames++; else totals.missingPerformanceGames++;
      if (size === null) { totals.unknownRosterGames++; continue; }
      totals.knownRosterGames++;
      const group = ensure(size);
      group.games++;
      if (!valid) { group.missingPerformance++; continue; }
      totals.groupedPerformanceGames++;
      group.individualGames.push({ id: t.id, name: t.name || '', date: t.date || '', performance, rosterSize: size });
    }
    return {
      ...totals, confidence, method: 'student-t', unit: 'tournament',
      groups: Array.from(groups.values()).sort((a, b) => a.size - b.size).map(group => ({
        ...group, ...meanInterval(group.individualGames.map(t => t.performance), { confidence })
      }))
    };
  }

  return { rosterSize, meanInterval, summarize };
});
