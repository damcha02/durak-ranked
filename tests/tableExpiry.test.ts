// Automatic table expiry (migration 202610280002) against the real migrations in PGlite.
// Time is simulated by moving tables.last_activity_at into the past.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound,rpcCorrection,expire} from './sql/flows'

const T=120_000
type TableState={status:string;current_round_id:string|null;last_activity_at:Date;closed_at:Date|null}
const state=(db:Db,tid:string)=>db.one<TableState>(`select status,current_round_id,last_activity_at,closed_at from public.tables where id=$1`,[tid])
/** Pretends the last meaningful activity was `hours` ago. */
const idle=(db:Db,tid:string,hours:number)=>db.pg.query(`update public.tables set last_activity_at=now()-$2::double precision*interval '1 hour' where id=$1`,[tid,hours])
const cleanup=async(db:Db)=>(await db.one<{n:number}>(`select private.close_inactive_tables() as n`)).n
const isFresh=async(db:Db,tid:string)=>{const s=await state(db,tid);return Date.now()-s.last_activity_at.getTime()<60_000}
const codeOf=async(db:Db,tid:string)=>(await db.one<{code:string}>(`select code from public.tables where id=$1`,[tid])).code
const gamesOf=async(db:Db,tid:string)=>(await db.rows<{id:string;state:string}>(`select g.id,g.state from public.round_games g join public.tables t on t.current_round_id=g.round_id where t.id=$1 order by g.slot`,[tid]))
async function v2(){const db=await Db.create();await db.setFormula('v2');return db}
async function table(db:Db,n=3){const players=await db.users(...['alice','bob','carol','dave','erin'].slice(0,n));return {players,tid:await rpcTable(db,'natural',players)}}

describe('lobby expiry',()=>{
 it('closes a lobby after 24 hours without activity, not before',async()=>{
  const db=await v2(),{tid}=await table(db)
  await idle(db,tid,23.5);expect(await cleanup(db)).toBe(0);expect((await state(db,tid)).closed_at).toBeNull()
  await idle(db,tid,24.01);expect(await cleanup(db)).toBe(1)
  const s=await state(db,tid)
  expect(s.closed_at).not.toBeNull();expect(s.status).toBe('lobby')
 },T)

 it('can run any number of times without changing a closed table again',async()=>{
  const db=await v2(),{tid}=await table(db)
  await idle(db,tid,30);expect(await cleanup(db)).toBe(1)
  const first=await state(db,tid)
  expect(await cleanup(db)).toBe(0);expect(await cleanup(db)).toBe(0)
  expect(await state(db,tid)).toEqual(first)
 },T)

 it('starts the existing tables from their latest recorded activity when the migration is applied',async()=>{
  const db=await Db.create({before:'202610280002_table_expiry.sql'});await db.setFormula('v2')
  const [a,b,c]=await db.users('alice','bob','carol')
  const old=await rpcTable(db,'natural',[a,b,c]),recent=await rpcTable(db,'natural',[a,b,c])
  await rpcRound(db,recent,[a,b,c],[a])
  await db.pg.query(`update public.tables set created_at=now()-interval '3 days',updated_at=now()-interval '3 days' where id=$1`,[old])
  await db.pg.query(`update public.table_members set joined_at=now()-interval '2 days' where table_id=$1`,[old])
  await db.applyMigration('202610280002_table_expiry.sql')
  expect(Date.now()-(await state(db,old)).last_activity_at.getTime()).toBeGreaterThan(47*3600_000)
  expect(await isFresh(db,recent)).toBe(true)
  expect(await cleanup(db)).toBe(1)
  expect((await state(db,old)).closed_at).not.toBeNull();expect((await state(db,recent)).closed_at).toBeNull()
 },T)
})

