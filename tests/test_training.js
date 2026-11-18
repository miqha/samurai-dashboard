'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../training-core.js');
const q = (id, dl = 5, author = 'a', extra = {}) => ({ id: String(id), text: `Настоящий вопрос ${id}`, answer: `Ответ ${id}`, acceptedAnswers: [], authors: [{ id: author, name: `Автор ${author}` }], package: { id: `p${id}`, name: `Пакет ${id}`, trueDl: dl }, ...extra });
const pool = C.questions([q(1), q(1), q(2, null), q(3, 0), q(4, 5.5, 'b'), q(5, 5.51), q(6, 5, 'a', { text: '' }), q(7, 5, 'a', { answer: '' })]);
assert.deepEqual(pool.map(q => q.id), ['1', '2', '3', '4', '5']);
assert.deepEqual(C.questions({ questions: {} }), []);
assert.equal(C.questions([q(9, 5, 'a', { acceptedAnswers: {}, authors: {} })]).length, 1);
assert.equal(pool[1].package.trueDl, null, 'Unrated packages remain available without an invented difficulty');
assert.equal(pool[2].package.trueDl, 0, 'A real zero package difficulty is valid');
assert.deepEqual(C.candidates(pool, { author: 'all', difficulty: 5, tolerance: .5 }).map(q => q.id), ['1', '4']);
assert.deepEqual(C.candidates(pool, { author: 'a', difficulty: 5, tolerance: .5 }).map(q => q.id), ['1']);
assert.deepEqual(C.candidates(pool, { author: 'all', difficulty: 5, tolerance: .5, excludeSeen: true }, ['1']).map(q => q.id), ['4']);
assert.equal(C.authors(pool).length, 2);
assert.equal(C.authors(pool)[0].questions, 4);
const unratedPool = C.questions([null, undefined, '5', false, true, NaN, Infinity].map((dl, index) => q(500 + index, 1, 'a', { package: { id: `unknown-${index}`, name: `Без trueDL ${index}`, trueDl: dl } })));
assert.equal(unratedPool.length, 7, 'Unknown or malformed difficulty must not silently discard source questions');
assert.ok(unratedPool.every(q => q.package.trueDl === null), 'Difficulty strings and booleans are unknown, never coerced to 0 or a rating');
assert.equal(C.candidates(unratedPool, { author: 'all', difficulty: null, tolerance: .5 }).length, 7, 'All difficulties includes every unrated question');
assert.equal(C.candidates(unratedPool, { author: 'all', difficulty: 0, tolerance: .5 }).length, 0, 'Missing difficulty cannot masquerade as 0');
assert.equal(C.candidates(pool, { author: 'all', difficulty: 0, tolerance: 0 }).length, 1, 'A real zero difficulty remains selectable');
const formatPool = C.questions([q(510), q(511, 5, 'a', { package: { id: 'explicit-chgk', type: 'kvrm', trueDl: 5 } }), q(512, 5, 'a', { package: { id: 'si', type: 'si', trueDl: 5 } })]);
assert.deepEqual(C.candidates(formatPool, { format: 'kvrm', difficulty: null }).map(q => q.id), ['510', '511'], 'Legacy questions belong to ЧГК; a specific format excludes SI');
assert.deepEqual(C.candidates(formatPool, { format: 'si', difficulty: null }).map(q => q.id), ['512']);
assert.equal(C.candidates(formatPool, { format: 'all', difficulty: null }).length, 3);
const mediaOnlyPool = C.questions([q(520, null, 'a', { text: '', media: [{ url: 'https://example.org/handout.png' }] })]);
assert.equal(mediaOnlyPool.length, 1, 'Published material-only questions are preserved');
assert.equal(mediaOnlyPool[0].text, 'Вопрос содержит приложение.');
const missingAnswerPool = C.questions([q(530, null, 'a', { answer: '', flags: { missingAnswer: true } }), q(531, null, 'a', { answer: undefined, flags: { missingAnswer: true } }), q(532, 5, 'a', { answer: '' })]);
assert.equal(missingAnswerPool.length, 2, 'Only explicitly flagged source omissions may have an empty official answer');
assert.ok(missingAnswerPool.every(q => q.answer === '' && q.flags.missingAnswer === true));
assert.equal(C.literalMatch('моя версия', missingAnswerPool[0]), false, 'A missing official answer cannot automatically credit a response');
assert.equal(C.candidates(missingAnswerPool, { difficulty: null }).length, 0, 'Incomplete answers stay in the archive but are unavailable for new training');
const incompletePool = C.questions([
  q(540, null, 'a', { text: '', answer: '', flags: { missingQuestionText: true, missingAnswer: true } }),
  q(541, 5, 'a', { text: '', flags: { missingQuestionText: true } }),
  q(542, 5, 'a', { text: '', flags: { missingQuestionText: true }, media: [{ role: 'handout', url: 'https://example.org/handout.png' }] }),
  q(543, 5, 'a', { text: '', flags: { missingQuestionText: true }, media: [{ role: 'question', url: 'https://example.org/question.mp3' }] }),
  q(544, 5, 'a', { text: '', flags: { missingQuestionText: true }, media: [{ role: 'answer', url: 'https://example.org/answer.png' }] }),
  q(545, 5, 'a', { text: 'Ответ ошибочно опубликован в поле текста', answer: '', flags: { missingAnswer: true } })
]);
assert.equal(incompletePool.length, 6, 'Explicit source omissions remain archived, even a completely blank published record');
assert.equal(incompletePool[0].text, 'В источнике отсутствует текст вопроса.');
assert.deepEqual(incompletePool[0].flags, { missingQuestionText: true, missingAnswer: true });
assert.deepEqual(C.candidates(incompletePool, { difficulty: null }).map(q => q.id), ['542', '543'], 'Media-only questions with an official answer are playable; missing text/answer or answer-only media are not');
const sharedPackage = { id: 700, name: 'Общий полный пакет', trueDl: 0, type: 'kvrm', info: { source: 'Опубликованная карточка' }, editors: [{ id: 'editor-1', name: 'Редактор' }], sourceUrl: 'https://example.org/package/700' };
const unrankedPackage = { id: '701', name: 'Пакет без trueDL', trueDl: null, type: 'si', trueDlSources: [] };
const fullArchive = {
  packages: [sharedPackage, unrankedPackage],
  questions: [
    q(570, 5, 'unused', { package: sharedPackage, authors: [{ id: 'a', name: 'Александр Белов', surname: 'Белов' }], flags: { missingAnswer: false }, sourceUrl: 'https://example.org/question/570' }),
    q(571, 5, 'unused', { package: sharedPackage, authors: [{ id: 'b', name: 'И. Андреев', lastName: 'Андреев' }], media: [{ role: 'handout', url: 'https://example.org/handout.png' }] }),
    q(572, null, 'unused', { package: unrankedPackage })
  ]
};
const compactArchive = { packages: fullArchive.packages, questions: fullArchive.questions.map(({ package: pack, ...question }) => ({ ...question, packageId: pack.id })) };
const originalCompact = JSON.stringify(compactArchive), originalFull = JSON.stringify(fullArchive);
const normalizedFull = C.questions(fullArchive), normalizedCompact = C.questions(compactArchive);
assert.deepEqual(normalizedCompact, normalizedFull, 'Compact package references normalize to the same full questions as legacy archives');
assert.equal(normalizedCompact.length, 3, 'Sharing a package does not deduplicate its questions');
assert.deepEqual(normalizedCompact[0].package.editors, sharedPackage.editors);
assert.deepEqual(normalizedCompact[0].package.info, sharedPackage.info);
assert.equal(normalizedCompact[0].sourceUrl, fullArchive.questions[0].sourceUrl);
assert.equal(normalizedCompact[0].authors[0].surname, 'Белов');
assert.equal(normalizedCompact[1].authors[0].lastName, 'Андреев');
assert.equal(normalizedCompact[2].package.trueDl, null);
assert.equal(JSON.stringify(compactArchive), originalCompact, 'Resolving references must not mutate compact source records');
assert.equal(JSON.stringify(fullArchive), originalFull);
assert.equal(C.questions({ packages: fullArchive.packages, questions: [{ ...fullArchive.questions[0], packageId: 'unresolved' }] })[0].package.id, 700, 'An existing full package takes priority over its optional reference');
assert.deepEqual(C.questions({ packages: fullArchive.packages, questions: [{ ...compactArchive.questions[0], packageId: 'unresolved' }] }), [], 'An unresolved reference cannot invent a package');
const compactSession = C.createSession(normalizedCompact, { count: 3, difficulty: null }, 100, () => .99);
assert.equal(C.validSession(JSON.parse(JSON.stringify(compactSession))), true, 'Sessions retain full package context and need no archive lookup');
// Sort published names by surname while preserving their original display form.
assert.equal(C.authorSortKey({ name: 'Иван Карбовник' }), 'Карбовник');
assert.equal(C.authorSortKey({ name: 'Иван Петрович Карбовник (Минск)' }), 'Карбовник');
assert.equal(C.authorSortKey({ name: 'И. Карбовник (Минск)' }), 'Карбовник');
assert.equal(C.authorSortKey({ name: 'Карбовник, Иван (Минск)' }), 'Карбовник');
assert.equal(C.authorSortKey({ name: 'Иван Петров-Сидоров (Москва)' }), 'Петров-Сидоров');
assert.equal(C.authorSortKey({ name: 'Сайландер Дмитрий' }), 'Сайландер');
assert.equal(C.authorSortKey({ name: 'Болгаренко Софья (Москва)' }), 'Болгаренко');
assert.equal(C.authorSortKey({ name: 'Дмитрий Сайландер' }), 'Сайландер');
assert.equal(C.authorSortKey({ name: 'Софья Болгаренко' }), 'Болгаренко');
assert.equal(C.authorSortKey({ name: 'Михаил Александр' }), 'Александр', 'Two plausible given names do not justify reversing the published form');
assert.equal(C.authorSortKey({ name: 'И. Дмитрий' }), 'Дмитрий', 'Initials retain the usual initial + surname interpretation');
assert.equal(C.authorSortKey({ name: 'Сайландер Дмитрий', surname: 'Указанная фамилия' }), 'Указанная фамилия', 'Explicit source surname takes priority over name heuristics');
assert.deepEqual([
  { id: '1', name: 'Софья Соколова' }, { id: '2', name: 'Болгаренко Софья' },
  { id: '3', name: 'Дмитрий Смирнов' }, { id: '4', name: 'Сайландер Дмитрий' }
].sort(C.compareAuthors).map(C.authorSortKey), ['Болгаренко', 'Сайландер', 'Смирнов', 'Соколова']);
assert.equal(C.authorSortKey({ name: 'Другая подпись', surname: '  Абрамов ' }), 'Абрамов');
assert.equal(C.authorSortKey({ name: 'Другая подпись', surname: ' ', lastName: 'Белов' }), 'Белов');
const authorFixtures = [
  { id: 'z', name: 'Александр Яковлев' },
  { id: 'a', name: 'Юрий Абрамов (Москва)' },
  { id: 'same-b', name: 'Иван Белов' },
  { id: 'surname', name: 'Необычная подпись', surname: 'Алексеев' },
  { id: 'comma', name: 'Белов, Алексей' },
  { id: 'initial', name: 'И. Андреев' },
  { id: 'hyphen', name: 'Пётр Андреев-Белов' },
  { id: 'lastName', name: 'Ещё одна подпись', lastName: 'Андреев' },
  { id: 'same-a', name: 'Иван Белов' }
];
const authorPool = C.questions(authorFixtures.map((author, index) => q(100 + index, 5, 'unused', { authors: [author] })));
const authorFixtureOrder = C.authors(authorPool);
assert.deepEqual(authorFixtureOrder.map(a => a.id), ['a', 'surname', 'lastName', 'initial', 'hyphen', 'comma', 'same-a', 'same-b', 'z']);
assert.equal(authorFixtureOrder.find(a => a.id === 'a').name, 'Юрий Абрамов (Москва)', 'Sorting must not rename the dropdown option');
assert.equal(authorFixtureOrder.find(a => a.id === 'surname').surname, 'Алексеев', 'Explicit surnames survive catalog normalization');
assert.equal(authorFixtureOrder.find(a => a.id === 'lastName').lastName, 'Андреев');
assert.deepEqual(C.authors(authorPool.slice().reverse()).map(a => a.id), authorFixtureOrder.map(a => a.id), 'Tied names have deterministic ID order, independent of question order');
const originalAuthorNames = ['Иван Карбовник', 'Валерий Семёнов', 'Евгений Миротин', 'Сергей Коротков', 'Сергей Спешков', 'Андрей Скиренко', 'Игорь Рыльков', 'Виталий Бреев', 'Александр Печёный', 'Максим Мерзляков', 'Андрей Ефимцов', 'Иван Ерёмин', 'Михаил Карачун', 'Алексей Волчок', 'Серафим Шибанов', 'Екатерина Сосенко', 'Наиль Фарукшин', 'Александр Кудрявцев', 'Павел Трощенко', 'Александр Ведехин', 'Алексей Усанов', 'Максим Овчинников', 'Михаил Иванов', 'Николай Лёгенький', 'Павел Солахян', 'Максим Сидоров'];
const originalAuthorPool = C.questions(originalAuthorNames.map((name, index) => q(200 + index, 5, 'unused', { authors: [{ id: `original-${index}`, name }] })));
assert.deepEqual(C.authors(originalAuthorPool).map(C.authorSortKey), ['Бреев', 'Ведехин', 'Волчок', 'Ерёмин', 'Ефимцов', 'Иванов', 'Карачун', 'Карбовник', 'Коротков', 'Кудрявцев', 'Лёгенький', 'Мерзляков', 'Миротин', 'Овчинников', 'Печёный', 'Рыльков', 'Семёнов', 'Сидоров', 'Скиренко', 'Солахян', 'Сосенко', 'Спешков', 'Трощенко', 'Усанов', 'Фарукшин', 'Шибанов'], 'The initial 26 real authors are ordered by Russian surnames, not first names');
assert.equal(C.normalizeAnswer('  Ёжик  в   тумане.  '), 'ежик в тумане');
assert.equal(C.literalMatch('Ежик в тумане', { answer: 'Ёжик в тумане.' }), true);
assert.equal(C.literalMatch('21', { answer: '210' }), false);
assert.equal(C.literalMatch('C', { answer: 'C++' }), false);
assert.equal(C.literalMatch('22', { answer: '2²' }), false, 'Compatibility normalization would manufacture a false numeric match');
assert.equal(C.literalMatch('Пушкин', { answer: 'Александр Пушкин' }), false, 'Substring/fuzzy matching is never automatic');
assert.equal(C.literalMatch('', { answer: '' }), false);
assert.equal(C.literalMatch('Точная альтернатива', { answer: 'Авторский ответ', acceptedAnswers: ['Точная альтернатива'] }), true);
assert.equal(C.literalMatch('Первая версия', { answer: 'Первая версия или вторая версия' }), false, 'Do not parse informal acceptance prose');
const unratedSession = C.createSession(unratedPool, { count: 7, difficulty: null }, 100, () => .99);
assert.equal(C.validSession(unratedSession), true);
assert.equal(C.validSession(JSON.parse(JSON.stringify(unratedSession))), true, 'Unrated sessions survive local history storage');
const missingAnswerSession = C.createSession(missingAnswerPool, { count: 2, difficulty: null }, 100, () => .99);
assert.equal(C.validSession(missingAnswerSession), true);
C.startTimer(missingAnswerSession, 100);
C.current(missingAnswerSession).answer = 'моя версия'; C.finish(missingAnswerSession, 1000);
assert.equal(C.summary(missingAnswerSession).pending, 1, 'Source omissions remain available for review without an automatic false rejection');
assert.equal(C.summary(missingAnswerSession).meanPackageDifficulty, null, 'No rated questions means an unknown average, not 0');
assert.equal(C.summary(missingAnswerSession).difficultyRatedQuestions, 0);
assert.equal(C.summary(missingAnswerSession).missingDifficultyQuestions, 1);
const mixedDifficultySession = C.createSession(C.questions([q(550, 0), q(551, null), q(552, 6)]), { count: 3, difficulty: null }, 100, () => .99);
for (let index = 0; index < 3; index++) { C.startTimer(mixedDifficultySession, 100 + index * 2000); C.lock(mixedDifficultySession, 1000 + index * 2000); C.next(mixedDifficultySession, 1500 + index * 2000); }
assert.equal(C.summary(mixedDifficultySession).meanPackageDifficulty, 3, 'Mean difficulty uses only observed ratings, including a real 0');
assert.equal(C.summary(mixedDifficultySession).difficultyRatedQuestions, 2);
assert.equal(C.summary(mixedDifficultySession).missingDifficultyQuestions, 1);
assert.equal(C.summary(mixedDifficultySession).packages.find(p => p.id === 'p551').trueDl, null);
const malformedSavedSession = JSON.parse(JSON.stringify(unratedSession)); malformedSavedSession.questions[0].package.trueDl = '0';
assert.equal(C.validSession(malformedSavedSession), false, 'Saved sessions require canonical numeric or null difficulty');
const original = C.questions([q(1), q(2), q(3)]), before = JSON.stringify(original);
// Reading is untimed, including after reload or a long background interval.
const readingSession = C.createSession(original, { count: 3 }, 100000, () => .99);
assert.equal(readingSession.status, 'reading');
assert.equal(readingSession.clock, null);
assert.equal(C.phase(readingSession, 220000), 'reading');
assert.equal(C.elapsed(readingSession, 220000), 0);
assert.equal(C.remaining(readingSession, 220000), 60);
assert.deepEqual(C.advance(readingSession, 220000), [], 'Two minutes spent reading trigger no timer or audio events');
assert.equal(C.pause(readingSession, 220000), false);
assert.equal(C.resume(readingSession, 220000), false);
C.lock(readingSession, 220000);
assert.equal(C.current(readingSession).status, 'unplayed', 'A reading question cannot be silently submitted');
assert.equal(C.grade(readingSession, 0, 1), false);
const restoredReading = JSON.parse(JSON.stringify(readingSession));
assert.equal(C.validSession(restoredReading), true, 'Reading restores without acquiring a deadline');
assert.equal(C.startTimer(restoredReading, 220000), true);
assert.equal(restoredReading.clock.startedAt, 220000, 'Timing begins at the explicit click, not session creation');
assert.equal(restoredReading.clock.thinkDeadline, 280000);
assert.equal(restoredReading.clock.submitDeadline, 290000);
assert.equal(C.startTimer(restoredReading, 230000), false, 'Repeated clicks cannot reset the deadline');
assert.equal(restoredReading.clock.startedAt, 220000);
assert.equal(C.validSession(restoredReading), true, 'Legacy running session structure remains supported');
assert.deepEqual(C.advance(restoredReading, 269999), []);
assert.deepEqual(C.advance(restoredReading, 270000), ['signal50']);
const unreadFinished = JSON.parse(JSON.stringify(readingSession));
C.finish(unreadFinished, 220000);
assert.equal(unreadFinished.status, 'complete');
assert.equal(C.validSession(unreadFinished), true, 'An empty completed session is valid');
assert.equal(C.summary(unreadFinished).attempted, 0);
assert.equal(C.summary(unreadFinished).unplayed, 3);
assert.equal(C.summary(unreadFinished).incorrect, 0);
assert.equal(C.summary(unreadFinished).rate, null);
assert.equal(C.grade(unreadFinished, 0, 1), false);
const finishWhileReadingNext = C.createSession(original, { count: 3 }, 100, () => .99);
C.startTimer(finishWhileReadingNext, 1000); C.current(finishWhileReadingNext).answer = 'Ответ 1'; C.lock(finishWhileReadingNext, 2000); C.next(finishWhileReadingNext, 3000);
assert.equal(C.validSession(JSON.parse(JSON.stringify(finishWhileReadingNext))), true, 'A later reading question also survives reload');
C.finish(finishWhileReadingNext, 123000);
assert.equal(C.summary(finishWhileReadingNext).attempted, 1, 'Finishing during the next reading does not create a missed answer');
assert.equal(C.summary(finishWhileReadingNext).unplayed, 2);
assert.equal(C.summary(finishWhileReadingNext).correct, 1);
assert.equal(C.summary(finishWhileReadingNext).incorrect, 0);
assert.equal(C.validSession(finishWhileReadingNext), true);
finishWhileReadingNext.status = 'results';
assert.equal(C.validSession(finishWhileReadingNext), true, 'Historical result records stay compatible');
let s = C.createSession(original, { count: 3, difficulty: 5 }, 100000, () => .99);
assert.equal(C.validSession(s), true);
C.startTimer(s, 100000);
assert.equal(C.phase(s, 100000), 'thinking');
assert.equal(C.remaining(s, 100000), 60);
assert.deepEqual(C.advance(s, 149999), []);
assert.equal(C.remaining(s, 149999), 11);
assert.deepEqual(C.advance(s, 150000), ['signal50']);
assert.deepEqual(C.advance(s, 150001), [], 'A signal fires only once');
assert.equal(C.remaining(s, 159999), 1);
assert.deepEqual(C.advance(s, 160000), ['signal60']);
assert.equal(C.phase(s, 160000), 'submission');
assert.equal(C.remaining(s, 160000), 10);
C.current(s).answer = 'Ответ 1';
assert.deepEqual(C.advance(s, 170000), ['locked']);
assert.equal(s.status, 'locked');
assert.equal(s.attempts[0].grade, 1);
assert.equal(s.attempts[0].elapsed, 70);
assert.deepEqual(C.advance(s, 900000), []);
assert.equal(C.next(s, 900000), true);
assert.equal(s.index, 1);
assert.equal(s.status, 'reading');
assert.equal(s.clock, null, 'Every next question needs its own explicit timer start');
assert.deepEqual(C.advance(s, 950000), []);
assert.equal(C.remaining(s, 950000), 60);
C.startTimer(s, 950000);
C.current(s).answer = 'Спорная версия';
C.lock(s, 965000);
assert.equal(s.attempts[1].grade, null, 'Unknown answers require self-review, not automatic rejection');
assert.equal(s.attempts[1].elapsed, 15);
C.next(s, 970000);
C.startTimer(s, 980000);
C.lock(s, 985000, 'skipped');
C.next(s, 990000);
assert.equal(s.status, 'complete');
assert.equal(s.completedAt, 990000);
assert.equal(JSON.stringify(original), before, 'Session may not mutate the source catalog');
let summary = C.summary(s);
assert.equal(summary.attempted, 3);
assert.equal(summary.correct, 1);
assert.equal(summary.judged, 2);
assert.equal(summary.pending, 1);
assert.equal(summary.rate, .5);
assert.equal(summary.empty, 1);
assert.equal(C.grade(s, 1, 1), true);
summary = C.summary(s);
assert.equal(summary.correct, 2);
assert.equal(summary.pending, 0);
assert.equal(summary.rate, 2 / 3);
assert.equal(C.grade(s, 1, null), true);
assert.equal(C.summary(s).pending, 1);
assert.equal(C.grade(s, 200, 1), false);
assert.equal(C.grade(s, 1, 2), false);
// Pauses shift deadlines and exclude their wall-clock duration from response time.
s = C.createSession(original, { count: 3 }, 0, () => .99);
C.startTimer(s, 0);
assert.equal(C.pause(s, 20000), true);
assert.equal(C.remaining(s, 80000), 40);
assert.equal(C.elapsed(s, 80000), 20000);
assert.deepEqual(C.advance(s, 600000), []);
assert.equal(C.resume(s, 120000), true);
assert.equal(C.remaining(s, 120000), 40);
assert.deepEqual(C.advance(s, 150000), ['signal50']);
assert.deepEqual(C.advance(s, 160000), ['signal60']);
C.current(s).answer = 'Ответ 1';
C.lock(s, 165000);
assert.equal(s.attempts[0].elapsed, 65);
// A sleeping/backgrounded tab is settled using the deadline, not interval counts.
s = C.createSession(original, { count: 3 }, 100, () => .99);
C.startTimer(s, 100);
C.current(s).answer = 'Ответ 1';
assert.deepEqual(C.advance(s, 1000000), ['signal50', 'signal60', 'locked']);
assert.equal(s.attempts[0].elapsed, 70);
assert.equal(s.index, 0, 'Background tabs cannot consume the next question');
assert.equal(C.validSession(JSON.parse(JSON.stringify(s))), true, 'Sessions are JSON-restorable');
// Finishing early excludes unplayed questions instead of treating them as misses.
s = C.createSession(original, { count: 3 }, 0, () => .99);
C.startTimer(s, 0);
C.current(s).answer = 'Ответ 1';
C.finish(s, 10000);
summary = C.summary(s);
assert.equal(summary.attempted, 1);
assert.equal(summary.total, 3);
assert.equal(summary.unplayed, 2);
assert.equal(summary.correct, 1);
assert.equal(summary.avgTime, 10);
assert.equal(C.grade(s, 1, 1), false, 'An unplayed question cannot be credited');
assert.equal(C.validSession({ ...s, index: 100 }), false);
assert.equal(C.validSession({ ...s, createdAt: 'bad' }), false);
assert.equal(C.validSession({ ...s, questions: [] }), false);
assert.equal(C.createSession([], { count: 10 }, 0), null);
// Multiple authors deliberately overlap, while packages count each question once.
s = C.createSession(C.questions([q(1, 5, 'a', { authors: [{ id: 'a', name: 'А' }, { id: 'b', name: 'Б' }] }), q(2, 6, 'b')]), { count: 2 }, 0, () => .99);
C.startTimer(s, 0); C.current(s).answer = 'Ответ 1'; C.lock(s, 10000); C.next(s, 15000); C.startTimer(s, 15000); C.current(s).answer = 'Ответ 2'; C.finish(s, 25000);
summary = C.summary(s);
assert.equal(summary.authors.find(a => a.id === 'b').correct, 2);
assert.equal(summary.authors.find(a => a.id === 'a').correct, 1);
assert.equal(summary.authors.reduce((sum, a) => sum + a.count, 0), 3);
assert.equal(summary.packages.reduce((sum, p) => sum + p.count, 0), 2);
assert.equal(summary.meanPackageDifficulty, 5.5);
// Export summaries never overload the official answer with the submitted one.
assert.equal(summary.rows[0].officialAnswer, 'Ответ 1');
assert.equal(summary.rows[0].submittedAnswer, 'Ответ 1');
assert.equal(Object.hasOwn(summary.rows[0], 'answer'), false);
function completed(id, rate, dl = 5, author = 'a', format) {
  const source = [q(1, dl), q(2, dl), q(3, dl)].map(question => ({ ...question, package: { ...question.package, ...(format && format !== 'all' ? { type: format } : {}) } }));
  const session = C.createSession(C.questions(source), { count: 3, author, ...(format ? { format } : {}) }, id * 100000, () => .99);
  session.id = `s${id}`;
  for (let i = 0; i < 3; i++) { C.startTimer(session, id * 100000 + i * 10000); C.current(session).answer = `Ответ ${i + 1}`; C.lock(session, id * 100000 + i * 10000 + 1000); C.grade(session, i, i < rate ? 1 : 0); C.next(session, id * 100000 + (i + 1) * 10000); }
  return session;
}
const earlier = [completed(1, 1), completed(2, 2), completed(3, 0), completed(4, 3, 8), completed(5, 3, 5, 'other')];
const latest = completed(6, 3);
let progress = C.progress(earlier, latest);
assert.equal(progress.rows.length, 6);
assert.equal(progress.comparison.count, 3, 'Compare only same author filter and similar package difficulty');
assert.equal(progress.comparison.previousRate, 1 / 3);
assert.ok(Math.abs(progress.comparison.delta - 2 / 3) < 1e-10);
assert.equal(C.progress(earlier.slice(0, 2), latest).comparison, null, 'Two previous sessions cannot establish a comparison');
assert.equal(C.progress([...earlier, completed(0, 3, 5, 'a', 'si')], latest).comparison.count, 3, 'Comparable history excludes another game format');
assert.equal(C.progress(earlier, completed(7, 3, 5, 'a', 'kvrm')).comparison.count, 3, 'Legacy history without format is compatible with explicit ЧГК');
assert.equal(C.progress(earlier, completed(7, 3, null)).comparison, null, 'An unknown current difficulty cannot compare as a zero-rated package');
C.grade(latest, 2, null);
assert.equal(C.progress(earlier, latest).comparison, null, 'A partially reviewed result cannot claim progress');
// The annual source archive is intentionally broader than the playable pool.
// In particular, the one fully blank published record must not disappear.
const archive = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'training.json'), 'utf8'));
const archivePool = C.questions(archive);
assert.equal(archivePool.length, archive.questions.length, 'Every published annual record survives normalization');
const allAvailable = C.candidates(archivePool, { author: 'all', format: 'all', difficulty: null });
const chgkAvailable = C.candidates(archivePool, { author: 'all', format: 'kvrm', difficulty: null });
if (archive.meta && archive.meta.yearWindow && archive.meta.yearWindow.from === '2025-11-10' && archive.meta.yearWindow.toInclusive === '2026-11-10') {
  assert.equal(archivePool.length, 9602, 'Complete 2025–2026 source archive');
  assert.equal(allAvailable.length, 9599, 'Three incomplete published records remain archived but unavailable');
  assert.equal(chgkAvailable.length, 9429, 'ЧГК availability excludes SI and the three incomplete records');
  assert.ok(archivePool.some(q => q.id === 'gq-pack-6671-question-433029'), 'The completely blank source record is retained');
  assert.ok(!allAvailable.some(q => ['gq-pack-6671-question-433029', 'gq-pack-7130-question-485404', 'gq-pack-7179-question-488547'].includes(q.id)), 'Known unusable source records cannot be sampled');
  for (const name of ['Сайландер Дмитрий', 'Болгаренко Софья']) {
    const author = C.authors(archivePool).find(author => author.name === name);
    assert.ok(author, `Published reverse-name author remains in the archive: ${name}`);
    assert.equal(C.authorSortKey(author), name.split(' ')[0]);
  }
}
console.log(`Training archive: ${archivePool.length} retained / ${allAvailable.length} playable / ${chgkAvailable.length} playable ЧГК.`);
console.log('Training: source filtering, surname order, explicit timer start/reading restore, 50/60/70s boundaries, pause/resume, background recovery, self-review and summaries passed.');
// Tournament presets combine authors with OR, never broaden when none match,
// and exclude target packets by both known packet ID and Rating link.
const presetPool = C.questions([
  q('preset-a', 5, 'a', { package: { id: 'old-a', trueDl: 5 } }),
  q('preset-b', 5, 'b', { package: { id: 'old-b', trueDl: 5 } }),
  q('preset-c', 5, 'c', { package: { id: 'other', trueDl: 5 } }),
  q('preset-target', 5, 'a', { package: { id: 'target', trueDl: 5 } }),
  q('preset-link', 5, 'b', { package: { id: 'target-by-link', trueDl: 5, ratingTournamentIds: [111] } })
]);
const presetConfig = C.registrationConfig({ tournamentId: 111, name: 'Турнир из заявок', authors: [{ id: 'a' }, { id: 'b' }], targetPackageIds: ['target'], difficultyForecast: 5, authorBasis: 'rating_editors' }, { count: 10, tolerance: 1 });
assert.deepEqual(C.candidates(presetPool, presetConfig).map(q => q.id), ['preset-a', 'preset-b']);
assert.deepEqual(C.candidates(presetPool, { ...presetConfig, authors: [] }), [], 'Unmatched preset must not become all authors');
assert.deepEqual(C.candidates(presetPool, { registrationId: '111' }), [], 'A saved registration with missing author data must fail closed');
const manual = C.registrationConfig(null, presetConfig);
assert.equal(manual.registrationId, ''); assert.equal(Object.hasOwn(manual, 'authors'), false); assert.equal(Object.hasOwn(manual, 'excludePackageIds'), false);
assert.equal(C.candidates(presetPool, manual).length, 5, 'Explicit return to manual selection clears preset constraints');
const at = Date.parse('2026-11-11T12:00:00Z');
const registrationRows = { tournaments: [
  { tournamentId: 1, dateStart: '2026-11-10T00:00:00Z', dateEnd: '2026-11-12T00:00:00Z' },
  { tournamentId: 2, dateStart: '2026-11-12T00:00:00Z', dateEnd: '2026-11-15T00:00:00Z' },
  { tournamentId: 3, dateStart: '2026-11-01T00:00:00Z', dateEnd: '2026-11-11T12:00:00Z' },
  { tournamentId: 4, dateStart: '2026-11-10T00:00:00Z', dateEnd: '2026-11-12T00:00:00Z', teamResultsAvailable: true },
  { tournamentId: 5, dateStart: 'bad' }
] };
assert.deepEqual(C.registrations(registrationRows, at, false).map(t => t.tournamentId), [1, 2]);
assert.equal(C.registrations(registrationRows, at, true).length, 5);
assert.equal(C.registrations(registrationRows, Date.parse('2026-11-15T00:00:00Z'), false).length, 0, 'The exact closing instant expires registration availability');
console.log('Registration training: multi-author union, target exclusion, unmatched safety and date boundaries passed.');
// Focus presets are strict whitelists; an empty or stale list never opens the bank.
assert.equal(C.candidates(presetPool, { questionIds: [], author: 'all' }).length, 0);
assert.deepEqual(C.candidates(presetPool, { questionIds: ['preset-a'], author: 'all' }).map(q => q.id), ['preset-a']);
assert.equal(C.candidates(presetPool, { questionIds: ['missing-id'], author: 'all' }).length, 0);
const clearedFocus = C.registrationConfig(null, { questionIds: ['preset-a'], focusLabel: 'Фокус', authors: ['a'] });
assert.equal(clearedFocus.questionIds, undefined); assert.equal(clearedFocus.focusLabel, undefined);
