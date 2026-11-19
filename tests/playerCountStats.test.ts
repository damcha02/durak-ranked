// public.my_player_count_stats (migration 202611190001), Profile's "By number of players" table, against the
// real migrations in PGlite: grouping by round size, losses (shared ones included), Elo from the ledger, modes.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection} from './sql/flows'

const T=120_000
type Row={player_count:number;games:number;losses:number;elo_change:number|string}
const cents=(x:number|string)=>Math.round(Number(x)*100)

describe('stats by number of players',()=>{
 it('groups rated games by round size, counting shared losses and summing the ledger',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c,d,e]=await db.users('alice','bob','carol','dave','erin')
  const three=[a,b,c],four=[a,b,c,d],five=[a,b,c,d,e]
  const t3=await rpcTable(db,'natural',three)
  await rpcRound(db,t3,three,[a]);await rpcRound(db,t3,three,[b]);await rpcRound(db,t3,three,[null])
  const t4=await rpcTable(db,'natural',four)
  await rpcTiedRound(db,t4,four,[a,b]);const [voided]=await rpcRound(db,t4,four,[a])
  await rpcCorrection(db,voided,[a,b,c],true)
  const t5=await rpcTable(db,'natural',five)
  await rpcRound(db,t5,five,[c])
  await rpcRound(db,await rpcTable(db,'double_single',three),three,[a]) // other mode: not counted
  const rows=await db.rpcRows<Row>(a,'my_player_count_stats',['natural'])
  expect(rows.map(r=>[r.player_count,r.games,r.losses])).toEqual([[3,2,1],[4,1,1],[5,1,0]])
  for(const r of rows){
   const {sum}=await db.one<{sum:number}>(`select coalesce(sum(l.delta),0) as sum from public.rating_ledger l join public.round_games x on x.id=l.game_id
    join public.rounds rr on rr.id=x.round_id join public.tables t on t.id=rr.table_id
    where l.user_id=$1 and t.mode='natural' and (select count(*) from public.round_players p where p.round_id=rr.id)=$2`,[a,r.player_count])
   expect(cents(r.elo_change)).toBe(cents(sum))
  }
  const total=rows.reduce((s,r)=>s+cents(r.elo_change),0)
  expect(total).toBe(cents((await db.ratings('natural'))[a].rating)-120000)
  expect(await db.rpcRows<Row>(a,'my_player_count_stats',['single_double'])).toEqual([])
 },T)
})
