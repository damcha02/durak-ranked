// public.table_state / public.home_state (migration 202611200002): one round trip per screen load.
// They run as the caller (security invoker), so these tests call them as signed-in users with RLS on.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound,rpcCorrection} from './sql/flows'

const T=180_000
type State={table:{id:string;status:string};members:{user_id:string}[];round_ids:string[];players:string[];
 games:{id:string;state:string}[];history:{id:string;state:string}[];totals:{nominee_id:string;votes:number}[];
 ballots:{game_id:string;voter_id:string;nominee_id:string}[];cases:{id:string;state:string}[];case_approvals:Record<string,number>;
 profiles:{id:string;username:string}[];chance:{user_id:string;rating:number}[]|null;friends:{id:string;name:string}[]|null}
const tableState=(db:Db,uid:string,tid:string)=>db.asUser(uid,async()=>(await db.one<{s:State|null}>(`select public.table_state($1) s`,[tid])).s)

describe('table_state',()=>{
 it('returns the table for members and nothing for outsiders',async()=>{
  const db=await Db.create()
  const [a,b,c,x]=await db.users('alice','bob','carol','xavier')
  const tid=await rpcTable(db,'natural',[a,b,c])
  await rpcRound(db,tid,[a,b,c],[c])
  const s=await tableState(db,b,tid)
  expect(s!.table.id).toBe(tid)
  expect(s!.members.map(m=>m.user_id)).toEqual([a,b,c])
  expect(s!.history.map(g=>g.state)).toEqual(['confirmed'])
  expect(s!.ballots.map(v=>v.voter_id).sort()).toEqual([a,b].sort())
  expect(s!.profiles.map(p=>p.username).sort()).toEqual(['alice','bob','carol'])
  expect(s!.chance!.map(r=>r.user_id).sort()).toEqual([a,b,c].sort()) // lobby: live ratings
  expect(await tableState(db,x,tid)).toBeNull()
 },T)

 it('keeps ballots secret while the vote is open, like the direct query',async()=>{
  const db=await Db.create()
  const [a,b,c]=await db.users('alice','bob','carol')
  const tid=await rpcTable(db,'natural',[a,b,c])
  const rid=await db.rpc<string>(a,'start_round',[tid])
  let s=await tableState(db,b,tid)
  expect(s!.table.status).toBe('playing')
  expect(s!.players.sort()).toEqual([a,b,c].sort())
  expect(s!.chance!.length).toBe(3) // playing: ratings stored at round start
  await db.rpc(a,'begin_results',[tid])
  const {id:game}=await db.one<{id:string}>(`select id from public.round_games where round_id=$1`,[rid])
  await db.rpc(a,'cast_vote',[game,c])
  s=await tableState(db,b,tid)
  expect(s!.games.map(g=>g.state)).toEqual(['voting'])
  expect(s!.totals).toEqual([expect.objectContaining({nominee_id:c,votes:1})])
  expect(s!.ballots).toEqual([]) // who voted for whom stays hidden until the result is final
  expect(s!.chance).toBeNull()
  const direct=await db.asUser(b,()=>db.rows(`select * from public.game_votes where game_id=$1`,[game]))
  expect(direct).toEqual([])
 },T)

 it('counts approvals on open corrections and offers friends only to the host of an open lobby',async()=>{
  const db=await Db.create()
  const [a,b,c,f]=await db.users('alice','bob','carol','frank')
  await db.rpc(a,'send_friend_request',['frank']);await db.rpc(f,'respond_friend_request',[a,true])
  const tid=await rpcTable(db,'natural',[a,b,c])
  const [game]=await rpcRound(db,tid,[a,b,c],[c])
  const cid=await db.rpc<string>(c,'request_reversal',[game]);await db.rpc(c,'vote_reversal',[cid,true])
  const s=await tableState(db,a,tid)
  expect(s!.cases.map(x=>x.state)).toEqual(['open'])
  expect(s!.case_approvals).toEqual({[cid]:1})
  expect(s!.friends).toEqual([{id:f,name:'frank'}])
  expect((await tableState(db,b,tid))!.friends).toBeNull() // not the host
  await rpcCorrection(db,game,[a],true) // a second approval of 3 players settles it
  expect((await tableState(db,a,tid))!.case_approvals).toEqual({})
 },T)
})

type Home={tables:{id:string}[];ratings:{mode:string}[];seated:{table_id:string;id:string;name:string}[]}
const homeState=(db:Db,uid:string,after:Date)=>db.asUser(uid,async()=>(await db.one<{s:Home}>(`select public.home_state($1) s`,[after.toISOString()])).s)

describe('home_state',()=>{
 it('lists your tables newest first with who sits there, hiding tables closed before the cutoff',async()=>{
  const db=await Db.create()
  const [a,b,c,x]=await db.users('alice','bob','carol','xavier')
  const older=await rpcTable(db,'natural',[a,b,c])
  await rpcRound(db,older,[a,b,c],[b])
  const newer=await rpcTable(db,'double_single',[a,b])
  await rpcTable(db,'natural',[x]) // someone else's table
  let h=await homeState(db,a,new Date(Date.now()-3*86400000))
  expect(h.tables.map(t=>t.id)).toEqual([newer,older])
  expect(h.seated.filter(s=>s.table_id===older).map(s=>s.name)).toEqual(['alice','bob','carol'])
  expect(h.ratings.map(r=>r.mode).sort()).toEqual(['double_double','double_single','natural','single_double']) // one row per mode from sign-up
  await db.pg.query(`update public.tables set closed_at=now()-interval '4 days' where id=$1`,[older])
  h=await homeState(db,a,new Date(Date.now()-3*86400000))
  expect(h.tables.map(t=>t.id)).toEqual([newer])
  expect((await homeState(db,x,new Date(0))).seated.map(s=>s.name)).toEqual(['xavier'])
 },T)
})
