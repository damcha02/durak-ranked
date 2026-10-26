import {describe,it,expect} from 'vitest'
import {ratingDeltas,ratingDeltasV1,lossProbabilities} from '../src/rating'

const table=(...ratings:number[])=>ratings.map((rating,i)=>({id:`p${String(i).padStart(2,'0')}`,rating}))
const equal=(n:number)=>table(...Array(n).fill(1200))
const cents=(r:Record<string,number>)=>Object.values(r).reduce((s,x)=>s+Math.round(x*100),0)

describe('V1 (live until V2 is activated)',()=>{
 const players=equal(3)
 it('gives an equally rated sole loser -16 at any table size',()=>{
  for(const n of [3,4,8,16])expect(ratingDeltasV1(equal(n),['p00']).p00).toBeCloseTo(-16)
 })
 it('is zero sum and halves shared losses',()=>{
  const r=ratingDeltasV1(players,['p00']);expect(Object.values(r).reduce((x,y)=>x+y,0)).toBeCloseTo(0)
  expect(-ratingDeltasV1(equal(4),['p00','p01']).p00).toBeLessThan(-ratingDeltasV1(equal(4),['p00']).p00)
 })
})

describe('V2 probabilities',()=>{
 it('are 1/n for equal ratings and sum to 1',()=>{
  for(const n of [2,3,8,16]){const p=lossProbabilities(Array(n).fill(1200));p.forEach(x=>expect(x).toBeCloseTo(1/n,12));expect(p.reduce((a,b)=>a+b)).toBeCloseTo(1,12)}
 })
 it('reduce to standard two-player Elo',()=>{
  const [pa]=lossProbabilities([1400,1200]);expect(pa).toBeCloseTo(1/(1+10**(200/400)),12)
 })
})

describe('V2 sole loser',()=>{
 const expectedLoss:Record<number,number>={3:-13.33,4:-15,5:-16,6:-16.67,8:-17.5,16:-18.75}
 it('loses less at smaller tables (equal ratings)',()=>{
  let previous=-Infinity
  for(const n of [3,4,5,6,8,16]){
   const r=ratingDeltas(equal(n),['p00'])
   // Within one cent: largest-remainder rounding may move a cent onto any player.
   expect(Math.abs(r.p00-expectedLoss[n])).toBeLessThanOrEqual(0.01+1e-9)
   expect(r.p00).toBeLessThan(previous===-Infinity?0:previous)
   previous=r.p00
  }
 })
 it('is exactly zero-sum after rounding, with deltas in whole cents',()=>{
  for(const n of [3,4,5,6,7,8,11,16])for(const loser of ['p00',`p${String(n-1).padStart(2,'0')}`]){
   const players=table(...Array.from({length:n},(_,i)=>1000+37*i*(i%3)))
   const r=ratingDeltas(players,[loser])
   expect(cents(r)).toBe(0)
   Object.values(r).forEach(x=>expect(Math.abs(x*100-Math.round(x*100))).toBeLessThan(1e-9))
  }
 })
 it('costs less to lose against stronger players than against weaker ones',()=>{
  const vsStrong=ratingDeltas(table(1200,1400,1300,1100),['p00']).p00
  const vsWeak=ratingDeltas(table(1200,1000,1100,1100),['p00']).p00
  expect(vsStrong).toBeGreaterThan(vsWeak)
  // A stronger loser at the same table loses more.
  expect(ratingDeltas(table(1400,1200,1200,1200),['p00']).p00).toBeLessThan(ratingDeltas(table(1000,1200,1200,1200),['p00']).p00)
 })
 it('gives weaker winners more and never charges a winner or exceeds K',()=>{
  const r=ratingDeltas(table(1250,1400,1300,1200,1150,1100),['p00'])
  expect(r.p01).toBeLessThan(r.p02);expect(r.p02).toBeLessThan(r.p03);expect(r.p04).toBeLessThan(r.p05)
  expect(ratingDeltas(table(1800,1000,1000,1000,1000,1000,1000,1000),['p00']).p00).toBeGreaterThanOrEqual(-20)
  Object.entries(r).filter(([id])=>id!=='p00').forEach(([,x])=>expect(x).toBeGreaterThanOrEqual(0))
 })
 it('rounds deterministically regardless of input order',()=>{
  const players=equal(3),a=ratingDeltas(players,['p01']),b=ratingDeltas([...players].reverse(),['p01'])
  expect(a).toEqual(b)
  expect(a).toEqual({p00:6.67,p01:-13.33,p02:6.66})
 })
 it('scales linearly with K',()=>{
  expect(ratingDeltas(equal(4),['p00'],32).p00).toBeCloseTo(-24,2)
 })
})

describe('V2 accepted shared loss',()=>{
 it('costs each tied player less than a sole loss, and is zero-sum',()=>{
  for(const [n,m] of [[4,2],[5,2],[6,2],[6,3],[8,2],[8,4],[16,2]]){
   const losers=Array.from({length:m},(_,i)=>`p${String(i).padStart(2,'0')}`)
   const shared=ratingDeltas(equal(n),losers),sole=ratingDeltas(equal(n),['p00']),winner=`p${String(n-1).padStart(2,'0')}`
   expect(cents(shared)).toBe(0)
   losers.forEach(id=>{expect(shared[id]).toBeLessThan(0);expect(shared[id]).toBeGreaterThan(sole.p00)})
   // Winners gain the same as if one of the tied players had lost alone.
   expect(shared[winner]).toBeCloseTo(sole[winner],1)
  }
 })
 it('splits the loss in proportion to (1-p): the stronger tied player pays more, nobody gains',()=>{
  const r=ratingDeltas(table(1400,1000,1200,1200),['p00','p01'])
  expect(r.p00).toBeCloseTo(-5.04,1);expect(r.p01).toBeCloseTo(-2.26,1)
  expect(r.p02).toBeCloseTo(3.65,1);expect(cents(r)).toBe(0)
  const underdog=ratingDeltas(table(1400,800,1400,1400),['p00','p01'])
  expect(underdog.p01).toBeLessThanOrEqual(0)
 })
 it('reduces to the sole-loser formula for one loser',()=>{
  const players=table(1300,1200,1100),p=lossProbabilities([1300,1200,1100])
  expect(ratingDeltas(players,['p00']).p00).toBeCloseTo(-20*(1-p[0]),2)
 })
})

describe('validation',()=>{
 const players=equal(3)
 it('rejects impossible outcomes',()=>{
  expect(()=>ratingDeltas(players,[])).toThrow()
  expect(()=>ratingDeltas(players,['p00','p01','p02'])).toThrow()
  expect(()=>ratingDeltas(players,['p00','p00'])).toThrow()
  expect(()=>ratingDeltas(players,['zz'])).toThrow()
  expect(()=>ratingDeltasV1(players,['p00','p01','p02'])).toThrow()
 })
})
