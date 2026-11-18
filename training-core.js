/* Training uses package trueDL; it never assigns package difficulty to a question. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SamuraiTrainingCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const authorCollator = new Intl.Collator('ru', { usage: 'sort', sensitivity: 'variant', numeric: true });
  const cleanAuthorName = value => String(value || '').normalize('NFC').replace(/\([^)]*\)/gu, ' ').replace(/\s+/gu, ' ').trim();
  const commonGivenNames = new Set('александр александра алексей андрей анна анастасия артем борис валерий виктор виталий владимир дарья денис дмитрий евгений екатерина елена игорь иван илья ирина константин максим мария михаил наталья николай олег ольга павел петр роман сергей софия софья татьяна юлия'.split(' '));
  const isGivenName = value => commonGivenNames.has(value.toLocaleLowerCase('ru').replace(/ё/g, 'е'));
  function authorSortKey(author) {
    const surname = cleanAuthorName(author.surname) || cleanAuthorName(author.lastName);
    if (surname) return surname;
    const name = cleanAuthorName(author.name);
    // Published author names are normally given name + surname. A comma
    // explicitly marks the reverse form; city annotations are not surnames.
    if (name.includes(',')) return name.split(',')[0].trim();
    const parts = name.split(' ');
    // A few sources publish surname + given name without a comma. Reverse
    // only clear two-token cases; two possible given names remain ambiguous.
    if (parts.length === 2 && !/^(?:\p{L}\.)+$/u.test(parts[0]) && !isGivenName(parts[0]) && isGivenName(parts[1])) return parts[0];
    return parts.pop() || '';
  }
  function compareAuthors(a, b) {
    const idA = String(a.id), idB = String(b.id);
    return authorCollator.compare(authorSortKey(a), authorSortKey(b)) || authorCollator.compare(cleanAuthorName(a.name), cleanAuthorName(b.name)) || authorCollator.compare(idA, idB) || (idA < idB ? -1 : idA > idB ? 1 : 0);
  }
  function normalizeAnswer(value) {
    // Only literal variants are accepted. In particular, C++ ≠ C and 2 ≠ 20.
    return String(value || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/u, '').trim();
  }
  function literalMatch(answer, question) {
    const normalized = normalizeAnswer(answer);
    if (!normalized) return false;
    return [question.answer, ...(Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [])].some(candidate => typeof candidate === 'string' && normalizeAnswer(candidate) === normalized);
  }
  function questions(data) {
    const seen = new Set();
    const packagesById = new Map((data && Array.isArray(data.packages) ? data.packages : []).filter(p => p && p.id != null).map(p => [String(p.id), p]));
    const records = Array.isArray(data) ? data : data && Array.isArray(data.questions) ? data.questions : [];
    return records.map(record => {
      if (!record || typeof record !== 'object') return record;
      const { packageId, ...q } = record;
      // Compact archives store each package once. Sessions and older archives
      // already carry the full package; both normalize to the same runtime form.
      return { ...q, package: q.package || (packageId != null ? packagesById.get(String(packageId)) : undefined) };
    }).filter(q => {
      const hasText = q && typeof q.text === 'string' && q.text.trim();
      const hasMedia = q && Array.isArray(q.media) && q.media.length > 0;
      const hasAnswer = q && typeof q.answer === 'string' && q.answer.trim();
      const publishedWithoutAnswer = q && q.flags && q.flags.missingAnswer === true;
      const publishedWithoutText = q && q.flags && q.flags.missingQuestionText === true;
      if (!q || q.id == null || !String(q.id).trim() || !hasText && !hasMedia && !publishedWithoutText || !hasAnswer && !publishedWithoutAnswer || !q.package || seen.has(String(q.id))) return false;
      seen.add(String(q.id)); return true;
    }).map(q => ({ ...q, id: String(q.id), text: typeof q.text === 'string' && q.text.trim() ? q.text : q.flags && q.flags.missingQuestionText === true ? 'В источнике отсутствует текст вопроса.' : 'Вопрос содержит приложение.', answer: typeof q.answer === 'string' ? q.answer : '', acceptedAnswers: (Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : []).filter(v => typeof v === 'string'), authors: [...new Map((Array.isArray(q.authors) ? q.authors : []).filter(a => a && a.name).map(a => [String(a.id || a.name), { id: String(a.id || a.name), name: String(a.name), ...(typeof a.surname === 'string' ? { surname: a.surname } : {}), ...(typeof a.lastName === 'string' ? { lastName: a.lastName } : {}) }])).values()], media: Array.isArray(q.media) ? q.media : [], package: { ...q.package, trueDl: finite(q.package.trueDl) ? q.package.trueDl : null } }));
  }
  function authors(pool) {
    const result = new Map();
    pool.forEach(q => q.authors.forEach(a => { const item = result.get(a.id) || { ...a, questions: 0 }; item.questions++; result.set(a.id, item); }));
    return [...result.values()].sort(compareAuthors);
  }
  function candidates(pool, config, seenIds) {
    const seen = new Set((seenIds || []).map(String));
    const selectedAuthors = Array.isArray(config.authors) ? new Set(config.authors.map(String)) : null;
    const selectedQuestions = Array.isArray(config.questionIds) ? new Set(config.questionIds.map(String)) : null;
    const excludedPackages = new Set((Array.isArray(config.excludePackageIds) ? config.excludePackageIds : []).map(String));
    return pool.filter(q => {
      if (selectedQuestions && !selectedQuestions.has(String(q.id))) return false;
      // A registration without matched author IDs must fail closed. Empty is
      // not the same as the unrestricted manual author selector.
      if (config.registrationId && (!selectedAuthors || !selectedAuthors.size)) return false;
      if (selectedAuthors && !q.authors.some(a => selectedAuthors.has(a.id))) return false;
      if (excludedPackages.has(String(q.package.id))) return false;
      if (config.registrationId && (q.package.ratingTournamentIds || [q.package.ratingTournamentId]).some(id => String(id) === String(config.registrationId))) return false;
      // Retain incomplete source records in the archive, but never offer an
      // unanswerable record or expose a source omission as a training question.
      if (q.flags && (q.flags.missingAnswer === true || q.flags.missingQuestionText === true && !(Array.isArray(q.media) ? q.media : []).some(m => m && ['question', 'handout'].includes(m.role) && typeof m.url === 'string' && m.url.trim()))) return false;
      return (!config.author || config.author === 'all' || q.authors.some(a => a.id === String(config.author))) && (!config.format || config.format === 'all' || (q.package.type || 'kvrm') === config.format) && (!finite(config.difficulty) || finite(q.package.trueDl) && Math.abs(q.package.trueDl - config.difficulty) <= config.tolerance + 1e-10) && (!config.excludeSeen || !seen.has(q.id));
    });
  }
  function registrations(data, now, includePast) {
    const instant = finite(now) ? now : Date.now();
    return ((data && Array.isArray(data.tournaments)) ? data.tournaments : []).filter(t => t && t.tournamentId != null).map(t => {
      const start = Date.parse(t.dateStart), end = Date.parse(t.dateEnd);
      const status = t.teamResultsAvailable === true ? 'played' : Number.isFinite(end) && end <= instant ? 'past' : Number.isFinite(start) && start > instant ? 'upcoming' : Number.isFinite(start) && Number.isFinite(end) && start <= instant && instant < end ? 'active' : 'unknown';
      return { ...t, status };
    }).filter(t => includePast || ['active', 'upcoming'].includes(t.status)).sort((a, b) => {
      const order = { active: 0, upcoming: 1, past: 2, played: 2, unknown: 3 };
      return order[a.status] - order[b.status] || (['past', 'played'].includes(a.status) ? Date.parse(b.dateStart) - Date.parse(a.dateStart) : Date.parse(a.dateStart) - Date.parse(b.dateStart)) || Number(a.tournamentId) - Number(b.tournamentId);
    });
  }
  function registrationConfig(preset, previous) {
    const config = { ...(previous || {}) };
    delete config.authors; delete config.excludePackageIds; delete config.registrationName; delete config.authorBasis;
    delete config.questionIds; delete config.focusLabel; delete config.focusKind; delete config.focusDescription; delete config.remediation;
    if (!preset) return { ...config, registrationId: '' };
    const authors = [...new Set((Array.isArray(preset.authors) ? preset.authors : []).filter(a => a && a.id != null).map(a => String(a.id)))];
    return { ...config, author: 'all', registrationId: String(preset.tournamentId), registrationName: preset.name, authorBasis: preset.authorBasis, authors, excludePackageIds: (preset.targetPackageIds || []).map(String), ...(finite(preset.difficultyForecast) ? { difficulty: preset.difficultyForecast, anyDifficulty: false } : {}) };
  }
  function shuffle(pool, random) {
    const result = pool.slice();
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor((random || Math.random)() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  }
  function createSession(pool, config, now, random) {
    const chosen = shuffle(pool, random).slice(0, Math.max(1, Math.min(100, Number(config.count) || 10)));
    if (!chosen.length) return null;
    return { version: 1, id: `training-${now}-${Math.floor((random || Math.random)() * 1e8)}`, createdAt: now, completedAt: null, config: { ...config }, index: 0, status: 'reading', paused: false, questions: chosen.map(q => ({ ...q, authors: q.authors.map(a => ({ ...a })), package: { ...q.package } })), attempts: chosen.map(() => ({ answer: '', status: 'unplayed', grade: null, gradeSource: null, elapsed: null })), clock: null };
  }
  function current(session) { return session && session.attempts[session.index]; }
  function startTimer(session, now) {
    if (!session || session.status !== 'reading' || !finite(now)) return false;
    session.status = 'running'; session.paused = false;
    session.clock = { startedAt: now, thinkDeadline: now + 60000, submitDeadline: now + 70000, signal50: false, signal60: false, pausedAt: null };
    return true;
  }
  function elapsed(session, now) { return !session || !session.clock ? 0 : Math.max(0, Math.min(70000, (session.paused ? session.clock.pausedAt : now) - session.clock.startedAt)); }
  function phase(session, now) {
    if (!session) return 'setup';
    if (session.status !== 'running') return session.status;
    const clockNow = session.paused ? session.clock.pausedAt : now;
    return clockNow < session.clock.thinkDeadline ? 'thinking' : 'submission';
  }
  function remaining(session, now) {
    if (session && session.status === 'reading') return 60;
    if (!session || session.status !== 'running') return 0;
    const clockNow = session.paused ? session.clock.pausedAt : now;
    return Math.max(0, Math.ceil(((phase(session, now) === 'thinking' ? session.clock.thinkDeadline : session.clock.submitDeadline) - clockNow) / 1000));
  }
  function lock(session, now, status) {
    if (!session || session.status !== 'running') return;
    const attempt = current(session), q = session.questions[session.index];
    attempt.elapsed = elapsed(session, now) / 1000;
    attempt.status = status || (String(attempt.answer).trim() ? 'answered' : 'empty');
    if (status === 'skipped') attempt.answer = '';
    if (!String(attempt.answer).trim()) { attempt.grade = 0; attempt.gradeSource = 'empty'; }
    else if (literalMatch(attempt.answer, q)) { attempt.grade = 1; attempt.gradeSource = 'literal'; }
    else { attempt.grade = null; attempt.gradeSource = null; }
    session.status = 'locked'; session.paused = false;
  }
  function advance(session, now) {
    const events = [];
    if (!session || session.status !== 'running' || session.paused) return events;
    if (!session.clock.signal50 && now >= session.clock.startedAt + 50000) { session.clock.signal50 = true; events.push('signal50'); }
    if (!session.clock.signal60 && now >= session.clock.thinkDeadline) { session.clock.signal60 = true; events.push('signal60'); }
    if (now >= session.clock.submitDeadline) { lock(session, session.clock.submitDeadline); events.push('locked'); }
    return events;
  }
  function pause(session, now) {
    advance(session, now);
    if (!session || session.status !== 'running' || session.paused) return false;
    session.clock.pausedAt = now; session.paused = true; return true;
  }
  function resume(session, now) {
    if (!session || session.status !== 'running' || !session.paused) return false;
    const shift = Math.max(0, now - session.clock.pausedAt);
    session.clock.startedAt += shift; session.clock.thinkDeadline += shift; session.clock.submitDeadline += shift; session.clock.pausedAt = null; session.paused = false; return true;
  }
  function next(session, now) {
    if (!session || session.status !== 'locked') return false;
    if (session.index >= session.questions.length - 1) { finish(session, now); return false; }
    session.index++; session.status = 'reading'; session.paused = false; session.clock = null; return true;
  }
  function finish(session, now) {
    if (!session || ['complete', 'results'].includes(session.status)) return;
    if (session.status === 'running') lock(session, now);
    session.status = 'complete'; session.completedAt = now; session.paused = false;
  }
  function grade(session, index, value) {
    const attempt = session && session.attempts[index];
    if (!attempt || attempt.status === 'unplayed' || ![0, 1, null].includes(value)) return false;
    attempt.grade = value; attempt.gradeSource = value === null ? null : 'self'; return true;
  }
  function summary(session) {
    const rows = session.questions.map((q, i) => { const { answer: officialAnswer, ...question } = q; const { answer: submittedAnswer, ...attempt } = session.attempts[i]; return { ...question, index: i, ...attempt, officialAnswer, submittedAnswer }; }).filter(r => r.status !== 'unplayed');
    const judged = rows.filter(r => r.grade === 0 || r.grade === 1), correct = judged.filter(r => r.grade === 1).length;
    const authorRows = new Map(), packageRows = new Map();
    rows.forEach(r => {
      r.authors.forEach(author => { const item = authorRows.get(author.id) || { ...author, count: 0, judged: 0, correct: 0 }; item.count++; if (r.grade !== null) { item.judged++; item.correct += r.grade; } authorRows.set(author.id, item); });
      const key = String(r.package.id || r.package.name);
      const p = packageRows.get(key) || { id: key, name: r.package.name, trueDl: r.package.trueDl, count: 0, judged: 0, correct: 0 }; p.count++; if (r.grade !== null) { p.judged++; p.correct += r.grade; } packageRows.set(key, p);
    });
    const ratedDifficulties = rows.map(r => r.package.trueDl).filter(finite);
    return { rows, total: session.questions.length, attempted: rows.length, unplayed: session.questions.length - rows.length, judged: judged.length, correct, incorrect: judged.length - correct, pending: rows.length - judged.length, empty: rows.filter(r => !String(r.submittedAnswer).trim()).length, rate: judged.length ? correct / judged.length : null, avgTime: average(rows.map(r => r.elapsed).filter(finite)), correctTime: average(rows.filter(r => r.grade === 1).map(r => r.elapsed).filter(finite)), incorrectTime: average(rows.filter(r => r.grade === 0).map(r => r.elapsed).filter(finite)), authors: [...authorRows.values()], packages: [...packageRows.values()], meanPackageDifficulty: average(ratedDifficulties), difficultyRatedQuestions: ratedDifficulties.length, missingDifficultyQuestions: rows.length - ratedDifficulties.length };
  }
  function progress(sessions, currentSession) {
    const unique = new Map((sessions || []).filter(validSession).map(s => [s.id, s]));
    if (validSession(currentSession)) unique.set(currentSession.id, currentSession);
    const rows = [...unique.values()].filter(s => ['complete', 'results'].includes(s.status)).sort((a, b) => a.createdAt - b.createdAt).map(s => ({ id: s.id, createdAt: s.createdAt, author: Array.isArray(s.config && s.config.authors) ? 'authors:' + [...s.config.authors].map(String).sort().join('|') : String(s.config && s.config.author || 'all'), format: String(s.config && s.config.format || 'kvrm'), ...summary(s) }));
    const current = currentSession && rows.find(row => row.id === currentSession.id);
    let comparison = null;
    if (current && current.pending === 0 && current.attempted >= 3 && finite(current.meanPackageDifficulty)) {
      const similar = rows.filter(row => row.createdAt < current.createdAt && row.pending === 0 && row.attempted >= 3 && row.author === current.author && row.format === current.format && finite(row.meanPackageDifficulty) && Math.abs(row.meanPackageDifficulty - current.meanPackageDifficulty) <= .5);
      if (similar.length >= 3) { const previousRate = average(similar.map(row => row.rate)); comparison = { count: similar.length, previousRate, currentRate: current.rate, delta: current.rate - previousRate }; }
    }
    return { rows, comparison };
  }
  function validSession(session) {
    if (!session || session.version !== 1 || typeof session.id !== 'string' || !finite(session.createdAt) || !Array.isArray(session.questions) || !Array.isArray(session.attempts) || !session.questions.length || session.questions.length > 100 || session.questions.length !== session.attempts.length || !['reading', 'running', 'locked', 'complete', 'results'].includes(session.status) || !Number.isInteger(session.index) || session.index < 0 || session.index >= session.questions.length) return false;
    if (questions(session.questions).length !== session.questions.length || !session.questions.every(q => typeof q.answer === 'string' && (q.package.trueDl === null || finite(q.package.trueDl)) && Array.isArray(q.authors) && q.authors.every(a => a && typeof a.id === 'string' && typeof a.name === 'string') && Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.every(a => typeof a === 'string') && Array.isArray(q.media)) || !session.attempts.every(a => a && typeof a.answer === 'string' && ['unplayed', 'answered', 'empty', 'skipped'].includes(a.status) && [null, 0, 1].includes(a.grade) && (a.elapsed === null || finite(a.elapsed) && a.elapsed >= 0 && a.elapsed <= 70))) return false;
    if (session.status === 'reading') return session.clock === null && !session.paused && current(session).status === 'unplayed';
    return session.status !== 'running' || session.clock && [session.clock.startedAt, session.clock.thinkDeadline, session.clock.submitDeadline].every(finite) && session.clock.thinkDeadline === session.clock.startedAt + 60000 && session.clock.submitDeadline === session.clock.thinkDeadline + 10000 && (!session.paused || finite(session.clock.pausedAt) && session.clock.pausedAt >= session.clock.startedAt && session.clock.pausedAt < session.clock.submitDeadline);
  }
  return { normalizeAnswer, literalMatch, questions, authorSortKey, compareAuthors, authors, candidates, registrations, registrationConfig, shuffle, createSession, startTimer, current, elapsed, phase, remaining, lock, advance, pause, resume, next, finish, grade, summary, progress, validSession };
});
