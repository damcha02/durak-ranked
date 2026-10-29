// scripts/loss-streak/activate.sql and restore.sql against the real migrations (PGlite), on a copy shaped
// like production: history rated under V1, then Elo V2 activated by its own script, then every later migration.
import {describe,it,expect} from 'vitest'
import {Db,V2_MIGRATION,STREAK_MIGRATION,migrationFiles} from './sql/db'
import {productionLike,rpcTable,rpcRound} from './sql/flows'

const T=120_000
/** Production's order: every later migration (the rating-history one, 202610290002, included) is already
 * applied when the earlier-numbered streak migration arrives. */
async function production({streakMigration=true}={}){
 const db=await productionLike()
 await db.applyMigration(V2_MIGRATION)
 await db.runPsqlScript('activate.sql',{commit:true}) // Elo V2, as on 2026-10-26
 for(const f of migrationFiles())if(f>V2_MIGRATION&&f!==STREAK_MIGRATION)await db.applyMigration(f)
 if(streakMigration)await db.applyMigration(STREAK_MIGRATION)
 return db
}
const config=(db:Db)=>db.one<{streak_rule:string;streak_from:Date|null;formula:string}>(`select streak_rule,streak_from,formula from private.rating_config`)
const hasBackup=async(db:Db)=>(await db.one<{ok:boolean}>(`select to_regnamespace('loss_streak_backup') is not null as ok`)).ok
const activate=(db:Db,commit:boolean)=>db.runPsqlScript('loss-streak/activate.sql',{commit})
const restore=(db:Db,commit:boolean)=>db.runPsqlScript('loss-streak/restore.sql',{commit})
async function loseFour(db:Db){
 const [x,y,z]=await db.users('xena','yuri','zoe'),tid=await rpcTable(db,'natural',[x,y,z])
 const games:string[]=[]
 for(let i=0;i<4;i++)games.push((await rpcRound(db,tid,[x,y,z],[x]))[0])
 return {x,games}
}
const extraOf=async(db:Db,game:string,user:string)=>(await db.one<{e:number}>(`select streak_extra as e from public.rating_ledger where game_id=$1 and user_id=$2`,[game,user])).e

describe('loss-streak activate.sql',()=>{
 it('rehearsal (no commit) leaves production exactly as it was',async()=>{
  const db=await production(),before={rating:await db.ratingState(),records:await db.gameRecords(),config:await config(db)}
  await activate(db,false)
  expect(await db.ratingState()).toEqual(before.rating)
  expect(await db.gameRecords()).toEqual(before.records)
  expect(await config(db)).toEqual(before.config);expect(await hasBackup(db)).toBe(false)
 },T)

 it('activates without re-rating any game, then penalizes the 4th loss in a row',async()=>{
  const db=await production(),before={rating:await db.ratingState(),records:await db.gameRecords()}
  await activate(db,true)
  const c=await config(db)
  expect(c.streak_rule).toBe('loss_streak_v1');expect(c.streak_from).toBeInstanceOf(Date)
  expect(await db.ratingState()).toEqual(before.rating) // ratings, ledger, streak columns: identical
  expect(await db.gameRecords()).toEqual(before.records)
  expect(await db.rows(`select * from loss_streak_backup.ratings order by mode,user_id`)).toEqual(before.rating.ratings)
  for(const role of ['anon','authenticated'])
   expect((await db.one<{ok:boolean}>(`select has_schema_privilege($1,'loss_streak_backup','usage') or has_table_privilege($1,'loss_streak_backup.ratings','select') as ok`,[role])).ok).toBe(false)
  const {x,games}=await loseFour(db)
  for(const g of games.slice(0,3))expect(await extraOf(db,g,x)).toBe(0)
  expect(await extraOf(db,games[3],x)).toBeLessThan(0)
 },T)

 it('refuses without the migration, without V2, twice, or over an existing backup',async()=>{
  const bare=await production({streakMigration:false})
  await expect(activate(bare,true)).rejects.toThrow(/202610290001_loss_streak_penalty.sql is not applied/)

  const v1=await Db.create()
  await expect(activate(v1,true)).rejects.toThrow(/Elo V2 is not active/)

  const db=await production()
  await activate(db,true)
  await expect(activate(db,true)).rejects.toThrow(/already active/)
  await restore(db,true)
  await expect(activate(db,true)).rejects.toThrow(/loss_streak_backup already exists/)
 },T)

 it('rolls back everything when a check fails',async()=>{
  const db=await production(),before={rating:await db.ratingState(),config:await config(db)}
  // A round dated in the future would fall after the activation point: activation must refuse.
  await db.pg.query(`update public.rounds set started_at=now()+interval '1 day' where id=(select id from public.rounds order by started_at desc limit 1)`)
  await expect(activate(db,true)).rejects.toThrow(/A round already starts at or after the activation time/)
  expect(await config(db)).toEqual(before.config);expect(await hasBackup(db)).toBe(false)
  expect(await db.ratingState()).toEqual(before.rating)
 },T)
})

describe('loss-streak restore.sql',()=>{
 it('restores the exact pre-activation state when nothing was played since',async()=>{
  const db=await production(),before=await db.ratingState()
  await activate(db,true)
  await restore(db,false) // rehearsal
  expect((await config(db)).streak_rule).toBe('loss_streak_v1')
  await restore(db,true)
  expect(await config(db)).toMatchObject({streak_rule:'off',streak_from:null,formula:'v2'})
  expect(await db.ratingState()).toEqual(before)
  expect(await hasBackup(db)).toBe(true)
 },T)

 it('keeps games played since activation and re-rates them without the penalty',async()=>{
  const db=await production()
  await activate(db,true)
  const {x,games}=await loseFour(db)
  const records=await db.gameRecords()
  expect(await extraOf(db,games[3],x)).toBeLessThan(0)
  await restore(db,true)
  expect(await extraOf(db,games[3],x)).toBe(0)
  expect((await db.one<{n:number}>(`select loss_streak as n from public.ratings where user_id=$1 and mode='natural'`,[x])).n).toBe(0)
  expect(await db.gameRecords()).toEqual(records)
  // The result is a plain V2 replay of the whole history.
  const restored=await db.ratingState()
  await db.rebuildAll()
  expect(await db.ratingState()).toEqual(restored)
 },T)

 it('refuses when the penalty is not active or there is no backup',async()=>{
  const db=await production()
  await expect(restore(db,true)).rejects.toThrow(/No loss_streak_backup snapshot/)
  await activate(db,true);await restore(db,true)
  await expect(restore(db,true)).rejects.toThrow(/not active/)
 },T)
})

describe('loss-streak status.sql',()=>{
 it('runs read-only and changes nothing',async()=>{
  const db=await production();await activate(db,true);await loseFour(db)
  const before=await db.ratingState()
  await db.pg.exec('begin read only')
  const body=(await import('node:fs')).readFileSync(new URL('../scripts/loss-streak/status.sql',import.meta.url),'utf8').split('\n').filter(l=>!/^(begin|rollback)/.test(l.trim())).join('\n')
  await db.pg.exec(body)
  await db.pg.exec('rollback')
  expect(await db.ratingState()).toEqual(before)
 },T)
})