describe('what counts as activity',()=>{
 it('joining, leaving and transferring the host reset the timer',async()=>{
  const db=await v2(),{players:[a,b],tid}=await table(db),[d]=await db.users('dave')
  await idle(db,tid,30);await db.rpc(d,'join_table',[await codeOf(db,tid)]);expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,30);await db.rpc(d,'leave_table',[tid]);expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,30);await db.rpc(a,'transfer_host',[tid,b]);expect(await isFresh(db,tid)).toBe(true)
  expect(await cleanup(db)).toBe(0)
 },T)

 it('starting a game, voting, tie responses, reopening and results reset the timer',async()=>{
  const db=await v2(),{players,tid}=await table(db,4),[a,b,c,d]=players
  await idle(db,tid,30);await db.rpc(a,'start_round',[tid]);expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,30);await db.rpc(a,'begin_results',[tid]);expect(await isFresh(db,tid)).toBe(true)
  const [{id:game}]=await gamesOf(db,tid)
  await idle(db,tid,30);await db.rpc(a,'cast_vote',[game,b]);expect(await isFresh(db,tid)).toBe(true)
  // 2-2 tie at the deadline -> tie offer; a tie response counts; declining opens a runoff.
  await db.rpc(b,'cast_vote',[game,b]);await db.rpc(c,'cast_vote',[game,c]);await db.rpc(d,'cast_vote',[game,c])
  await expire(db,game)
  await idle(db,tid,30);await db.rpc(a,'advance_expired',[game]);expect(await isFresh(db,tid)).toBe(true)
  expect((await gamesOf(db,tid))[0].state).toBe('tie_offer')
  await idle(db,tid,30);await db.rpc(b,'respond_to_tie',[game,true]);expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,30);await db.rpc(c,'respond_to_tie',[game,false]);expect(await isFresh(db,tid)).toBe(true)
  expect((await gamesOf(db,tid))[0].state).toBe('voting') // runoff between bob and carol
  // No result -> unresolved; reopening the vote counts; the final result counts.
  await expire(db,game);await db.rpc(a,'advance_expired',[game])
  expect((await state(db,tid)).status).toBe('lobby')
  await idle(db,tid,30);await db.rpc(a,'restart_unresolved',[game]);expect(await isFresh(db,tid)).toBe(true)
  for(const v of [a,b,c])await db.rpc(v,'cast_vote',[game,c])
  // A result on its own (no vote in the same call): 2 of 4 votes, decided when the deadline is evaluated.
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const [{id:next}]=await gamesOf(db,tid)
  await db.rpc(a,'cast_vote',[next,d]);await db.rpc(b,'cast_vote',[next,d]);await expire(db,next)
  await idle(db,tid,30);await db.rpc(c,'advance_expired',[next])
  expect((await state(db,tid)).status).toBe('lobby');expect(await isFresh(db,tid)).toBe(true)
 },T)

 it('viewing, refreshing and checking an open timer do not reset it',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [game]=await rpcRound(db,tid,[a,b,c],[a])
  await idle(db,tid,20);const before=(await state(db,tid)).last_activity_at
  await db.asUser(b,async()=>{
   for(const t of ['tables','table_members','rounds','round_players','round_games','vote_totals','game_votes','rating_ledger'])await db.rows(`select * from public.${t}`)
   await db.rows(`select * from public.my_game_history()`);await db.rows(`select public.game_details($1)`,[game])
  })
  await db.rpc(b,'start_round',[tid]);await db.rpc(b,'begin_results',[tid])
  const [{id:open}]=await gamesOf(db,tid);await db.rpc(a,'cast_vote',[open,c])
  await idle(db,tid,20);const during=(await state(db,tid)).last_activity_at
  for(let i=0;i<3;i++)await db.rpc(b,'advance_expired',[open]) // the deadline has not passed: nothing changes
  expect((await state(db,tid)).last_activity_at).toEqual(during)
  expect(before).not.toEqual(during)
 },T)
})

