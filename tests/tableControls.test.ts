// Table controls (migration 202611050001): 2h expiry of stuck games, stopping a game,
// deleting a table and removing players. Time is simulated by moving last_activity_at.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound} from './sql/flows'

const T=120_000
const idle=(db:Db,tid:string,hours:number)=>db.pg.query(`update public.tables set last_activity_at=now()-$2::double precision*interval '1 hour' where id=$1`,[tid,hours])
const cleanup=async(db:Db)=>(await db.one<{n:number}>(`select private.close_inactive_tables() as n`)).n
const row=(db:Db,tid:string)=>db.one<{status:string;current_round_id:string|null;closed_at:Date|null;closed_reason:string|null}>(`select status,current_round_id,closed_at,closed_reason from public.tables where id=$1`,[tid])
const count=async(db:Db,sql:string,p:unknown[]=[])=>(await db.one<{n:number}>(sql,p)).n
async function setup(n=3,mode:'natural'|'single_double'='natural'){
 const db=await Db.create();await db.setFormula('v2')
 const players=await db.users(...['alice','bob','carol','dave'].slice(0,n))
 return {db,players,tid:await rpcTable(db,mode,players)}
}

describe('2-hour expiry',()=>{
 it('closes an idle lobby after 2 hours, not before',async()=>{
  const {db,tid}=await setup()
  await idle(db,tid,1.9);expect(await cleanup(db)).toBe(0)
  await idle(db,tid,2.01);expect(await cleanup(db)).toBe(1)
  expect(await row(db,tid)).toMatchObject({status:'lobby',closed_reason:'inactivity'})
 },T)

 it('cancels a game that was started but never finished, and closes the table',async()=>{
  const {db,players:[a],tid}=await setup()
  await db.rpc(a,'start_round',[tid])
  await idle(db,tid,1.9);expect(await cleanup(db)).toBe(0)
  expect((await row(db,tid)).status).toBe('playing')
  await idle(db,tid,2.01);expect(await cleanup(db)).toBe(1)
  expect(await row(db,tid)).toMatchObject({status:'lobby',current_round_id:null,closed_reason:'inactivity'})
  expect(await count(db,`select count(*)::int n from public.rounds where table_id=$1`,[tid])).toBe(0)
 },T)

 it('also cancels a round stuck waiting for votes, but not one with a result or a reopened vote',async()=>{
  const {db,players:[a,b,c],tid}=await setup()
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  await idle(db,tid,3);expect(await cleanup(db)).toBe(1)

  const o=await setup(); const [oa,ob,oc]=o.players
  const [game]=await rpcRound(o.db,o.tid,o.players,[null])
  await o.db.rpc(oa,'restart_unresolved',[game])
  await idle(o.db,o.tid,3);expect(await cleanup(o.db)).toBe(0) // reopened: kept
  expect((await row(o.db,o.tid)).status).toBe('results')
  expect(await count(o.db,`select count(*)::int n from public.round_games`)).toBe(1)
  void b;void c;void ob;void oc
 },T)

 it('keeps an unresolved game (and a parallel round with one result) open',async()=>{
  const {db,players,tid}=await setup(3,'single_double')
  const [a,b,c]=players
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const games=(await db.rows<{id:string}>(`select id from public.round_games order by slot`)).map(g=>g.id)
  for(const v of [a,b])await db.rpc(v,'cast_vote',[games[0],c])
  await idle(db,tid,5);expect(await cleanup(db)).toBe(0)
  expect((await row(db,tid)).closed_at).toBeNull()
 },T)
})

describe('stopping a game',()=>{
 it('lets the host stop a game that was started by accident',async()=>{
  const {db,players:[a,b],tid}=await setup()
  await db.rpc(a,'start_round',[tid])
  await expect(db.rpc(b,'cancel_round',[tid])).rejects.toThrow(/Only the host/)
  await db.rpc(a,'cancel_round',[tid])
  expect(await row(db,tid)).toMatchObject({status:'lobby',current_round_id:null,closed_at:null})
  expect(await count(db,`select count(*)::int n from public.rounds`)).toBe(0)
  await db.rpc(a,'start_round',[tid]) // can start again
 },T)

 it('also works while recording results, before anyone has voted, and with votes cast',async()=>{
  const {db,players:[a,b],tid}=await setup()
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const {id:game}=await db.one<{id:string}>(`select id from public.round_games`)
  await db.rpc(b,'cast_vote',[game,a])
  await db.rpc(a,'cancel_round',[tid])
  expect((await row(db,tid)).status).toBe('lobby')
  expect(await count(db,`select count(*)::int n from public.game_votes`)).toBe(0)
 },T)

 it('refuses when there is nothing to stop, or a result exists, and never touches ratings',async()=>{
  const {db,players:[a,b,c],tid}=await setup()
  await expect(db.rpc(a,'cancel_round',[tid])).rejects.toThrow(/no game to stop/)
  const [game]=await rpcRound(db,tid,[a,b,c],[a])
  const ratings=await db.ratingState()
  await expect(db.rpc(a,'cancel_round',[tid])).rejects.toThrow(/no game to stop/)
  // A reopened vote has history: it cannot be stopped.
  const [g2]=await rpcRound(db,tid,[a,b,c],[null])
  await db.rpc(a,'restart_unresolved',[g2])
  await expect(db.rpc(a,'cancel_round',[tid])).rejects.toThrow(/cannot be stopped/)
  expect(await db.ratingState()).toEqual(ratings)
  void game
 },T)
})

