// public.my_rating_history (migration 202610290002), the data behind Profile's rating chart, against the real
// migrations in PGlite: replay order, running balance from the ledger, modes, corrections and access.
import {describe,it,expect} from 'vitest'
import {Db,type Mode} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection} from './sql/flows'
import {buildSeries,peakIndex} from '../src/ratingChart'
import type {RatedGame} from '../src/ratingChart'

const T=120_000
const cents=(x:number|string)=>Math.round(Number(x)*100)
async function v2(){const db=await Db.create();await db.setFormula('v2');return db}
const history=(db:Db,uid:string,mode:Mode)=>db.rpcRows<RatedGame>(uid,'my_rating_history',[mode])
/** The replay's order of a player's rated games in a mode. */
async function replayOrder(db:Db,uid:string,mode:Mode){
 return (await db.rows<{id:string}>(`select g.id from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id
  join public.round_players rp on rp.round_id=r.id where rp.user_id=$1 and t.mode=$2 and g.state in ('confirmed','tied') order by r.started_at,r.id,g.slot`,[uid,mode])).map(r=>r.id)
}
/** Starts at 1200, each step is the ledger delta, and it ends at the stored rating. */
async function expectChain(db:Db,uid:string,mode:Mode,rows:RatedGame[]){
 let prev=120000
 for(const r of rows){
  expect(cents(r.rating_before)).toBe(prev)
  const {delta}=await db.one<{delta:number}>(`select delta from public.rating_ledger where game_id=$1 and user_id=$2`,[r.game_id,uid])
  expect(cents(r.delta)).toBe(cents(delta))
  expect(cents(r.rating_after)-cents(r.rating_before)).toBe(cents(r.delta))
  prev=cents(r.rating_after)
 }
 expect(prev).toBe(cents((await db.ratings(mode))[uid].rating))
}

describe('rating history for the chart',()=>{
 it('lists rated games oldest first in replay order, with a running balance from 1200 to the stored rating',async()=>{
  const db=await v2(),[a,b,c,d]=await db.users('alice','bob','carol','dave'),players=[a,b,c,d]
  const t1=await rpcTable(db,'single_double',players),t2=await rpcTable(db,'single_double',players)
  const [old1,old2]=await rpcRound(db,t1,players,[b,null]) // Game 2 left without a result
  await rpcRound(db,t2,players,[a,c])
  await rpcRound(db,t2,players,[d,d])
  // The open vote of the first round is decided later: it is rated (and listed) at its round's place.
  await db.rpc(a,'restart_unresolved',[old2])
  for(const v of [a,b,c])await db.rpc(v,'cast_vote',[old2,a])
  const rows=await history(db,a,'single_double')
  expect(rows.map(r=>r.game_id)).toEqual(await replayOrder(db,a,'single_double'))
  expect(rows.slice(0,2).map(r=>r.game_id)).toEqual([old1,old2])
  expect(rows.length).toBe(6)
  expect(rows[1]).toMatchObject({slot:2,games_in_round:2})
  // Both games of a round carry the round's start time; times never go backwards.
  expect(rows[0].played_at).toEqual(rows[1].played_at)
  for(let i=1;i<rows.length;i++)expect(new Date(rows[i].played_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[i-1].played_at).getTime())
  for(const u of players)await expectChain(db,u,'single_double',await history(db,u,'single_double'))
 },T)

 it('keeps the four modes apart, each starting at 1200',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  await rpcRound(db,await rpcTable(db,'natural',players),players,[a])
  await rpcRound(db,await rpcTable(db,'double_single',players),players,[b])
  await rpcRound(db,await rpcTable(db,'double_double',players),players,[c,a])
  const natural=await history(db,a,'natural'),big=await history(db,a,'double_single'),dd=await history(db,a,'double_double'),sd=await history(db,a,'single_double')
  expect([natural.length,big.length,dd.length,sd.length]).toEqual([1,1,2,0])
  for(const [mode,rows] of [['natural',natural],['double_single',big],['double_double',dd]] as const){
   expect(cents(rows[0].rating_before)).toBe(120000)
   await expectChain(db,a,mode,rows)
  }
 },T)

 it('leaves out reversed and unresolved games and shows the replayed ratings after a correction',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  const [first]=await rpcRound(db,tid,players,[a])
  const [second]=await rpcRound(db,tid,players,[b])
  const [open]=await rpcRound(db,tid,players,[null])
  const [third]=await rpcRound(db,tid,players,[a])
  const before=await history(db,a,'natural')
  expect(before.map(r=>r.game_id)).toEqual([first,second,third])
  await rpcCorrection(db,first,[b,c],true) // alice's first loss is reversed
  const after=await history(db,a,'natural')
  expect(after.map(r=>r.game_id)).toEqual([second,third])
  expect(after.some(r=>r.game_id===open)).toBe(false)
  expect(cents(after[0].rating_before)).toBe(120000) // the replay starts from 1200 again
  expect(cents(after[0].delta)).not.toBe(cents(before[1].delta)) // and re-rates what followed
  await expectChain(db,a,'natural',after)
 },T)

 it('includes shared losses, and the chart\'s highest Elo matches the history',async()=>{
  const db=await v2(),players=await db.users('alice','bob','carol','dave','erin','frank'),[a,b,,d]=players
  const tid=await rpcTable(db,'double_single',players)
  await rpcRound(db,tid,players,[b]);await rpcRound(db,tid,players,[b])
  const tie=await rpcTiedRound(db,tid,players,[a,d])
  await rpcRound(db,tid,players,[a])
  const rows=await history(db,a,'double_single')
  expect(rows.map(r=>r.state)).toEqual(['confirmed','confirmed','tied','confirmed'])
  expect(rows[2].game_id).toBe(tie)
  const series=buildSeries(rows),peak=peakIndex(series)
  const max=Math.max(120000,...rows.map(r=>cents(r.rating_after)))
  expect(cents(series[peak].rating)).toBe(max)
  expect(peak).toBe(2) // after the two wins, before the shared loss
  // Bob lost first, so his highest Elo is the 1200 start, before any game.
  const bob=buildSeries(await history(db,b,'double_single'))
  expect(peakIndex(bob)===0||cents(bob[peakIndex(bob)].rating)>120000).toBe(true)
  expect(Math.max(...bob.map(p=>cents(p.rating)))).toBe(cents(bob[peakIndex(bob)].rating))
 },T)

 it('shows players only their own history and refuses anonymous callers',async()=>{
  const db=await v2(),[a,b,c,eve]=await db.users('alice','bob','carol','eve')
  await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  await db.asUser(eve,async()=>{expect(await db.rows(`select * from public.my_rating_history('natural')`)).toEqual([])})
  await db.asUser(b,async()=>{expect(await db.rows(`select * from public.my_rating_history('natural')`)).toHaveLength(1)})
  await db.pg.exec('begin');await db.pg.exec('set local role anon')
  await expect(db.pg.query(`select * from public.my_rating_history('natural')`)).rejects.toThrow(/permission denied/)
  await db.pg.exec('rollback')
 },T)

 it('changes no rating, ledger row or game record',async()=>{
  const db=await v2(),[a,b,c]=await db.users('alice','bob','carol')
  await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  const before={rating:await db.ratingState(),records:await db.gameRecords()}
  for(const u of [a,b,c])await history(db,u,'natural')
  expect(await db.ratingState()).toEqual(before.rating);expect(await db.gameRecords()).toEqual(before.records)
 },T)
})
