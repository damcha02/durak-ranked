// Personal game history (migration 202610280001) against the real migrations in PGlite:
// public.my_game_history / public.game_details read the authoritative ledger and game records.
import {describe,it,expect} from 'vitest'
import {Db,type Mode} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection,expire} from './sql/flows'

const T=120_000
type Row={game_id:string;round_id:string;mode:Mode;slot:number;games_in_round:number;state:string;played_at:Date;finalized_at:Date|null;
 player_count:number;loser_ids:string[];loser_names:string[];delta:string;rating_before:string;rating_after:string;correction:string|null}
const n=(x:string|number|null)=>Number(x)
const cents=(x:string|number)=>Math.round(Number(x)*100)

async function history(db:Db,uid:string,limit=20,before:string|null=null){return db.rpcRows<Row>(uid,'my_game_history',[before,limit])}
async function fullHistory(db:Db,uid:string){
 const out:Row[]=[];let before:string|null=null
 for(;;){const page=await history(db,uid,20,before);out.push(...page);if(page.length<20)return out;before=page[page.length-1].game_id}
}
/** Replay order as the rating rebuild uses it: rounds by (started_at, id), games by slot. */
async function replayOrder(db:Db,uid:string){
 return (await db.rows<{id:string}>(`select g.id from public.round_games g join public.rounds r on r.id=g.round_id join public.round_players rp on rp.round_id=r.id
  where rp.user_id=$1 and g.state in ('confirmed','tied','void','unresolved') order by r.started_at,r.id,g.slot`,[uid])).map(r=>r.id)
}
async function ledgerDelta(db:Db,game:string,uid:string){
 return (await db.one<{delta:number}>(`select delta from public.rating_ledger where game_id=$1 and user_id=$2`,[game,uid]))?.delta??0
}
/** Every running value agrees with the ledger and ends at the stored rating, per mode. */
async function expectConsistent(db:Db,uid:string){
 const rows=(await fullHistory(db,uid)).reverse() // oldest first
 const last:Partial<Record<Mode,Row>>={}
 for(const r of rows){
  expect(cents(r.delta),`delta of ${r.game_id}`).toBe(cents(await ledgerDelta(db,r.game_id,uid)))
  expect(cents(r.rating_after)-cents(r.rating_before)).toBe(cents(r.delta))
  expect(cents(r.rating_before)).toBe(last[r.mode]?cents(last[r.mode]!.rating_after):120000)
  last[r.mode]=r
 }
 const ratings=await db.rows<{mode:Mode;rating:number}>(`select mode,rating from public.ratings where user_id=$1`,[uid])
 for(const rt of ratings)if(last[rt.mode])expect(cents(last[rt.mode]!.rating_after),`final ${rt.mode}`).toBe(cents(rt.rating))
 return rows
}
async function v2(){const db=await Db.create();await db.setFormula('v2');return db}

