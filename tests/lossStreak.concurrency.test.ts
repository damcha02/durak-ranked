// Losing-streak penalty under real concurrency: games and corrections finishing in separate PostgreSQL sessions.
// Needs a disposable PostgreSQL 17 server (the test creates and drops its own database):
//   docker run -d --name durak-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
//   DURAK_TEST_PG_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres npm test
// Skipped when DURAK_TEST_PG_URL is not set.
import {describe,it,expect,beforeAll,afterAll} from 'vitest'
import {PsqlSession,freshDatabase,within} from './sql/psql'

const URL_=process.env.DURAK_TEST_PG_URL
const T=120_000

describe.skipIf(!URL_)('losing-streak penalty with concurrent sessions (real PostgreSQL)',()=>{
 let db:{url:string;drop:()=>void}
 const sessions:PsqlSession[]=[]
 const session=()=>{const s=new PsqlSession(db.url);sessions.push(s);return s}
 let admin:PsqlSession
 beforeAll(async()=>{
  db=freshDatabase(URL_!);admin=session()
  await admin.ok(`update private.rating_config set formula='v2',streak_rule='loss_streak_v1',streak_from=now()`)
 },T)
 afterAll(()=>{sessions.forEach(s=>s.close());db?.drop()})

 const user=(name:string)=>admin.ok(`insert into auth.users(raw_user_meta_data) values(jsonb_build_object('username','${name}')) returning id`)
 const as=(s:PsqlSession,uid:string)=>s.ok(`select set_config('request.jwt.claim.sub','${uid}',false)`)
 async function table(players:string[]){
  await as(admin,players[0])
  const tid=await admin.ok(`select public.create_table('natural',null)`),code=await admin.ok(`select code from public.tables where id='${tid}'`)
  for(const p of players.slice(1)){await as(admin,p);await admin.ok(`select public.join_table('${code}')`)}
  return tid
 }
 /** Starts a round and opens its results; returns the game. */
 async function round(s:PsqlSession,tid:string,host:string){
  await as(s,host);await s.ok(`select public.start_round('${tid}')`);await s.ok(`select public.begin_results('${tid}')`)
  return s.ok(`select g.id from public.round_games g join public.tables t on t.current_round_id=g.round_id where t.id='${tid}'`)
 }
 const vote=async(s:PsqlSession,voter:string,game:string,loser:string)=>{await as(s,voter);return s.ok(`select public.cast_vote('${game}','${loser}')`)}
 async function lose(tid:string,players:string[],loser:string){const g=await round(admin,tid,players[0]);for(const v of players.slice(0,2))await vote(admin,v,g,loser);return g}
 const extra=(game:string,uid:string)=>admin.ok(`select streak_extra from public.rating_ledger where game_id='${game}' and user_id='${uid}'`)
 const streak=(uid:string)=>admin.ok(`select loss_streak from public.ratings where user_id='${uid}' and mode='natural'`)
 const dump=()=>admin.ok(`select md5(string_agg(x,',' order by x)) from (
  select format('r|%s|%s|%s|%s|%s',user_id,rating,games,losses,loss_streak) as x from public.ratings where mode='natural'
  union all select format('l|%s|%s|%s|%s|%s',game_id,user_id,delta,streak_extra,loss_streak) from public.rating_ledger where mode='natural') y`)
 /** The stored state is exactly what a fresh serial replay produces, and every game is zero-sum in whole cents. */
 async function expectAuthoritative(){
  const stored=await dump()
  await admin.ok(`select private.rebuild_mode('natural')`)
  expect(await dump()).toBe(stored)
  expect(await admin.ok(`select count(*) from (select game_id from public.rating_ledger group by game_id having sum(delta::numeric)<>0) x`)).toBe('0')
  expect(await admin.ok(`select count(*) from public.rating_ledger where delta::numeric<>round(delta::numeric,2)`)).toBe('0')
 }

 it('puts the penalty on the 4th loss in replay order, whichever game commits first',async()=>{
  const [a,b,c,d,e]=[await user('st1_a'),await user('st1_b'),await user('st1_c'),await user('st1_d'),await user('st1_e')]
  const t1=await table([a,b,c]),t2=await table([a,d,e])
  await lose(t1,[b,c,a],a);await lose(t1,[b,c,a],a) // two losses
  const s1=session(),s2=session()
  const x=await round(s1,t1,b) // started first: alice's 3rd loss
  const y=await round(s2,t2,d) // started second: alice's 4th loss
  await vote(s1,b,x,a)
  // y's result commits first; x's deciding vote waits for the mode's rating lock.
  await s2.ok('begin');await vote(s2,d,y,a);await vote(s2,e,y,a)
  await s1.ok('begin');await as(s1,c)
  const pending=s1.send(`select public.cast_vote('${x}','${a}')`)
  expect(await within(pending,1000)).toBe('pending')
  await s2.ok('commit')
  expect((await pending).error).toBe('')
  await s1.ok('commit')
  expect(Number(await extra(x,a))).toBe(0)
  expect(Number(await extra(y,a))).toBeLessThan(0)
  expect(await streak(a)).toBe('4')
  await expectAuthoritative()
 },T)

 it('recalculates the streak when a correction and a new loss finish at the same time',async()=>{
  const [a,b,c,d,e]=[await user('st2_a'),await user('st2_b'),await user('st2_c'),await user('st2_d'),await user('st2_e')]
  const t1=await table([a,b,c]),t2=await table([a,d,e])
  const losses:string[]=[]
  for(let i=0;i<3;i++)losses.push(await lose(t1,[b,c,a],a))
  const s1=session(),s2=session()
  await as(s1,b);const cid=await s1.ok(`select public.request_reversal('${losses[1]}')`)
  await s1.ok(`select public.vote_reversal('${cid}',true)`)
  const next=await round(s2,t2,d);await vote(s2,d,next,a)
  // The correction is decided first and holds the lock; the new loss waits for it.
  await s1.ok('begin');await as(s1,c);await s1.ok(`select public.vote_reversal('${cid}',true)`)
  await s2.ok('begin');await as(s2,e)
  const pending=s2.send(`select public.cast_vote('${next}','${a}')`)
  expect(await within(pending,1000)).toBe('pending')
  await s1.ok('commit')
  expect((await pending).error).toBe('')
  await s2.ok('commit')
  // Losses 1, 3 and the new one: three in a row, so no penalty anywhere.
  expect(await admin.ok(`select state from public.round_games where id='${losses[1]}'`)).toBe('void')
  expect(Number(await extra(next,a))).toBe(0)
  expect(await streak(a)).toBe('3')
  await expectAuthoritative()
 },T)

 it('stays authoritative under many games finishing at once across tables of one mode',async()=>{
  const a=await user('st3_a'),others:string[]=[]
  for(let i=0;i<8;i++)others.push(await user(`o3_${i}`))
  const tables:{tid:string;players:string[]}[]=[]
  for(let i=0;i<4;i++){const players=[others[2*i],others[2*i+1],a];tables.push({tid:await table(players),players})}
  const errors:string[]=[]
  await Promise.all(tables.map(async({tid,players},i)=>{
   const s=session()
   for(let k=0;k<6;k++){
    const g=await round(s,tid,players[0]),loser=(i+k)%4===0?players[1]:a
    for(const v of players.slice(0,2)){await as(s,v);const r=await s.send(`select public.cast_vote('${g}','${loser}')`);if(r.error)errors.push(r.error)}
   }
  }))
  expect(errors).toEqual([]) // no deadlocks or serialization failures
  expect(Number(await admin.ok(`select count(distinct game_id) from public.rating_ledger where streak_extra<0`))).toBeGreaterThan(0)
  await expectAuthoritative()
 },T)
})
