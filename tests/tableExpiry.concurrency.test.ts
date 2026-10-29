// Table expiry under real concurrency: cleanup and game actions in separate PostgreSQL sessions.
// Needs a disposable PostgreSQL 17 server (the test creates and drops its own database):
//   docker run -d --name durak-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
//   DURAK_TEST_PG_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres npm test
// Skipped when DURAK_TEST_PG_URL is not set.
import {describe,it,expect,beforeAll,afterAll} from 'vitest'
import {PsqlSession,freshDatabase,within} from './sql/psql'

const URL_=process.env.DURAK_TEST_PG_URL
const T=120_000

describe.skipIf(!URL_)('table expiry with concurrent sessions (real PostgreSQL)',()=>{
 let db:{url:string;drop:()=>void}
 const sessions:PsqlSession[]=[]
 const session=()=>{const s=new PsqlSession(db.url);sessions.push(s);return s}
 let admin:PsqlSession
 beforeAll(()=>{db=freshDatabase(URL_!);admin=session()},T)
 afterAll(()=>{sessions.forEach(s=>s.close());db?.drop()})

 const user=async(name:string)=>admin.ok(`insert into auth.users(raw_user_meta_data) values(jsonb_build_object('username','${name}')) returning id`)
 const as=(s:PsqlSession,uid:string)=>s.ok(`select set_config('request.jwt.claim.sub','${uid}',false)`)
 /** A lobby of three players whose last activity was 25 hours ago. */
 async function staleTable(prefix:string){
  await cleanup(admin) // tables left idle by earlier scenarios must not count here
  const ids=[await user(`${prefix}_a`),await user(`${prefix}_b`),await user(`${prefix}_c`)]
  await as(admin,ids[0])
  const tid=await admin.ok(`select public.create_table('natural',null)`)
  const code=await admin.ok(`select code from public.tables where id='${tid}'`)
  for(const id of ids.slice(1)){await as(admin,id);await admin.ok(`select public.join_table('${code}')`)}
  await admin.ok(`update public.tables set last_activity_at=now()-interval '25 hours' where id='${tid}'`)
  return {tid,code,ids}
 }
 const closedAt=(tid:string)=>admin.ok(`select coalesce(closed_at::text,'open') from public.tables where id='${tid}'`)
 const cleanup=(s:PsqlSession)=>s.ok(`select private.close_inactive_tables()`)
 const invariants=async()=>{
  // No closed table is busy, and nobody joined a table after it closed.
  expect(await admin.ok(`select count(*) from public.tables where closed_at is not null and (status<>'lobby' or current_round_id is not null)`)).toBe('0')
  expect(await admin.ok(`select count(*) from public.table_members m join public.tables t on t.id=m.table_id where t.closed_at is not null and m.is_active and m.joined_at>t.closed_at`)).toBe('0')
  expect(await admin.ok(`select count(*) from public.rounds r join public.tables t on t.id=r.table_id where t.closed_at is not null and r.started_at>t.closed_at`)).toBe('0')
  // No closed table has a game without a final result.
  expect(await admin.ok(`select count(*) from public.tables t where t.closed_at is not null and private.table_has_unfinished_game(t.id)`)).toBe('0')
 }

 it('skips a table whose join is in flight, without waiting, and leaves it open',async()=>{
  const {tid,code}=await staleTable('j'),dave=await user('j_dave'),a=session(),b=session()
  await as(a,dave);await a.ok('begin');await a.ok(`select public.join_table('${code}')`)
  expect(await within(cleanup(b),2000)).toBe('0') // did not block on the locked row
  await a.ok('commit')
  expect(await cleanup(b)).toBe('0')
  expect(await closedAt(tid)).toBe('open')
  await invariants()
 },T)

 it('makes a join that arrives during closing wait, then refuses it',async()=>{
  const {tid,code}=await staleTable('c'),erin=await user('c_erin'),a=session(),b=session()
  await a.ok('begin');expect(await a.ok('select private.close_inactive_tables()')).toBe('1')
  await as(b,erin)
  const join=b.send(`select public.join_table('${code}')`)
  expect(await within(join,1000)).toBe('pending') // waits for the closing transaction
  await a.ok('commit')
  expect((await join).error).toMatch(/closed due to inactivity/)
  expect(await closedAt(tid)).not.toBe('open')
  expect(await admin.ok(`select count(*) from public.table_members where table_id='${tid}' and is_active`)).toBe('3')
  await invariants()
 },T)

 it('makes a game start that arrives during closing wait, then refuses it',async()=>{
  const {tid,ids}=await staleTable('s'),a=session(),b=session()
  await a.ok('begin');expect(await a.ok('select private.close_inactive_tables()')).toBe('1')
  await as(b,ids[0])
  const start=b.send(`select public.start_round('${tid}')`)
  expect(await within(start,1000)).toBe('pending')
  await a.ok('commit')
  expect((await start).error).toMatch(/closed due to inactivity/)
  expect(await admin.ok(`select count(*) from public.rounds where table_id='${tid}'`)).toBe('0')
  await invariants()
 },T)

 it('never closes a table whose game is starting or whose last result is being recorded',async()=>{
  const {tid,ids}=await staleTable('g'),a=session(),b=session()
  await as(a,ids[0]);await a.ok('begin');await a.ok(`select public.start_round('${tid}')`)
  expect(await within(cleanup(b),2000)).toBe('0')
  await a.ok('commit');await a.ok(`select public.begin_results('${tid}')`)
  const game=await admin.ok(`select g.id from public.round_games g join public.tables t on t.current_round_id=g.round_id where t.id='${tid}'`)
  await admin.ok(`update public.tables set last_activity_at=now()-interval '25 hours' where id='${tid}'`)
  expect(await cleanup(b)).toBe('0') // results pending
  // One vote is recorded; the second (a majority of three: it decides) is in flight while cleanup runs.
  await as(a,ids[0]);await a.ok(`select public.cast_vote('${game}','${ids[2]}')`)
  await admin.ok(`update public.tables set last_activity_at=now()-interval '25 hours' where id='${tid}'`)
  await as(a,ids[1]);await a.ok('begin');await a.ok(`select public.cast_vote('${game}','${ids[2]}')`)
  expect(await within(cleanup(b),2000)).toBe('0')
  await a.ok('commit')
  expect(await admin.ok(`select status from public.tables where id='${tid}'`)).toBe('lobby')
  expect(await cleanup(b)).toBe('0') // the result started a fresh 24 hours
  expect(await closedAt(tid)).toBe('open')
  await invariants()
 },T)

 /** Plays a round on a stale table and leaves its vote unresolved; the table is back in the lobby. */
 async function unresolvedTable(prefix:string){
  const t=await staleTable(prefix),[a,b]=t.ids
  await as(admin,a);await admin.ok(`select public.start_round('${t.tid}')`);await admin.ok(`select public.begin_results('${t.tid}')`)
  const game=await admin.ok(`select g.id from public.round_games g join public.tables t on t.current_round_id=g.round_id where t.id='${t.tid}'`)
  await admin.ok(`select public.cast_vote('${game}','${b}')`)
  await admin.ok(`update public.round_games set deadline=now()-interval '1 second' where id='${game}'`)
  await admin.ok(`select public.advance_expired('${game}')`)
  expect(await admin.ok(`select state from public.round_games where id='${game}'`)).toBe('unresolved')
  await admin.ok(`update public.tables set last_activity_at=now()-interval '25 hours' where id='${t.tid}'`)
  return {...t,game}
 }

 it('never closes a table whose unresolved vote is being reopened or decided, and closes it 24 hours after the result',async()=>{
  const {tid,ids:[x,y,z],game}=await unresolvedTable('u'),a=session(),b=session()
  expect(await cleanup(b)).toBe('0') // unresolved: stays open
  // Reopening is in flight while cleanup runs: cleanup neither waits nor closes.
  await as(a,z);await a.ok('begin');await a.ok(`select public.restart_unresolved('${game}')`)
  expect(await within(cleanup(b),2000)).toBe('0')
  await a.ok('commit')
  expect(await admin.ok(`select status from public.tables where id='${tid}'`)).toBe('results')
  // The deciding vote is in flight while cleanup runs.
  await admin.ok(`update public.tables set last_activity_at=now()-interval '25 hours' where id='${tid}'`)
  await as(a,x);await a.ok(`select public.cast_vote('${game}','${z}')`)
  await as(a,y);await a.ok('begin');await a.ok(`select public.cast_vote('${game}','${z}')`)
  expect(await within(cleanup(b),2000)).toBe('0')
  await a.ok('commit')
  expect(await admin.ok(`select state from public.round_games where id='${game}'`)).toBe('confirmed')
  expect(await cleanup(b)).toBe('0') // the result started a fresh 24 hours
  await admin.ok(`update public.tables set last_activity_at=now()-interval '25 hours' where id='${tid}'`)
  expect(await cleanup(b)).toBe('1')
  await invariants()
 },T)

 it('lets a vote be reopened while a cleanup that is closing other tables is still running',async()=>{
  const {tid,ids,game}=await unresolvedTable('v')
  const {tid:other}=await staleTable('w'),a=session(),b=session() // its cleanup leaves the unresolved table open
  await a.ok('begin');expect(await a.ok('select private.close_inactive_tables()')).toBe('1') // closes only the other table
  await as(b,ids[0])
  expect(await within(b.send(`select public.restart_unresolved('${game}')`),2000)).toEqual({out:'',error:''})
  await a.ok('commit')
  expect(await closedAt(tid)).toBe('open');expect(await closedAt(other)).not.toBe('open')
  expect(await admin.ok(`select state from public.round_games where id='${game}'`)).toBe('awaiting')
  await invariants()
 },T)

 it('closes a table exactly once when two cleanups run at the same time',async()=>{
  const {tid}=await staleTable('d'),a=session(),b=session()
  await a.ok('begin');expect(await a.ok('select private.close_inactive_tables()')).toBe('1')
  expect(await within(cleanup(b),2000)).toBe('0')
  const first=await (async()=>{await a.ok('commit');return closedAt(tid)})()
  expect(await cleanup(b)).toBe('0');expect(await cleanup(a)).toBe('0')
  expect(await closedAt(tid)).toBe(first)
  await invariants()
 },T)

 it('stays consistent under many interleaved joins, leaves, games and cleanups',async()=>{
  const tables=[],extras:string[]=[]
  for(const p of ['x1','x2','x3','x4'])tables.push(await staleTable(p))
  for(let i=0;i<4;i++)extras.push(await user(`x_extra${i}`))
  const workers=extras.map(()=>session()),cleaner=session()
  const errors:string[]=[]
  let refused=0
  const step=async(s:PsqlSession,sql:string)=>{const r=await s.send(sql);if(/closed due to inactivity/.test(r.error))refused++;else if(r.error&&!/Finish current round|Not in table|leave the roster|Table is full|Game already started/.test(r.error))errors.push(r.error)}
  await Promise.all([
   ...workers.map(async(s,i)=>{
    await as(s,extras[i])
    for(let k=0;k<12;k++){
     const t=tables[(i+k)%tables.length]
     await step(s,`select public.join_table('${t.code}')`)
     await step(s,`update public.tables set last_activity_at=now()-interval '25 hours' where id='${t.tid}'`)
     await step(s,k%3?`select public.leave_table('${t.tid}')`:`select public.start_round('${t.tid}')`)
    }
   }),
   (async()=>{for(let k=0;k<30;k++)await cleaner.send('select private.close_inactive_tables()')})()
  ])
  expect(errors).toEqual([]) // in particular: no deadlocks, no constraint violations
  // The run really interleaved closing with actions: tables closed and later actions were refused.
  expect(Number(await admin.ok(`select count(*) from public.tables where closed_at is not null and code in (${tables.map(t=>`'${t.code}'`).join(',')})`))).toBeGreaterThan(0)
  expect(refused).toBeGreaterThan(0)
  await invariants()
 },T)
})
