// Reputation stars (migration 202611200001) against the real migrations in PGlite.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection,expire} from './sql/flows'

const T=180_000
type Rep={user_id:string;stars:number;dishonest:number;voted:number}
type Ev={game_id:string;kind:string}

const reputation=async(db:Db,asUser:string,users:string[])=>{
 const rows=await db.rpcRows<Rep>(asUser,'player_reputation',[users])
 return Object.fromEntries(rows.map(r=>[r.user_id,{stars:r.stars,dishonest:r.dishonest,voted:r.voted}]))
}
/** Starts a round and returns its first game's id, with voting open. */
async function openVote(db:Db,tid:string,host:string){
 const rid=await db.rpc<string>(host,'start_round',[tid])
 await db.rpc(host,'begin_results',[tid])
 return (await db.one<{id:string}>(`select id from public.round_games where round_id=$1 and slot=1`,[rid])).id
}
const state=async(db:Db,game:string)=>(await db.one<{state:string}>(`select state from public.round_games where id=$1`,[game])).state

describe('reputation stars',()=>{
 it('gives honest voters 5 stars and counts only voted games',async()=>{
  const db=await Db.create()
  const [a,b,c]=await db.users('alice','bob','carol')
  const tid=await rpcTable(db,'natural',[a,b,c])
  await rpcRound(db,tid,[a,b,c],[c]) // alice and bob vote carol; carol never votes
  await rpcRound(db,tid,[a,b,c],[a]) // alice admits her own loss
  const rep=await reputation(db,a,[a,b,c])
  expect(rep[a]).toEqual({stars:5,dishonest:0,voted:2})
  expect(rep[b]).toEqual({stars:5,dishonest:0,voted:2})
  expect(rep[c]).toEqual({stars:5,dishonest:0,voted:0})
 },T)

 it('takes a star from a loser who voted for someone else, not from an honest minority',async()=>{
  const db=await Db.create()
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  const tid=await rpcTable(db,'natural',[a,b,c,d])
  const game=await openVote(db,tid,a)
  await db.rpc(c,'cast_vote',[game,a]) // carol, the real loser, blames alice
  await db.rpc(d,'cast_vote',[game,b]) // dave honestly thinks it was bob (minority)
  await db.rpc(a,'cast_vote',[game,c]);await db.rpc(b,'cast_vote',[game,c])
  // Carol leads 2–1–1, short of a majority, so the result comes when the 30 seconds run out.
  await expire(db,game);await db.rpc(a,'advance_expired',[game])
  expect(await state(db,game)).toBe('confirmed')
  const rep=await reputation(db,b,[a,b,c,d])
  expect(rep[c]).toEqual({stars:4,dishonest:1,voted:1})
  for(const honest of [a,b,d])expect(rep[honest].stars).toBe(5)
  // Only carol sees the event, and only her own.
  expect(await db.rpcRows<Ev>(c,'my_reputation_events')).toEqual([expect.objectContaining({game_id:game,kind:'denied_loss'})])
  expect(await db.rpcRows<Ev>(a,'my_reputation_events')).toEqual([])
 },T)

 it('does not count a split vote that ends in a shared loss',async()=>{
  const db=await Db.create()
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  const tid=await rpcTable(db,'double_single',[a,b,c,d])
  await rpcTiedRound(db,tid,[a,b,c,d],[c,d]) // carol voted dave, dave voted himself; both accept
  const rep=await reputation(db,a,[c,d])
  expect(rep[c].stars).toBe(5);expect(rep[d].stars).toBe(5)
 },T)

 it('penalizes backing an overturned result unless you approved the correction',async()=>{
  const db=await Db.create()
  const [a,b,c]=await db.users('alice','bob','carol')
  const tid=await rpcTable(db,'natural',[a,b,c])
  const [game]=await rpcRound(db,tid,[a,b,c],[c]) // alice and bob name carol
  // Carol opens a correction; bob owns up and approves, alice does not.
  await rpcCorrection(db,game,[c,b],true)
  expect(await state(db,game)).toBe('void')
  const rep=await reputation(db,c,[a,b,c])
  expect(rep[a]).toEqual({stars:4,dishonest:1,voted:1})
  expect(rep[b]).toEqual({stars:5,dishonest:0,voted:1})
  expect(rep[c].stars).toBe(5)
  expect(await db.rpcRows<Ev>(a,'my_reputation_events')).toEqual([expect.objectContaining({game_id:game,kind:'backed_overturned'})])
  // A rejected correction leaves the result, and nobody loses a star for it.
  const [kept]=await rpcRound(db,tid,[a,b,c],[c])
  await rpcCorrection(db,kept,[a,b],false)
  expect((await reputation(db,c,[b]))[b].stars).toBe(5)
 },T)

 it('never goes below 1 star and recovers once a dishonest vote is 30 voted games old',async()=>{
  const db=await Db.create()
  const [a,b,c]=await db.users('alice','bob','carol')
  const tid=await rpcTable(db,'natural',[a,b,c])
  const deny=async()=>{const g=await openVote(db,tid,a);await db.rpc(c,'cast_vote',[g,a]);await db.rpc(a,'cast_vote',[g,c]);await db.rpc(b,'cast_vote',[g,c])}
  for(let i=0;i<6;i++)await deny()
  expect((await reputation(db,a,[c]))[c]).toEqual({stars:1,dishonest:6,voted:6})
  // After 29 honest votes only the newest denial is still among the last 30 voted games.
  const honest=async()=>{const g=await openVote(db,tid,a);await db.rpc(c,'cast_vote',[g,a]);await db.rpc(b,'cast_vote',[g,a])}
  for(let i=0;i<29;i++)await honest()
  expect((await reputation(db,a,[c]))[c]).toEqual({stars:4,dishonest:1,voted:30})
  await honest()
  expect((await reputation(db,a,[c]))[c]).toEqual({stars:5,dishonest:0,voted:30})
 },600_000)

 it('lets signed-in players read stars but keeps the per-player window private',async()=>{
  const db=await Db.create()
  const [a,b]=await db.users('alice','bob')
  const rows=await db.asUser(a,()=>db.rows<Rep>(`select * from public.player_reputation($1)`,[[a,b]]))
  expect(rows.map(r=>r.stars)).toEqual([5,5])
  await expect(db.asUser(a,()=>db.rows(`select * from private.reputation_window($1)`,[a]))).rejects.toThrow(/permission denied/)
  await db.pg.exec('begin');await db.pg.exec('set local role anon')
  await expect(db.pg.query(`select * from public.player_reputation($1)`,[[a]])).rejects.toThrow(/permission denied/)
  await db.pg.exec('rollback')
 },T)
})
