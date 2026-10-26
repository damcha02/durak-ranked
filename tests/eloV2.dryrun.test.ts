// End-to-end test of the Phase C dry run: export.sql against a production-like V1 database,
// then the local replay and report.
import {describe,it,expect} from 'vitest'
import {productionLike} from './sql/flows'
import {exportFrom,parseExport,dryRun,renderMarkdown,renderCsv} from '../scripts/elo-v2/dryRun'

describe('Phase C dry run',()=>{
 it('passes every check on a consistent V1 history and reports every player per mode',async()=>{
  const db=await productionLike(),before=await db.ratingState()
  const ex=parseExport(await exportFrom(db))
  expect(ex.meta.read_only).toBe('on')
  expect(await db.ratingState()).toEqual(before) // exporting wrote nothing
  const report=await dryRun(ex)
  for(const c of report.checks)expect(c.ok,`${c.name}: ${c.detail}`).toBe(true)
  const s=Object.fromEntries(report.summaries.map(x=>[x.mode,x]))
  expect(s.natural).toMatchObject({players:3,rated:3,voided:1,unresolved:1,correctionsApproved:1,correctionsRejected:1,tableSizes:{3:3}})
  expect(s.double_single).toMatchObject({players:6,rated:2,tied:1,tableSizes:{6:2}})
  expect(s.single_double).toMatchObject({players:4,rated:3,unresolved:1,tableSizes:{4:3}})
  expect(report.players.filter(p=>p.mode==='natural').map(p=>p.username).sort()).toEqual(['alice','bob','carol'])
  expect(report.players.filter(p=>p.mode==='double_double')).toEqual([])
  for(const m of ['natural','double_single','single_double'])
   expect(report.players.filter(p=>p.mode===m).reduce((t,p)=>t+Math.round(p.v2_rating*100)-120000,0)).toBe(0)
  const md=renderMarkdown(report),csv=renderCsv(report)
  expect(md).toContain('## Durak (natural)');expect(md).not.toContain('**FAIL**')
  expect(csv.split('\n')[0]).toBe('username,mode,current_rating,v2_rating,difference,games,losses,current_rank,v2_rank')
  expect(csv.trim().split('\n').length).toBe(1+report.players.length)
 })

 it('flags stored ratings that are not a V1 replay of history',async()=>{
  const ex=parseExport(await exportFrom(await productionLike()))
  const r=ex.ratings.find(x=>x.mode==='natural'&&Number(x.games)>0)!;r.rating=Number(r.rating)+5
  const report=await dryRun(ex)
  expect(report.checks.find(c=>c.name==='Stored ratings equal a fresh V1 replay')!.ok).toBe(false)
 })

 it('flags an export from a database where Elo V2 is already installed',async()=>{
  const db=await productionLike();await db.applyMigration('202610260001_elo_v2.sql')
  const report=await dryRun(parseExport(await exportFrom(db))),c=report.checks.find(x=>x.name==='Elo V2 is not installed in production')!
  expect(c.ok).toBe(false);expect(c.detail).toContain('private.rebuild_mode_v1')
 })

 it('flags deployed functions that differ from the migrations',async()=>{
  const ex=parseExport(await exportFrom(await productionLike()))
  const f=ex.functions.find(x=>x.name==='private.rebuild_mode(p_mode durak_mode)')!
  f.definition=f.definition.replace('32.0','24.0')
  const report=await dryRun(ex),drift=report.checks.find(c=>c.name.startsWith('Deployed functions'))!
  expect(drift.ok).toBe(false);expect(drift.detail).toContain('private.rebuild_mode')
 })
})
