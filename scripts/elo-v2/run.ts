// Usage: node scripts/elo-v2/run.ts [scripts/elo-v2/out/export.jsonl]
// Writes report.md and report.csv next to the export. Exit code 1 if any check fails.
import {readFileSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {parseExport,dryRun,renderMarkdown,renderCsv} from './dryRun.ts'

const input=process.argv[2]??join(import.meta.dirname,'out','export.jsonl')
const report=await dryRun(parseExport(readFileSync(input,'utf8')))
const md=join(dirname(input),'report.md'),csv=join(dirname(input),'report.csv')
writeFileSync(md,renderMarkdown(report));writeFileSync(csv,renderCsv(report))
for(const c of report.checks)console.log(`${c.ok?'PASS':'FAIL'}  ${c.name}\n      ${c.detail}`)
console.log(`\n${report.players.length} player/mode rows. Report: ${md}\nCSV: ${csv}`)
process.exitCode=report.checks.every(c=>c.ok)?0:1
