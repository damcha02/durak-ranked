// Rating-over-time chart: axes, time handling, peak and layout (src/ratingChart.ts).
import {describe,it,expect,beforeEach,afterEach} from 'vitest'
import {buildSeries,peakIndex,niceStep,ratingAxis,timeAxis,timeLabel,layout,nearestIndex,labelWidth,pointDate,PAD,LABEL_GAP,INSET,START_RATING} from '../src/ratingChart'
import type {RatedGame} from '../src/ratingChart'

// Local-time behaviour is checked in a fixed zone with a DST change (Europe/Zurich: 25 Oct 2026, 03:00 → 02:00).
const zone=process.env.TZ
beforeEach(()=>{process.env.TZ='Europe/Zurich'})
afterEach(()=>{process.env.TZ=zone})

const MIN=60_000,HOUR=60*MIN,DAY=24*HOUR
let seq=0
/** Games in order with the given times and ratings after each; deltas and befores follow from them. */
function games(times:number[],after:number[]):RatedGame[]{
 return times.map((t,i)=>({game_id:`g${++seq}`,round_id:`r${seq}`,slot:1,games_in_round:1,state:'confirmed',played_at:new Date(t).toISOString(),finalized_at:null,
  rating_before:i?after[i-1]:START_RATING,rating_after:after[i],delta:Math.round(((after[i])-(i?after[i-1]:START_RATING))*100)/100}))
}
const T0=Date.UTC(2026,9,20,18,0)
const isInteger=(x:number)=>Math.abs(x-Math.round(x))<1e-9

describe('Elo axis',()=>{
 it('fits the rating range with padding, does not start at zero, and uses whole-number steps',()=>{
  const a=ratingAxis([1200,1213.37,1188.2,1206.5])
  expect(a.min).toBeLessThan(1188.2);expect(a.max).toBeGreaterThan(1213.37)
  expect(a.min).toBeGreaterThan(1100);expect(a.max).toBeLessThan(1300)
  expect(a.ticks.length).toBeGreaterThanOrEqual(3);expect(a.ticks.length).toBeLessThanOrEqual(7)
  for(const t of a.ticks)expect(isInteger(t)).toBe(true)
  expect(a.ticks[0]).toBe(a.min);expect(a.ticks.at(-1)).toBe(a.max)
 })
 it('handles an unchanged rating and very wide ranges',()=>{
  const flat=ratingAxis([1200,1200,1200])
  expect(flat.min).toBeLessThan(1200);expect(flat.max).toBeGreaterThan(1200);expect(flat.step).toBeGreaterThanOrEqual(1)
  const wide=ratingAxis([820,2140])
  expect(wide.min).toBeLessThanOrEqual(820);expect(wide.max).toBeGreaterThanOrEqual(2140)
  expect([100,200,250,500]).toContain(wide.step)
 })
 it('picks 1-2-5 steps of at least 1 Elo',()=>{
  expect([0.3,1.4,3,4.2,7,13,24,30,180,420].map(niceStep)).toEqual([1,2,5,5,10,20,25,50,200,500])
 })
})

describe('time axis (local time)',()=>{
 it('chooses minutes, hours, days, months or years by span',()=>{
  const unit=(span:number)=>timeAxis(T0,T0+span,5).step
  expect(unit(10*MIN)).toMatchObject({unit:'minute'})
  expect(unit(6*HOUR)).toMatchObject({unit:'hour'})
  expect(unit(6*DAY)).toMatchObject({unit:'day'})
  expect(unit(200*DAY)).toMatchObject({unit:'month'})
  expect(unit(6*365*DAY).unit).toBe('year')
 })
 it('puts day ticks on local midnight, also across the DST change, in order and inside the domain',()=>{
  const t1=T0+10*DAY,{step,ticks}=timeAxis(T0,t1,12)
  expect(step.unit).toBe('day')
  for(const t of ticks){const d=new Date(t);expect([d.getHours(),d.getMinutes()]).toEqual([0,0]);expect(t).toBeGreaterThanOrEqual(T0);expect(t).toBeLessThanOrEqual(t1)}
  for(let i=1;i<ticks.length;i++)expect(ticks[i]).toBeGreaterThan(ticks[i-1])
  expect(ticks.length).toBeGreaterThanOrEqual(8)
 })
 it('never leaves a short span without ticks when only a few labels fit (a phone-width week)',()=>{
  for(let days=1;days<=40;days++)for(const limit of [2,3,4]){
   const {ticks}=timeAxis(T0,T0+days*DAY+5*HOUR,limit)
   expect(ticks.length,`${days} days, ${limit} labels`).toBeGreaterThanOrEqual(1)
   expect(ticks.length).toBeLessThanOrEqual(limit)
  }
  expect(timeAxis(T0,T0+7*DAY,3).ticks.length).toBeGreaterThanOrEqual(2)
 })
 it('formats dates in the device timezone',()=>{
  const t=Date.UTC(2026,9,28,23,30) // 00:30 on 29 Oct in Zurich, 19:30 on 28 Oct in New York
  expect(pointDate(t)).toMatch(/29/)
  process.env.TZ='America/New_York'
  expect(pointDate(t)).toMatch(/28/)
  expect(timeLabel(Date.UTC(2026,9,28,4,0),{unit:'day',n:1},false)).toMatch(/28/) // local midnight in New York
 })
 it('labels times within a day, and the date at midnight',()=>{
  const noon=new Date(2026,9,28,12,0).getTime(),midnight=new Date(2026,9,29,0,0).getTime()
  expect(timeLabel(noon,{unit:'hour',n:3},false)).toMatch(/12/)
  expect(timeLabel(midnight,{unit:'hour',n:3},false)).toMatch(/29/)
 })
})