describe('game history',()=>{
 it('lists games newest first in replay order, 20 per page, with accurate running Elo',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=0;i<23;i++)await rpcRound(db,tid,players,[players[(i*7)%3]])
  const page1=await history(db,a),page2=await history(db,a,20,page1[19].game_id)
  expect(page1).toHaveLength(20);expect(page2).toHaveLength(3)
  expect(await history(db,a,20,page2[2].game_id)).toEqual([])
  const ids=[...page1,...page2].map(r=>r.game_id)
  expect(new Set(ids).size).toBe(23)
  expect(ids).toEqual((await replayOrder(db,a)).reverse())
  expect(page1[0]).toMatchObject({mode:'natural',slot:1,games_in_round:1,state:'confirmed',player_count:3})
  for(const u of players)await expectConsistent(db,u)
  // Deltas are whole cents under V2 and exactly zero-sum per game.
  const details=await db.rpc<{players:{delta:number}[]}>(a,'game_details',[page1[0].game_id])
  expect(details.players.reduce((s,p)=>s+cents(p.delta),0)).toBe(0)
 },T)

 it('shows both games of a parallel round from the same start-of-round rating, as a running balance',async()=>{
  const db=await v2(),[a,b,c,d]=await db.users('alice','bob','carol','dave'),players=[a,b,c,d]
  const tid=await rpcTable(db,'single_double',players)
  await rpcRound(db,tid,players,[c,null])
  const [g1,g2]=await rpcRound(db,tid,players,[a,b])
  const rows=await history(db,a)
  expect(rows.slice(0,2).map(r=>[r.game_id,r.slot,r.games_in_round])).toEqual([[g2,2,2],[g1,1,2]])
  const [game2,game1,unresolvedGame2]=rows
  expect(unresolvedGame2).toMatchObject({state:'unresolved',slot:2,delta:'0.00'})
  expect(game1.loser_names).toEqual(['alice']);expect(game2.loser_names).toEqual(['bob'])
  expect(game2.rating_before).toBe(game1.rating_after)
  // Both deltas come from the same snapshot: game 2's change equals a fresh calculation from the round's start rating.
  const start=await db.rows<{user_id:string;rating_at_start:number}>(`select user_id,rating_at_start from public.round_players where round_id=$1`,[game1.round_id])
  const {delta:raw}=await db.one<{delta:string}>(`select delta from private.elo_v2_game_deltas($1::uuid[],$2::numeric[],array[$3]::uuid[],20,$4) where user_id=$5`,
   [start.map(s=>s.user_id),start.map(s=>s.rating_at_start),b,g2,a])
  expect(cents(game2.delta)).toBe(cents(raw))
  for(const u of players)await expectConsistent(db,u)
 },T)

 it('shows shared losses with every tied loser',async()=>{
  const db=await v2(),players=await db.users('alice','bob','carol','dave','erin','frank'),[a,,,d,e]=players
  const tid=await rpcTable(db,'double_single',players)
  const game=await rpcTiedRound(db,tid,players,[d,e])
  const [row]=await history(db,a)
  expect(row).toMatchObject({game_id:game,state:'tied',player_count:6})
  expect(row.loser_names.sort()).toEqual(['dave','erin'])
  const details=await db.rpc<{state:string;players:{user_id:string;lost:boolean;delta:number}[]}>(d,'game_details',[game])
  expect(details.state).toBe('tied')
  expect(details.players.filter(p=>p.lost).map(p=>p.user_id).sort()).toEqual([d,e].sort())
  for(const p of details.players)expect(Math.sign(p.delta)).toBe(p.lost?-1:1)
  for(const u of players)await expectConsistent(db,u)
 },T)

 it('shows a corrected game as reversed with no change, and later games re-based on the replay',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  const [first]=await rpcRound(db,tid,players,[a])
  const [kept]=await rpcRound(db,tid,players,[b])
  await rpcRound(db,tid,players,[c])
  await rpcCorrection(db,first,[b,c],true) // first result reversed: everything after is replayed
  await rpcCorrection(db,kept,[a,c],false)
  const rows=await history(db,a)
  const voided=rows.find(r=>r.game_id===first)!,rejected=rows.find(r=>r.game_id===kept)!
  expect(voided).toMatchObject({state:'void',correction:'approved',delta:'0.00',rating_before:'1200.00',rating_after:'1200.00'})
  expect(rejected).toMatchObject({state:'confirmed',correction:'rejected',rating_before:'1200.00'})
  const details=await db.rpc<{state:string;correction:string;players:{delta:number}[]}>(a,'game_details',[first])
  expect(details).toMatchObject({state:'void',correction:'approved'})
  expect(details.players.every(p=>n(p.delta)===0)).toBe(true)
  for(const u of players)await expectConsistent(db,u)
 },T)

 it('keeps a reopened vote at its round\'s place in the replay, not at its later result time',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  // An older round at one table ends without a result; a newer round at another table is confirmed;
  // then the older vote is reopened and confirmed. It is rated (and listed) at its own round's place.
  const t1=await rpcTable(db,'natural',players),t2=await rpcTable(db,'natural',players)
  const [old]=await rpcRound(db,t1,players,[null])
  const [newer]=await rpcRound(db,t2,players,[b])
  await db.rpc(a,'restart_unresolved',[old])
  for(const v of [a,b])await db.rpc(v,'cast_vote',[old,c])
  const rows=await history(db,a)
  expect(rows.map(r=>r.game_id)).toEqual([newer,old])
  expect(rows[1]).toMatchObject({state:'confirmed',loser_names:['carol'],rating_before:'1200.00'})
  expect(rows[1].finalized_at!.getTime()).toBeGreaterThan(rows[0].finalized_at!.getTime())
  expect(rows[0].rating_before).toBe(rows[1].rating_after)
  for(const u of players)await expectConsistent(db,u)
 },T)

 it('lists every participant in the details, with before/after matching their own history',async()=>{
  const db=await v2(),[a,b,c,d]=await db.users('alice','bob','carol','dave')
  await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  const tid=await rpcTable(db,'natural',[a,b,c,d])
  const [game]=await rpcRound(db,tid,[a,b,c,d],[d])
  const details=await db.rpc<{mode:string;slot:number;players:{user_id:string;username:string;lost:boolean;delta:number;rating_before:number;rating_after:number}[]}>(b,'game_details',[game])
  expect(details).toMatchObject({mode:'natural',slot:1})
  expect(details.players[0]).toMatchObject({username:'dave',lost:true})
  expect(details.players.map(p=>p.user_id).sort()).toEqual([a,b,c,d].sort())
  for(const p of details.players){
   const own=(await history(db,p.user_id)).find(r=>r.game_id===game)!
   expect([cents(p.delta),cents(p.rating_before),cents(p.rating_after)]).toEqual([cents(own.delta),cents(own.rating_before),cents(own.rating_after)])
  }
 },T)
})