describe('unfinished games keep a table open',()=>{
 it('never closes a table while a game is being played, voted on, or tied',async()=>{
  const db=await v2(),{players:[a,b,c,d],tid}=await table(db,4)
  await db.rpc(a,'start_round',[tid])
  await idle(db,tid,72);expect(await cleanup(db)).toBe(0) // playing
  await db.rpc(a,'begin_results',[tid])
  await idle(db,tid,72);expect(await cleanup(db)).toBe(0) // awaiting a vote
  const [{id:game}]=await gamesOf(db,tid)
  await db.rpc(a,'cast_vote',[game,b]);await db.rpc(b,'cast_vote',[game,b]);await db.rpc(c,'cast_vote',[game,c]);await db.rpc(d,'cast_vote',[game,c])
  await idle(db,tid,72);expect(await cleanup(db)).toBe(0) // voting, deadline long gone but never evaluated
  await expire(db,game);await db.rpc(a,'advance_expired',[game])
  expect((await gamesOf(db,tid))[0].state).toBe('tie_offer')
  await idle(db,tid,72);expect(await cleanup(db)).toBe(0) // tie offer
  expect((await state(db,tid)).closed_at).toBeNull()
 },T)

 it('protects a parallel round until both games are resolved, then gives a fresh 24 hours',async()=>{
  const db=await v2(),players=await db.users('alice','bob','carol'),[a,b,c]=players
  const tid=await rpcTable(db,'single_double',players)
  await db.rpc(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const [g1,g2]=(await gamesOf(db,tid)).map(g=>g.id)
  for(const v of [a,b])await db.rpc(v,'cast_vote',[g1,c])
  expect((await state(db,tid)).status).toBe('results')
  await idle(db,tid,100);expect(await cleanup(db)).toBe(0) // game 1 done, game 2 still open
  for(const v of [a,b])await db.rpc(v,'cast_vote',[g2,a]) // resolved after 100 idle hours
  expect((await state(db,tid)).status).toBe('lobby');expect(await isFresh(db,tid)).toBe(true)
  expect(await cleanup(db)).toBe(0)
  await idle(db,tid,23.9);expect(await cleanup(db)).toBe(0)
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(1)
 },T)

})

describe('a game without a result keeps a table open until it is resolved',()=>{
 const stateOf=async(db:Db,game:string)=>(await db.one<{state:string}>(`select state from public.round_games where id=$1`,[game])).state
 /** Ratings, ledger and every game record, compared after a full replay of all modes. */
 const replayed=async(db:Db)=>{const live=await db.ratingState();await db.rebuildAll();expect(await db.ratingState()).toEqual(live)}

 it('keeps an unresolved vote open for days, lets it be reopened and resolved, then closes 24 hours later',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [game]=await rpcRound(db,tid,[a,b,c],[null])
  expect(await stateOf(db,game)).toBe('unresolved');expect((await state(db,tid)).status).toBe('lobby')
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(0)
  await idle(db,tid,24*7);expect(await cleanup(db)).toBe(0)
  expect((await state(db,tid)).closed_at).toBeNull()
  // A week later the players reopen the vote and decide it.
  await db.rpc(b,'restart_unresolved',[game]);expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,30);expect(await cleanup(db)).toBe(0) // reopened, waiting for votes
  for(const v of [a,b])await db.rpc(v,'cast_vote',[game,c])
  expect(await stateOf(db,game)).toBe('confirmed')
  expect((await state(db,tid)).status).toBe('lobby');expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,23.9);expect(await cleanup(db)).toBe(0)
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(1)
  await replayed(db)
 },T)

 it('a vote reopened and left unresolved again still keeps the table open',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [game]=await rpcRound(db,tid,[a,b,c],[null])
  await idle(db,tid,48);await db.rpc(a,'restart_unresolved',[game])
  await db.rpc(a,'cast_vote',[game,b]);await expire(db,game);await db.rpc(a,'advance_expired',[game])
  expect(await stateOf(db,game)).toBe('unresolved')
  await idle(db,tid,48);expect(await cleanup(db)).toBe(0)
 },T)

 it('protects game 2 of a parallel round while it is unresolved, even after game 1 has a loser',async()=>{
  const db=await v2(),players=await db.users('alice','bob','carol'),[a,b,c]=players
  const tid=await rpcTable(db,'single_double',players)
  const [g1,g2]=await rpcRound(db,tid,players,[c,null])
  expect([await stateOf(db,g1),await stateOf(db,g2)]).toEqual(['confirmed','unresolved'])
  await idle(db,tid,100);expect(await cleanup(db)).toBe(0)
  await db.rpc(a,'restart_unresolved',[g2])
  for(const v of [a,b])await db.rpc(v,'cast_vote',[g2,b])
  expect(await stateOf(db,g2)).toBe('confirmed');expect(await isFresh(db,tid)).toBe(true)
  await idle(db,tid,23.9);expect(await cleanup(db)).toBe(0)
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(1)
  await replayed(db)
 },T)

 it('keeps the table open until both unresolved games of a parallel round are resolved',async()=>{
  const db=await v2(),players=await db.users('alice','bob','carol'),[a,b,c]=players
  const tid=await rpcTable(db,'double_double',players)
  const [g1,g2]=await rpcRound(db,tid,players,[null,null])
  await idle(db,tid,50);expect(await cleanup(db)).toBe(0)
  await db.rpc(c,'restart_unresolved',[g1]);for(const v of [a,c])await db.rpc(v,'cast_vote',[g1,a])
  expect(await stateOf(db,g1)).toBe('confirmed')
  await idle(db,tid,50);expect(await cleanup(db)).toBe(0) // game 2 still has no result
  await db.rpc(c,'restart_unresolved',[g2]);for(const v of [b,c])await db.rpc(v,'cast_vote',[g2,b])
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(1)
  await replayed(db)
 },T)

 it('an unresolved game of an earlier round keeps the table open after later rounds, and can still be resolved',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [old]=await rpcRound(db,tid,[a,b,c],[null])
  await rpcRound(db,tid,[a,b,c],[a]);await rpcRound(db,tid,[a,b,c],[b])
  await idle(db,tid,72);expect(await cleanup(db)).toBe(0)
  const historyBefore=await db.rpcRows<{game_id:string}>(a,'my_game_history',[null,20])
  await db.rpc(c,'restart_unresolved',[old]);for(const v of [b,c])await db.rpc(v,'cast_vote',[old,a])
  // The late result is rated in its own round's place: the replay matches, history keeps its order.
  await replayed(db)
  const historyAfter=await db.rpcRows<{game_id:string;state:string;rating_after:number}>(a,'my_game_history',[null,20])
  expect(historyAfter.map(g=>g.game_id)).toEqual(historyBefore.map(g=>g.game_id))
  expect(historyAfter.find(g=>g.game_id===old)?.state).toBe('confirmed')
  expect(Number(historyAfter[0].rating_after)).toBe(Number((await db.ratings('natural'))[a].rating))
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(1)
 },T)

 it('a reversed (void) game is final and does not keep the table open',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [game]=await rpcRound(db,tid,[a,b,c],[a])
  await rpcCorrection(db,game,[b,c],true);expect(await stateOf(db,game)).toBe('void')
  await idle(db,tid,24.1);expect(await cleanup(db)).toBe(1)
 },T)

 it('skipping such a table changes nothing: results, ratings, ledger, corrections and history',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [g1]=await rpcRound(db,tid,[a,b,c],[a]);await rpcCorrection(db,g1,[b,c],false)
  await rpcRound(db,tid,[a,b,c],[null])
  await idle(db,tid,48)
  const before={rating:await db.ratingState(),records:await db.gameRecords(),history:await db.rpcRows(a,'my_game_history',[null,20])}
  for(let i=0;i<3;i++)expect(await cleanup(db)).toBe(0)
  expect({rating:await db.ratingState(),records:await db.gameRecords(),history:await db.rpcRows(a,'my_game_history',[null,20])}).toEqual(before)
 },T)

 it('refuses to close a table with an unfinished game, however closing is attempted',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [game]=await rpcRound(db,tid,[a,b,c],[null])
  await expect(db.pg.query(`update public.tables set closed_at=now() where id=$1`,[tid])).rejects.toThrow(/unfinished game cannot be closed/)
  await db.rpc(a,'restart_unresolved',[game]);expect(await stateOf(db,game)).toBe('awaiting')
 },T)

 it('does not close a lobby whose round still has an open game (defensive check)',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [game]=await rpcRound(db,tid,[a,b,c],[null])
  await db.rpc(a,'restart_unresolved',[game]) // reopens the vote: the table is in results again
  // Simulate an inconsistent row (lobby, no current round) while the reopened game is awaiting.
  await db.pg.query(`update public.tables set status='lobby',current_round_id=null where id=$1`,[tid])
  await idle(db,tid,48);expect(await cleanup(db)).toBe(0)
 },T)
})

