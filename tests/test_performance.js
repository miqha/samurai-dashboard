'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../analytics.js');
const R = require('../roster-stats.js');
const game = (id, b, extra = {}) => ({id, name:'Игра '+id, date:'2026-01-'+String(id).padStart(2,'0'), included:true, rating:{b,inRating:true,rt:8000,rg:7000,r:6000,rb:5000,bp:400,d:300}, performance:99999, totalQuestions:2, questionQty:[2], mask:'10', score:1, position:1, fieldSize:20, players:[{id:1,name:'А'},{id:2,name:'Б'}], editors:[{id:3,name:'В'}], ...extra});

assert.equal(S.performance(game(1, 0)), 0);
for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, '', '500', true, {}, {b:500}]) assert.equal(S.performance(game(1,value)), null);
assert.equal(S.performance({...game(1,undefined), percentile:99, takeRate:.9}), null);
assert.equal(S.performance(game(1, 500, {rating:{b:500,inRating:false}})), 500, 'A calculated B remains valid outside rating eligibility');
assert.equal(S.performance(game(1, 0, {rating:{b:0,inRating:false}})), 0, 'Zero B outside rating is an observed value');
for (const rating of [null, undefined, 500, {}, {rt:500}, {rg:500}, {r:500}, {rb:500}, {bp:500}, {d:500}]) {
  assert.equal(S.performance(game(1,undefined,{rating})), null, 'No other rating field or top-level performance substitutes for B');
}
assert.equal(S.performance(null), null);

// An equal-weight mean of whole-game performance, independent of package size,
// answer rate or place; zero is observed data, and missing is not zero.
const games = [game(1,100,{position:1}), game(2,900,{position:20,totalQuestions:100}), game(3,0,{rating:{b:0,inRating:false}}), game(4,null), game(5,9999,{included:false})];
const summary = S.summarize(games);
assert.equal(summary.performanceGames,3);
assert.equal(summary.missingPerformanceGames,1);
assert.equal(summary.avgPerformance,1000/3);
assert.equal(summary.medianPerformance,100);
assert.equal(summary.best.id,2);
assert.equal(summary.worst.id,3);
assert.equal(summary.best.performance,900);
assert.equal(S.trend(games).find(t=>t.id===2).performance,900);
assert.equal(S.byPlayer(games)[0].avgPerformance,1000/3);
assert.equal(S.pairs(games)[0].performanceGames,3);
assert.equal(S.byEditor(games)[0].avgPerformance,1000/3);
assert.equal(S.filter(games,{year:'2025'}).length,0);
assert.equal(S.summarize([]).avgPerformance,null);
assert.equal(S.summarize([game(1,null)]).best,null);

// Whole-game performance cannot be attributed to author ranges or a tour.
const credited = game(1,700,{questionCredits:[{from:1,to:1,authors:[{id:4,name:'Г'}]}]});
assert.equal(S.byAuthor([credited])[0].avgPerformance,null);
assert.equal(S.byRound([credited])[0].avgPerformance,null);
assert.equal(S.byQuestion([credited])[0].avgPerformance,null);

// The same finite performance observations power both summaries and intervals.
const roster = R.summarize(games,{performance:S.performance});
assert.equal(roster.groups.find(g=>g.size===2).count,3);
assert.ok(Math.abs(roster.groups.find(g=>g.size===2).mean-summary.avgPerformance)<1e-10);
const messages = S.insights(games);
assert.equal(messages.find(i=>i.type==='best').tournamentId,2);
assert.equal(messages.some(i=>i.title==='Выше среднего поля'||i.title==='Ниже среднего поля'),false);
assert.ok(messages.every(i=>!String(i.text).includes('NaN')));

// Cross-check the real derived snapshot against the independent cached source
// records. This verifies the adapter as well as the aggregate and does not
// derive the reference result by invoking the accessor under test.
const snapshot = require('../data/dashboard.json');
const published = snapshot.tournaments.filter(t=>t.included!==false);
let sum = 0, outsideRating = 0;
const values = [];
for (const t of published) {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname,'../data/raw',`${t.id}-results.json`),'utf8'));
  const own = source.data.find(row=>row.teamId===100321);
  assert.ok(own, `Source result for tournament ${t.id} exists`);
  assert.equal(typeof own.rating.b, 'number');
  assert.equal(t.rating.b, own.rating.b, `Snapshot preserves source B for ${t.id}`);
  assert.equal(S.performance(t), own.rating.b, `Accessor reads tournament B for ${t.id}`);
  sum += own.rating.b; values.push(own.rating.b);
  if (own.rating.inRating===false) outsideRating++;
}
assert.ok(published.length>=50, 'Source audit covers the full team history');
assert.ok(outsideRating>0, 'Real snapshot exercises inRating=false values');
values.sort((a,b)=>a-b);
const actual = S.summarize(snapshot.tournaments);
assert.equal(actual.performanceGames,published.length);
assert.equal(actual.missingPerformanceGames,0);
assert.equal(actual.avgPerformance,sum/values.length);
assert.equal(actual.medianPerformance,values[(values.length-1)/2]);
assert.equal(actual.minPerformance,values[0]);
assert.equal(actual.maxPerformance,values.at(-1));
console.log(`performance: strict tournament B, zero/eligibility, scope and ${published.length} independent source records verified`);
