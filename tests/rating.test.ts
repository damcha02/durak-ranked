import {describe,it,expect} from 'vitest'
import {ratingDeltas} from '../src/rating'
describe('multiplayer ratings',()=>{
 const players=[{id:'a',rating:1200},{id:'b',rating:1200},{id:'c',rating:1200}]
 it('is zero sum',()=>{const r=ratingDeltas(players,['a']);expect(Object.values(r).reduce((x,y)=>x+y,0)).toBeCloseTo(0)})
 it('spreads losses over winners',()=>{const r=ratingDeltas(players,['a']);expect(r.a).toBeCloseTo(-16);expect(r.b).toBeCloseTo(8);expect(r.c).toBeCloseTo(8)})
 it('penalizes shared losers less than sole loser',()=>{const solo=ratingDeltas(players,['a']);const shared=ratingDeltas(players,['a','b']);expect(-shared.a).toBeLessThan(-solo.a)})
 it('makes stronger losers lose more',()=>{const r=ratingDeltas([{id:'a',rating:1400},{id:'b',rating:1200},{id:'c',rating:1200}],['a']);const low=ratingDeltas([{id:'a',rating:1000},{id:'b',rating:1200},{id:'c',rating:1200}],['a']);expect(-r.a).toBeGreaterThan(-low.a)})
 it('rejects invalid outcomes',()=>{expect(()=>ratingDeltas(players,['a','b','c'])).toThrow()})
})