describe('a closed table',()=>{
 it('rejects joins, rejoins and new games, but can be left',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db),[d]=await db.users('dave')
  await rpcRound(db,tid,[a,b,c],[a])
  await idle(db,tid,25);expect(await cleanup(db)).toBe(1)
  const code=await codeOf(db,tid)
  await expect(db.rpc(d,'join_table',[code])).rejects.toThrow(/closed due to inactivity/)
  await expect(db.rpc(a,'join_table',[code])).rejects.toThrow(/closed due to inactivity/)
  await expect(db.rpc(a,'start_round',[tid])).rejects.toThrow(/closed due to inactivity/)
  await expect(db.pg.query(`update public.tables set closed_at=null where id=$1`,[tid])).rejects.toThrow(/closed due to inactivity/)
  await db.rpc(c,'leave_table',[tid])
  expect((await db.one<{n:number}>(`select count(*)::int as n from public.table_members where table_id=$1 and is_active`,[tid])).n).toBe(2)
  // Members can still read it, so the app can show why it closed.
  await db.asUser(a,async()=>{expect((await db.rows(`select closed_at from public.tables where id=$1`,[tid]))).toHaveLength(1)})
 },T)

 it('keeps ratings, ledger, history, votes and corrections exactly as they were',async()=>{
  const db=await v2(),{players:[a,b,c],tid}=await table(db)
  const [g1]=await rpcRound(db,tid,[a,b,c],[a]);await rpcRound(db,tid,[a,b,c],[b])
  await rpcCorrection(db,g1,[b,c],false)
  const before={rating:await db.ratingState(),records:await db.gameRecords(),history:await db.rpcRows(a,'my_game_history',[null,20])}
  await idle(db,tid,25);expect(await cleanup(db)).toBe(1)
  expect(await db.ratingState()).toEqual(before.rating)
  const after=await db.gameRecords()
  const {tables:t1,...rest1}=before.records,{tables:t2,...rest2}=after
  expect(rest2).toEqual(rest1)
  // Only closed_at (and the simulated idle time) differ on the table row.
  const strip=(rows:unknown)=>(rows as Record<string,unknown>[]).map(({closed_at:_c,last_activity_at:_l,...r})=>r)
  expect(strip(t2)).toEqual(strip(t1))
  expect(await db.rpcRows(a,'my_game_history',[null,20])).toEqual(before.history)
  // A correction within 24 hours of the result still works on a closed table (history stays correctable).
  const [g2]=(await db.rpcRows<{game_id:string}>(a,'my_game_history',[null,1])).map(r=>r.game_id)
  await rpcCorrection(db,g2,[a,c],true)
  expect((await db.one<{state:string}>(`select state from public.round_games where id=$1`,[g2])).state).toBe('void')
 },T)
})

describe('cleanup and game actions in one sequence (PGlite has one connection; see tests/tableExpiry.concurrency.test.ts)',()=>{
 it('an action just before cleanup keeps the table open; one just after is refused',async()=>{
  const db=await v2(),{players:[a],tid}=await table(db),[d,e]=await db.users('dave','erin')
  await idle(db,tid,25)
  await db.rpc(d,'join_table',[await codeOf(db,tid)])
  expect(await cleanup(db)).toBe(0)
  await idle(db,tid,25);expect(await cleanup(db)).toBe(1)
  await expect(db.rpc(e,'join_table',[await codeOf(db,tid)])).rejects.toThrow(/closed/)
  await expect(db.rpc(a,'start_round',[tid])).rejects.toThrow(/closed/)
  const s=await state(db,tid)
  expect(s).toMatchObject({status:'lobby',current_round_id:null})
 },T)
})
