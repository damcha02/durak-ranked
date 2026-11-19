// public.my_table_effect and public.duel_stats (migration 202611190002) against the real migrations in PGlite.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection} from './sql/flows'

const T=120_000
type Effect={user_id:string;username:string;games:number;losses:number;expected_losses:number|string}
type Duel={games:number;my_losses:number;their_losses:number;both_lost:number}

async function setup(){
 const db=await Db.create();await db.setFormula('v2')
 const [a,b,c,d]=await db.users('alice','bob','carol','dave')
 const three=[a,b,c],four=[a,b,c,d]
 const t3=await rpcTable(db,'natural',three)
 await rpcRound(db,t3,three,[a]);await rpcRound(db,t3,three,[b]);await rpcRound(db,t3,three,[null]) // no result: not counted
 const t4=await rpcTable(db,'natural',four)
 await rpcTiedRound(db,t4,four,[a,b]);await rpcRound(db,t4,four,[d])
 const [voided]=await rpcRound(db,t4,four,[a]);await rpcCorrection(db,voided,[a,b,c],true) // reversed: not counted
 await rpcRound(db,await rpcTable(db,'double_single',three),three,[a]) // other mode
 return {db,a,b,c,d}
}

describe('head-to-head statistics',()=>{
 it('table effect: games, losses and the fair share per co-player',async()=>{
  const {db,a,b,c,d}=await setup()
  const rows=await db.rpcRows<Effect>(a,'my_table_effect',['natural'])
  const by=Object.fromEntries(rows.map(r=>[r.user_id,r]))
  expect(Object.keys(by).sort()).toEqual([b,c,d].sort())
  expect([by[b].games,by[b].losses,Number(by[b].expected_losses)]).toEqual([4,2,Number((2/3+2/4).toFixed(4))])
  expect([by[d].games,by[d].losses,Number(by[d].expected_losses)]).toEqual([2,1,0.5])
  expect(by[c].username).toBe('carol')
  expect(await db.rpcRows<Effect>(a,'my_table_effect',['single_double'])).toEqual([])
 },T)

 it('duel: only with accepted friends, counting each side\'s losses in shared games',async()=>{
  const {db,a,b,d}=await setup()
  await expect(db.rpc(a,'duel_stats',[b,'natural'])).rejects.toThrow(/only compare yourself with your friends/)
  await db.rpc(a,'send_friend_request',['bob'])
  await expect(db.rpc(a,'duel_stats',[b,'natural'])).rejects.toThrow(/only compare/)
  await db.rpc(b,'respond_friend_request',[a,true])
  await expect(db.rpc(a,'duel_stats',[a,'natural'])).rejects.toThrow(/only compare/)
  expect(await db.rpcRows<Duel>(a,'duel_stats',[b,'natural'])).toEqual([{games:4,my_losses:2,their_losses:2,both_lost:1}])
  expect(await db.rpcRows<Duel>(b,'duel_stats',[a,'natural'])).toEqual([{games:4,my_losses:2,their_losses:2,both_lost:1}])
  expect(await db.rpcRows<Duel>(a,'duel_stats',[b,'double_double'])).toEqual([{games:0,my_losses:0,their_losses:0,both_lost:0}])
  await expect(db.rpc(a,'duel_stats',[d,'natural'])).rejects.toThrow(/only compare/)
 },T)
})