describe('series and highest Elo',()=>{
 it('starts at 1200 before the first game, then one point per game in the given order',()=>{
  const s=buildSeries(games([T0,T0+HOUR],[1215,1201.5]))
  expect(s.map(p=>[p.kind,p.rating,p.delta])).toEqual([['start',1200,0],['game',1215,15],['game',1201.5,-13.5]])
  expect(buildSeries([])).toEqual([])
 })
 it('counts the 1200 start when every game went down',()=>{
  const s=buildSeries(games([T0,T0+HOUR],[1185,1170]))
  expect(peakIndex(s)).toBe(0)
 })
 it('marks the first time the highest Elo was reached when it repeats',()=>{
  const s=buildSeries(games([T0,T0+HOUR,T0+2*HOUR,T0+3*HOUR],[1210.25,1199,1210.25,1205]))
  expect(peakIndex(s)).toBe(1)
  expect(peakIndex(buildSeries(games([T0,T0+HOUR],[1200,1190])))).toBe(0) // equal to the start: the start
 })
})

describe('layout',()=>{
 const W=[320,360,390,768]
 function check(times:number[],width:number){
  const after=times.map((_,i)=>1200+Math.round(40*Math.sin(i/3)*100)/100),pts=buildSeries(games(times,after)),L=layout(pts,width,220)
  const {x0,x1,y0,y1}=L.plot
  expect(L.xs[0]).toBe(x0+INSET)
  for(let i=1;i<L.xs.length;i++)expect(L.xs[i],`x order at ${i}`).toBeGreaterThan(L.xs[i-1])
  for(const x of L.xs){expect(x).toBeGreaterThanOrEqual(x0+INSET);expect(x).toBeLessThanOrEqual(x1-INSET)}
  for(const y of L.ys){expect(y).toBeGreaterThanOrEqual(y0);expect(y).toBeLessThanOrEqual(y1)}
  // Time labels never overlap each other or leave the chart; Elo labels fit the left margin.
  expect(L.xTicks.length,`time labels at ${width}px`).toBeGreaterThanOrEqual(2)
  for(let i=0;i<L.xTicks.length;i++){
   const a=L.xTicks[i],half=labelWidth(a.label)/2
   expect(a.x-half).toBeGreaterThanOrEqual(0);expect(a.x+half).toBeLessThanOrEqual(width)
   if(i)expect(a.x-half).toBeGreaterThanOrEqual(L.xTicks[i-1].x+labelWidth(L.xTicks[i-1].label)/2+LABEL_GAP)
  }
  expect(L.yTicks.length).toBeGreaterThanOrEqual(3)
  for(const t of L.yTicks){expect(labelWidth(t.label)).toBeLessThanOrEqual(PAD.left-6);expect(t.y).toBeGreaterThanOrEqual(y0-0.5);expect(t.y).toBeLessThanOrEqual(y1+0.5)}
  for(let i=1;i<L.yTicks.length;i++)expect(L.yTicks[i-1].y-L.yTicks[i].y).toBeGreaterThanOrEqual(18) // Elo labels do not overlap
  return L
 }
 it('fits phone widths for one game, a few games, and large histories over any span',()=>{
  const histories=[[T0],[T0,T0+20*MIN],[0,1,2,3,4].map(i=>T0+i*DAY),[0,1,2,3,4,5,6].map(i=>T0+i*DAY+i*3*HOUR),
   Array.from({length:60},(_,i)=>T0+i*7*HOUR),Array.from({length:2000},(_,i)=>T0+i*13*HOUR),Array.from({length:400},(_,i)=>T0+i*4*DAY)]
  for(const h of histories)for(const w of W)check(h,w)
 })
 it('places games by real time: same-day games in order, a later day proportionally further right',()=>{
  const times=[T0,T0+6*HOUR,T0+12*HOUR,T0+3*DAY],L=check(times,390)
  const scale=(L.plot.x1-L.plot.x0-2*INSET)/(L.domain.t1-L.domain.t0)
  expect(L.xs[4]-L.xs[1]).toBeCloseTo(3*DAY*scale,0)
  expect(L.xs[3]-L.xs[2]).toBeCloseTo(6*HOUR*scale,0)
 })
 it('spreads games in the same minute (and both games of a parallel round) apart, keeping replay order',()=>{
  const L=check([T0,T0,T0+30_000,T0+40_000,T0+DAY],390)
  for(let i=2;i<=4;i++)expect(L.xs[i]-L.xs[i-1]).toBeGreaterThanOrEqual(2)
 })
 it('draws higher ratings higher, and keeps an unchanged rating on a flat line',()=>{
  const L=layout(buildSeries(games([T0,T0+HOUR],[1220,1190])),390,220)
  expect(L.ys[1]).toBeLessThan(L.ys[0]);expect(L.ys[2]).toBeGreaterThan(L.ys[0])
  const flat=layout(buildSeries(games([T0,T0+HOUR,T0+2*HOUR],[1200,1200,1200])),390,220)
  expect(new Set(flat.ys).size).toBe(1)
  expect(flat.ys[0]).toBeGreaterThan(flat.plot.y0);expect(flat.ys[0]).toBeLessThan(flat.plot.y1)
 })
})

describe('touch and hover',()=>{
 it('finds the nearest point to a tap',()=>{
  const xs=[48,60,61.5,200,330]
  expect([0,53,54.9,60.7,61,130,131,400].map(x=>nearestIndex(xs,x))).toEqual([0,0,1,1,2,2,3,4])
  expect(nearestIndex([],10)).toBe(-1)
 })
})