describe('deleting a table',()=>{
 it('deletes a table that never recorded a game',async()=>{
  const {db,players:[a,b],tid}=await setup()
  await expect(db.rpc(b,'delete_table',[tid])).rejects.toThrow(/Only the host/)
  await db.rpc(a,'delete_table',[tid])
  expect(await count(db,`select count(*)::int n from public.tables where id=$1`,[tid])).toBe(0)
  expect(await count(db,`select count(*)::int n from public.table_members`)).toBe(0)
 },T)

 it('stops a running game first, then deletes',async()=>{
  const {db,players:[a],tid}=await setup()
  await db.rpc(a,'start_round',[tid])
  await db.rpc(a,'delete_table',[tid])
  expect(await count(db,`select count(*)::int n from public.tables`)).toBe(0)
 },T)

 it('closes a table with recorded games for good and hides it, keeping ratings and history',async()=>{
  const {db,players:[a,b,c],tid}=await setup()
  await rpcRound(db,tid,[a,b,c],[a])
  const ratings=await db.ratingState(),history=await db.rpcRows(a,'my_game_history',[null,20])
  await db.rpc(a,'delete_table',[tid])
  expect(await row(db,tid)).toMatchObject({closed_reason:'host'})
  expect(await count(db,`select count(*)::int n from public.table_members where table_id=$1 and is_active`,[tid])).toBe(0)
  await db.asUser(b,async()=>{expect(await db.rows(`select id from public.tables where id=$1`,[tid])).toHaveLength(0)})
  expect(await db.ratingState()).toEqual(ratings)
  expect(await db.rpcRows(a,'my_game_history',[null,20])).toEqual(history)
  await expect(db.rpc(b,'join_table',[(await db.one<{code:string}>(`select code from public.tables where id=$1`,[tid])).code])).rejects.toThrow(/closed/)
 },T)

 it('deletes a table even if it has an unresolved game',async()=>{
  const {db,players:[a,b,c],tid}=await setup()
  await rpcRound(db,tid,[a,b,c],[null])
  await db.rpc(a,'delete_table',[tid])
  expect((await row(db,tid)).closed_reason).toBe('host')
 },T)
})

describe('removing players',()=>{
 it('lets only the host remove another player between games',async()=>{
  const {db,players:[a,b,c],tid}=await setup()
  await expect(db.rpc(b,'kick_member',[tid,c])).rejects.toThrow(/Only the host/)
  await expect(db.rpc(a,'kick_member',[tid,a])).rejects.toThrow(/Leave table/)
  await db.rpc(a,'kick_member',[tid,c])
  expect(await count(db,`select count(*)::int n from public.table_members where table_id=$1 and is_active`,[tid])).toBe(2)
  await expect(db.rpc(a,'kick_member',[tid,c])).rejects.toThrow(/not at this table/)
  await db.asUser(c,async()=>{expect(await db.rows(`select id from public.tables where id=$1`,[tid])).toHaveLength(0)})
 },T)

 it('is refused during a round, and a removed player cannot take part in the next one',async()=>{
  const {db,players:[a,b,c,d],tid}=await setup(4)
  await db.rpc(a,'start_round',[tid])
  await expect(db.rpc(a,'kick_member',[tid,d])).rejects.toThrow(/between games/)
  await db.rpc(a,'cancel_round',[tid])
  await db.rpc(a,'kick_member',[tid,d])
  const rid=await db.rpc<string>(a,'start_round',[tid])
  expect(await count(db,`select count(*)::int n from public.round_players where round_id=$1 and user_id=$2`,[rid,d])).toBe(0)
  void b;void c
 },T)

 it('removing a player is activity for the table',async()=>{
  const {db,players:[a,,c],tid}=await setup()
  await idle(db,tid,1.5);await db.rpc(a,'kick_member',[tid,c])
  expect((await db.one<{ok:boolean}>(`select last_activity_at>now()-interval '1 minute' as ok from public.tables where id=$1`,[tid])).ok).toBe(true)
 },T)
})

describe('votes without a verdict are discarded',()=>{
 it('deletes a game whose vote ends with one vote, and the round and table carry on',async()=>{
  const {db,players:[a,b,c],tid}=await setup()
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const {id:game}=await db.one<{id:string}>(`select id from public.round_games`)
  await db.rpc(a,'cast_vote',[game,b])
  await db.pg.query(`update public.round_games set deadline=now()-interval '1 second' where id=$1`,[game])
  await db.rpc(c,'advance_expired',[game])
  expect(await count(db,`select count(*)::int n from public.round_games`)).toBe(0)
  expect(await count(db,`select count(*)::int n from public.rounds`)).toBe(0)
  expect(await row(db,tid)).toMatchObject({status:'lobby',current_round_id:null})
  expect(await count(db,`select count(*)::int n from public.game_votes`)).toBe(0)
  await idle(db,tid,2.1);expect(await cleanup(db)).toBe(1) // nothing left to hold the table open
 },T)

 it('in a parallel round only that game goes; the other still counts',async()=>{
  const {db,players:[a,b,c],tid}=await setup(3,'single_double')
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const [g1,g2]=(await db.rows<{id:string}>(`select id from public.round_games order by slot`)).map(g=>g.id)
  await db.rpc(a,'cast_vote',[g1,b])
  await db.pg.query(`update public.round_games set deadline=now()-interval '1 second' where id=$1`,[g1])
  await db.rpc(c,'advance_expired',[g1])
  expect((await row(db,tid)).status).toBe('results')
  for(const v of [a,b])await db.rpc(v,'cast_vote',[g2,c])
  expect((await row(db,tid)).status).toBe('lobby')
  expect(await count(db,`select count(*)::int n from public.round_games where state='confirmed'`)).toBe(1)
 },T)
})