describe('participant-only access',()=>{
 it('shows players only their own games and refuses details of games they did not play',async()=>{
  const db=await v2(),[a,b,c,eve]=await db.users('alice','bob','carol','eve')
  const [game]=await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  await db.asUser(eve,async()=>{
   expect(await db.rows(`select * from public.my_game_history()`)).toEqual([])
   await expect(db.rows(`select public.game_details($1)`,[game])).rejects.toThrow(/Not a participant/)
  })
  await db.asUser(b,async()=>{
   const rows=await db.rows<{game_id:string}>(`select * from public.my_game_history()`)
   expect(rows.map(r=>r.game_id)).toEqual([game])
   expect((await db.one<{d:{players:unknown[]}}>(`select public.game_details($1) as d`,[game])).d.players).toHaveLength(3)
  })
 },T)

 it('limits the rating ledger to a player\'s own rows and games they played',async()=>{
  const db=await v2(),[a,b,c,eve,f,g]=await db.users('alice','bob','carol','eve','frank','grace')
  const [game]=await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  const [own]=await rpcRound(db,await rpcTable(db,'natural',[eve,f,g]),[eve,f,g],[f])
  await db.asUser(eve,async()=>{
   const rows=await db.rows<{game_id:string}>(`select game_id from public.rating_ledger`)
   expect(rows.every(r=>r.game_id===own)).toBe(true);expect(rows).toHaveLength(3)
   expect(await db.rows(`select * from public.rating_ledger where game_id=$1`,[game])).toEqual([])
  })
  await db.asUser(b,async()=>{expect(await db.rows(`select * from public.rating_ledger where game_id=$1`,[game])).toHaveLength(3)})
 },T)

 it('refuses anonymous callers',async()=>{
  const db=await v2()
  await db.pg.exec('begin');await db.pg.exec('set local role anon')
  await expect(db.pg.query(`select * from public.my_game_history()`)).rejects.toThrow(/permission denied/)
  await db.pg.exec('rollback')
 },T)
})

describe('voting flow coverage',()=>{
 it('omits games still being voted on',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol')
  const tid=await rpcTable(db,'natural',[a,b,c])
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const {id}=await db.one<{id:string}>(`select g.id from public.round_games g join public.tables t on t.current_round_id=g.round_id where t.id=$1`,[tid])
  await db.rpc(a,'cast_vote',[id,b])
  expect(await history(db,a)).toEqual([])
  await expire(db,id);await db.rpc(a,'advance_expired',[id])
  expect((await history(db,a)).map(r=>r.state)).toEqual(['unresolved'])
 },T)
})
