// public.my_expected_losses (migration 202611190003) against the real migrations in PGlite: expected losses
// are the Elo V2 losing chance from every player's replayed pre-round rating; shared losses split.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection} from './sql/flows'
import {lossProbabilities} from '../src/rating'

const T=120_000
type Row={player_count:number;games:number;losses:number|string;expected_losses:number|string}

describe('expected vs. actual losses',()=>{
 it('sums the losing chance from pre-round ratings, by round size',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  const three=[a,b,c],four=[a,b,c,d]
  const t3=await rpcTable(db,'natural',three)
  // Everyone starts at 1200, so the first game's chance is exactly 1/3.
  await rpcRound(db,t3,three,[b]);await rpcRound(db,t3,three,[c]);await rpcRound(db,t3,three,[a]);await rpcRound(db,t3,three,[null])
  const t4=await rpcTable(db,'natural',four)
  await rpcTiedRound(db,t4,four,[a,b])
  const [voided]=await rpcRound(db,t4,four,[a]);await rpcCorrection(db,voided,[a,b,c],true)
  await rpcRound(db,t4,four,[d])
  await rpcRound(db,await rpcTable(db,'double_single',three),three,[a])

  // Reference: replay each rated natural game's pre-round ratings from the ledger and apply the TS formula.
  const games=await db.rows<{id:string;n:number;loser_ids:string[]}>(`select g.id,(select count(*)::int from public.round_players p where p.round_id=r.id) n,g.loser_ids
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id
   where t.mode='natural' and g.state in ('confirmed','tied') and exists(select 1 from public.round_players p where p.round_id=r.id and p.user_id=$1)
   order by r.started_at,r.id,g.slot`,[a])
  const want:Record<number,{games:number;losses:number;expected:number}>={}
  for(const g of games){
   const seats=await db.rows<{user_id:string;before:number}>(`select p.user_id,1200+coalesce((select sum(l.delta) from public.rating_ledger l join public.round_games x on x.id=l.game_id
     join public.rounds rr on rr.id=x.round_id join public.tables tt on tt.id=rr.table_id
     where l.user_id=p.user_id and tt.mode='natural' and (rr.started_at,rr.id)<(r.started_at,r.id)),0)::float8 as before
     from public.round_players p join public.rounds r on r.id=p.round_id join public.round_games x on x.round_id=r.id where x.id=$1 order by p.user_id`,[g.id])
   const p=lossProbabilities(seats.map(s=>Number(s.before)))[seats.findIndex(s=>s.user_id===a)]
   const w=want[g.n] ||= {games:0,losses:0,expected:0}
   w.games++;w.expected+=p;if(g.loser_ids.includes(a))w.losses+=1/g.loser_ids.length
  }
  const rows=await db.rpcRows<Row>(a,'my_expected_losses',['natural'])
  expect(rows.map(r=>[r.player_count,r.games])).toEqual([[3,3],[4,2]])
  for(const r of rows){
   expect(Number(r.losses)).toBeCloseTo(want[r.player_count].losses,4)
   expect(Number(r.expected_losses)).toBeCloseTo(want[r.player_count].expected,3)
  }
  expect(Number(rows[1].losses)).toBe(0.5) // the shared loss
  // Across all players of a game, expected and actual both add up to one loss.
  let e=0,l=0;for(const u of four)for(const r of await db.rpcRows<Row>(u,'my_expected_losses',['natural']))if(r.player_count===4){e+=Number(r.expected_losses);l+=Number(r.losses)}
  expect(e).toBeCloseTo(2,3);expect(l).toBeCloseTo(2,4)
 },T)
})
