import {describe,it,expect} from 'vitest'
import {pickVerdicts,VERDICT_RECENT_MS} from '../src/verdict'
import type {Game} from '../src/lib'

const NOW=Date.UTC(2026,10,20,19,0,0)
const game=(id:string,round:string,over:Partial<Game>={}):Game=>({id,round_id:round,slot:1,state:'confirmed',deadline:null,loser_ids:['p'],allowed_nominees:null,finalized_at:new Date(NOW-30_000).toISOString(),...over})
const ids=(gs:Game[])=>gs.map(g=>g.id)

describe('"Vote closed" pop-up',()=>{
 it('announces a fresh result of the latest round once',()=>{
  const g=game('g1','r1')
  expect(ids(pickVerdicts([g],'r1',NOW,new Set()))).toEqual(['g1'])
  expect(ids(pickVerdicts([g],'r1',NOW,new Set(['g1'])))).toEqual([])
 })
 it('stays quiet once the host has started a newer round',()=>{
  // Someone opens the table 30 s after the vote closed, but the next game is already being played.
  expect(ids(pickVerdicts([game('g1','r1')],'r2',NOW,new Set()))).toEqual([])
 })
 it('ignores old results, open votes and games without a single result',()=>{
  const old=game('old','r1',{finalized_at:new Date(NOW-VERDICT_RECENT_MS-1).toISOString()})
  const voting=game('v','r1',{state:'voting',finalized_at:null})
  const voided=game('x','r1',{state:'void'})
  expect(ids(pickVerdicts([old,voting,voided],'r1',NOW,new Set()))).toEqual([])
 })
 it('announces both games of a parallel round in order, and a shared loss',()=>{
  const second=game('g2','r1',{slot:2,state:'tied',loser_ids:['p','q']}),first=game('g1','r1',{slot:1})
  expect(ids(pickVerdicts([second,first],'r1',NOW,new Set()))).toEqual(['g1','g2'])
 })
})
