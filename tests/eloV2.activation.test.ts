// scripts/elo-v2/activate.sql and restore.sql against the real migrations (PGlite).
// The psql meta-commands (\if commit) are exercised separately with real psql; here the
// harness decides commit vs. rollback exactly as those branches do.
import {describe,it,expect} from 'vitest'
import {Db,MODES,V2_MIGRATION} from './sql/db'
import {productionLike,rpcTable,rpcRound} from './sql/flows'

/** Production as it will be just before activation: history under V1, migration applied, switch off. */
async function migrated(){const db=await productionLike();await db.applyMigration(V2_MIGRATION);return db}
const formula=async(db:Db)=>(await db.one<{formula:string}>(`select formula from private.rating_config`)).formula
const hasBackup=async(db:Db)=>(await db.one<{ok:boolean}>(`select to_regnamespace('elo_v2_backup') is not null as ok`)).ok
async function preview(db:Db){
 const out:Record<string,number>={}
 for(const m of MODES)for(const r of await db.rows<{user_id:string;v2_rating:string}>(`select user_id,v2_rating from private.elo_v2_preview($1)`,[m]))out[`${m}/${r.user_id}`]=Number(r.v2_rating)
 return out
}
async function ratingsByKey(db:Db){
 return Object.fromEntries((await db.rows<{user_id:string;mode:string;rating:number;games:number}>(`select * from public.ratings where games>0`)).map(r=>[`${r.mode}/${r.user_id}`,r.rating]))
}

describe('activate.sql',()=>{
 it('rehearsal (no commit) leaves production exactly as it was',async()=>{
  const db=await migrated(),before={rating:await db.ratingState(),records:await db.gameRecords()}
  await db.runPsqlScript('activate.sql',{commit:false})
  expect(await db.ratingState()).toEqual(before.rating)
  expect(await db.gameRecords()).toEqual(before.records)
  expect(await formula(db)).toBe('v1');expect(await hasBackup(db)).toBe(false)
 })

 it('activates V2: ratings equal the dry-run preview, backup equals the old state, history untouched',async()=>{
  const db=await migrated(),before={rating:await db.ratingState(),records:await db.gameRecords()},expected=await preview(db)
  await db.runPsqlScript('activate.sql',{commit:true})
  expect(await formula(db)).toBe('v2')
  const now=await ratingsByKey(db)
  expect(Object.keys(now).sort()).toEqual(Object.keys(expected).sort())
  for(const k of Object.keys(expected))expect(Math.round(now[k]*100),k).toBe(Math.round(expected[k]*100))
  expect(await db.gameRecords()).toEqual(before.records)
  expect({ratings:await db.rows(`select * from elo_v2_backup.ratings order by mode,user_id`),
   ledger:await db.rows(`select * from elo_v2_backup.rating_ledger order by mode,game_id,user_id`)}).toEqual(before.rating)
  expect((await db.one<{formula_before:string}>(`select formula_before from elo_v2_backup.meta`)).formula_before).toBe('v1')
  // Browser roles cannot see the backup.
  for(const role of ['anon','authenticated'])
   expect((await db.one<{ok:boolean}>(`select has_schema_privilege($1,'elo_v2_backup','usage') or has_table_privilege($1,'elo_v2_backup.ratings','select') as ok`,[role])).ok).toBe(false)
  // The next real game is rated by V2.
  const [x,y,z]=await db.users('xena','yuri','zoe')
  const [game]=await rpcRound(db,await rpcTable(db,'natural',[x,y,z]),[x,y,z],[x])
  const loss=(await db.ledger('natural')).find(l=>l.game_id===game&&l.user_id===x)!.delta
  expect(Math.abs(loss+13.33)).toBeLessThanOrEqual(0.01)
 })

 it('refuses to run without the migration, twice, or over an existing backup',async()=>{
  const bare=await productionLike(),before=await bare.ratingState()
  await expect(bare.runPsqlScript('activate.sql',{commit:true})).rejects.toThrow(/202610260001_elo_v2.sql is not applied/)
  expect(await bare.ratingState()).toEqual(before)

  const db=await migrated()
  await db.runPsqlScript('activate.sql',{commit:true})
  await expect(db.runPsqlScript('activate.sql',{commit:true})).rejects.toThrow(/already active/)
  await db.runPsqlScript('restore.sql',{commit:true})
  await expect(db.runPsqlScript('activate.sql',{commit:true})).rejects.toThrow(/elo_v2_backup already exists/)
 })

 it('rolls back everything (switch, ratings, backup) when the replay fails',async()=>{
  const db=await migrated(),outsider=await db.user('outsider'),before=await db.ratingState()
  // Corrupt history: a rated game whose loser was not at the table.
  await db.pg.query(`update public.round_games set loser_ids=array[$1::uuid] where id=(select id from public.round_games where state='confirmed' order by finalized_at limit 1)`,[outsider])
  await expect(db.runPsqlScript('activate.sql',{commit:true})).rejects.toThrow(/Invalid loser list/)
  expect(await formula(db)).toBe('v1');expect(await hasBackup(db)).toBe(false)
  expect(await db.ratingState()).toEqual(before)
 })
})

describe('restore.sql',()=>{
 it('restores the exact pre-activation V1 ratings when nothing was played since',async()=>{
  const db=await migrated(),before={rating:await db.ratingState(),records:await db.gameRecords()}
  await db.runPsqlScript('activate.sql',{commit:true})
  const active=await db.ratingState()
  await db.runPsqlScript('restore.sql',{commit:false}) // rehearsal
  expect(await db.ratingState()).toEqual(active);expect(await formula(db)).toBe('v2')
  await db.runPsqlScript('restore.sql',{commit:true})
  expect(await formula(db)).toBe('v1')
  const after=await db.ratingState()
  for(const [i,r] of before.rating.ratings.entries()){
   const o=after.ratings[i];expect([o.user_id,o.mode,o.games,o.losses]).toEqual([r.user_id,r.mode,r.games,r.losses])
   expect(Math.abs(Number(o.rating)-Number(r.rating))).toBeLessThan(1e-9)
  }
  expect(after.ledger.length).toBe(before.rating.ledger.length)
  expect(await db.gameRecords()).toEqual(before.records)
  expect(await hasBackup(db)).toBe(true) // kept until dropped by hand
 })

 it('keeps games played after activation and rates the whole history under V1',async()=>{
  const db=await migrated()
  await db.runPsqlScript('activate.sql',{commit:true})
  const [x,y,z]=await db.users('xena','yuri','zoe')
  const [game]=await rpcRound(db,await rpcTable(db,'natural',[x,y,z]),[x,y,z],[x])
  await db.runPsqlScript('restore.sql',{commit:true})
  const loss=(await db.ledger('natural')).find(l=>l.game_id===game&&l.user_id===x)!.delta
  expect(loss).toBeCloseTo(-16,9) // V1 again
  const restored=await db.ratingState()
  await db.rebuildAll() // an independent V1 replay agrees
  const again=await db.ratingState()
  restored.ratings.forEach((r,i)=>expect(Math.abs(Number(r.rating)-Number(again.ratings[i].rating))).toBeLessThan(1e-9))
 })

 it('refuses when V2 is not active or there is no backup',async()=>{
  const db=await migrated()
  await expect(db.runPsqlScript('restore.sql',{commit:true})).rejects.toThrow(/No elo_v2_backup snapshot/)
  await db.runPsqlScript('activate.sql',{commit:true});await db.runPsqlScript('restore.sql',{commit:true})
  await expect(db.runPsqlScript('restore.sql',{commit:true})).rejects.toThrow(/not active/)
 })
})
