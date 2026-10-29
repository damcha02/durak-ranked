// The released features together, in the order production receives them: the rating-history migration
// (202610290002) is live before the earlier-numbered losing-streak migration (202610290001) is applied.
import {describe,it,expect} from 'vitest'
import {Db,V2_MIGRATION,STREAK_MIGRATION,migrationFiles,type Mode} from './sql/db'
import {productionLike,rpcTable,rpcRound,rpcTiedRound,rpcCorrection} from './sql/flows'
import {buildSeries,peakIndex} from '../src/ratingChart'
import type {RatedGame} from '../src/ratingChart'

const T=180_000
const cents=(x:number|string)=>Math.round(Number(x)*100)

/** Every function body, column, policy and browser-role grant in the app's schemas, comparable as JSON. */
async function catalog(db:Db){
 return {
  functions:await db.rows(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as f,pg_get_functiondef(p.oid) as def,
   has_function_privilege('anon',p.oid,'execute') as anon,has_function_privilege('authenticated',p.oid,'execute') as auth
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by 1`),
  columns:await db.rows(`select table_schema,table_name,column_name,data_type,is_nullable,column_default from information_schema.columns
   where table_schema in ('public','private') order by 1,2,column_name`),
  constraints:await db.rows(`select conrelid::regclass::text as t,conname,pg_get_constraintdef(oid) as def from pg_constraint
   where connamespace in ('public'::regnamespace,'private'::regnamespace) order by 1,2`),
  policies:await db.rows(`select tablename,policyname,qual,with_check from pg_policies where schemaname='public' order by 1,2`),
  config:await db.rows(`select formula,k,streak_rule,streak_from from private.rating_config`),
 }
}
/** Production as it is now: V1 history, Elo V2 activated, every migration but the streak one applied. */
async function productionToday(){
 const db=await productionLike()
 await db.applyMigration(V2_MIGRATION)
 await db.runPsqlScript('activate.sql',{commit:true})
 for(const f of migrationFiles())if(f>V2_MIGRATION&&f!==STREAK_MIGRATION)await db.applyMigration(f)
 return db
}
const players=async(db:Db)=>(await db.rows<{id:string}>(`select id from public.profiles order by username`)).map(r=>r.id)
type H={game_id:string;mode:Mode;state:string;delta:string;rating_before:string;rating_after:string}
const historyOf=async(db:Db,uid:string)=>(await db.rpcRows<H>(uid,'my_game_history',[null,100])).map(({game_id,mode,state,delta,rating_before,rating_after})=>({game_id,mode,state,delta,rating_before,rating_after}))
const chartOf=(db:Db,uid:string,mode:Mode)=>db.rpcRows<RatedGame>(uid,'my_rating_history',[mode])

/** Chart and History agree game by game, both follow the ledger, and both end at the stored rating. */
async function expectChartMatchesHistory(db:Db,uid:string){
 const history=(await historyOf(db,uid)).reverse() // oldest first
 for(const mode of ['natural','double_single','single_double','double_double'] as Mode[]){
  const chart=await chartOf(db,uid,mode),rated=history.filter(h=>h.mode===mode&&(h.state==='confirmed'||h.state==='tied'))
  expect(chart.map(c=>c.game_id),`${mode} games`).toEqual(rated.map(h=>h.game_id))
  let prev=120000
  for(const [i,c] of chart.entries()){
   expect([cents(c.delta),cents(c.rating_before),cents(c.rating_after)]).toEqual([cents(rated[i].delta),cents(rated[i].rating_before),cents(rated[i].rating_after)])
   const {delta}=await db.one<{delta:number}>(`select delta from public.rating_ledger where game_id=$1 and user_id=$2`,[c.game_id,uid])
   expect(cents(c.delta)).toBe(cents(delta))
   expect(cents(c.rating_before)).toBe(prev);prev=cents(c.rating_after)
  }
  const {rating}=await db.one<{rating:number}>(`select rating from public.ratings where user_id=$1 and mode=$2`,[uid,mode])
  expect(prev,`${mode} final`).toBe(cents(rating))
  if(chart.length){const s=buildSeries(chart);expect(cents(s[peakIndex(s)].rating)).toBe(Math.max(120000,...chart.map(c=>cents(c.rating_after))))}
 }
}

describe('migration order',()=>{
 it('gives the same database whether 202610290001 comes before or after 202610290002',async()=>{
  const inOrder=await Db.create()
  const productionOrder=await Db.create({before:STREAK_MIGRATION})
  for(const f of migrationFiles())if(f>STREAK_MIGRATION)await productionOrder.applyMigration(f)
  await productionOrder.applyMigration(STREAK_MIGRATION)
  expect(await catalog(productionOrder)).toEqual(await catalog(inOrder))
 },T)

 it('applying the streak migration to production as it is today changes no rating, ledger value, game or history',async()=>{
  const db=await productionToday(),ids=await players(db)
  const ratings=()=>db.rows(`select user_id,mode,rating,games,losses from public.ratings order by mode,user_id`)
  const ledger=()=>db.rows(`select game_id,user_id,mode,delta,recorded_at from public.rating_ledger order by mode,game_id,user_id`)
  const before={ratings:await ratings(),ledger:await ledger(),records:await db.gameRecords(),
   history:await Promise.all(ids.map(u=>historyOf(db,u))),
   chart:await Promise.all(ids.flatMap(u=>(['natural','double_single','single_double','double_double'] as Mode[]).map(m=>chartOf(db,u,m))))}
  expect(before.ledger.length).toBeGreaterThan(0)
  await db.applyMigration(STREAK_MIGRATION)
  const check=async()=>{
   expect(await ratings()).toEqual(before.ratings);expect(await ledger()).toEqual(before.ledger)
   expect(await db.gameRecords()).toEqual(before.records)
   expect(await Promise.all(ids.map(u=>historyOf(db,u)))).toEqual(before.history)
   expect(await Promise.all(ids.flatMap(u=>(['natural','double_single','single_double','double_double'] as Mode[]).map(m=>chartOf(db,u,m))))).toEqual(before.chart)
  }
  await check()
  expect((await db.one(`select formula,streak_rule,streak_from from private.rating_config`))).toEqual({formula:'v2',streak_rule:'off',streak_from:null})
  // A full replay with the rule off reproduces production exactly, and the next game is plain V2.
  await db.rebuildAll();await check()
  for(const u of ids)await expectChartMatchesHistory(db,u)
 },T)
})

describe('released features together',()=>{
 it('keeps chart, History and ledger consistent through streak penalties and corrections, all zero-sum',async()=>{
  const db=await productionToday();await db.applyMigration(STREAK_MIGRATION)
  await db.runPsqlScript('loss-streak/activate.sql',{commit:true})
  const [a,b,c,d,e,f]=await db.users('xena','yuri','zoe','walt','vera','uma'),three=[a,b,c],six=[a,b,c,d,e,f]
  const t1=await rpcTable(db,'natural',three),t2=await rpcTable(db,'natural',[a,d,e])
  const losses:string[]=[]
  for(let i=0;i<3;i++)losses.push((await rpcRound(db,i%2?t2:t1,i%2?[a,d,e]:three,[a]))[0])
  const [fourth]=await rpcRound(db,t1,three,[a]),[fifth]=await rpcRound(db,t2,[a,d,e],[a])
  const extra=async(g:string,u:string)=>(await db.one<{e:number}>(`select streak_extra as e from public.rating_ledger where game_id=$1 and user_id=$2`,[g,u])).e
  expect(await extra(fourth,a)).toBeLessThan(0);expect(await extra(fifth,a)).toBeLessThan(0)
  // Parallel mode and a shared loss, with the rule on.
  const sd=await rpcTable(db,'single_double',[a,b,c,d])
  for(let i=0;i<2;i++)await rpcRound(db,sd,[a,b,c,d],[b,b])
  await rpcTiedRound(db,await rpcTable(db,'double_single',six),six,[d,e])
  for(const u of [a,b,c,d,e,f])await expectChartMatchesHistory(db,u)
  // Reversing an early loss: the 4th becomes the 3rd (no penalty), the 5th the 4th (penalized).
  await rpcCorrection(db,losses[0],[b,c],true)
  expect(await extra(fourth,a)).toBe(0);expect(await extra(fifth,a)).toBeLessThan(0)
  expect((await db.one<{n:number}>(`select loss_streak as n from public.ratings where user_id=$1 and mode='natural'`,[a])).n).toBe(4)
  for(const u of [a,b,c,d,e,f])await expectChartMatchesHistory(db,u)
  // Every game sums to exactly zero in whole cents, penalty shares included.
  expect((await db.one<{n:number}>(`select count(*)::int as n from (select game_id from public.rating_ledger group by game_id having sum(delta::numeric)<>0 or sum(streak_extra::numeric)<>0) x`)).n).toBe(0)
  expect((await db.one<{n:number}>(`select count(*)::int as n from public.rating_ledger where delta::numeric<>round(delta::numeric,2)`)).n).toBe(0)
  // Rolling the rule back re-rates without penalties; chart and History follow.
  await db.runPsqlScript('loss-streak/restore.sql',{commit:true})
  expect(await extra(fifth,a)).toBe(0)
  for(const u of [a,b,c,d,e,f])await expectChartMatchesHistory(db,u)
 },T)
})
