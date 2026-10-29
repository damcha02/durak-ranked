// Real PostgreSQL sessions for concurrency tests (PGlite has a single connection).
// Each PsqlSession is one psql process, i.e. one database connection with its own transaction.
import {spawn,execFileSync,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {migrationFiles,SUPABASE_STUB} from './db.ts'

const MIGRATIONS=join(import.meta.dirname,'../../supabase/migrations')
export type Result={out:string;error:string}

export class PsqlSession{
 private out='';private err='';private n=0
 private readonly p:ChildProcessWithoutNullStreams
 constructor(url:string){
  this.p=spawn('psql',[url,'-X','-q','-A','-t','-v','ON_ERROR_STOP=0'],{stdio:'pipe'})
  this.p.stdout.on('data',d=>this.out+=d);this.p.stderr.on('data',d=>this.err+=d)
 }
 /** Sends SQL and resolves once psql has finished it (or reported its error). */
 send(sql:string):Promise<Result>{
  const marker=`__done_${++this.n}__`,o=this.out.length,e=this.err.length
  // The marker goes to both streams, after any rows (stdout) and any error (stderr).
  // psql runs a statement only once it is terminated, so always end it with a semicolon.
  this.p.stdin.write(`${sql.trim().replace(/;?$/,';')}\n\\echo ${marker}\n\\warn ${marker}\n`)
  return new Promise(resolve=>{const check=()=>{
   const i=this.out.indexOf(marker,o),j=this.err.indexOf(marker,e)
   if(i>=0&&j>=0)resolve({out:this.out.slice(o,i).trim(),error:this.err.slice(e,j).trim()});else setTimeout(check,5)
  };check()})
 }
 async ok(sql:string){const r=await this.send(sql);if(r.error)throw Error(`${sql}\n${r.error}`);return r.out}
 close(){this.p.stdin.end()}
}

/** Resolves to 'pending' if the call has not finished within ms. */
export const within=<T>(p:Promise<T>,ms:number)=>Promise.race([p,new Promise<'pending'>(r=>setTimeout(()=>r('pending'),ms))])

/** Creates a fresh database next to the one in `url`, with the Supabase stub and every migration. */
export function freshDatabase(url:string){
 const name=`durak_test_${Date.now()}_${process.pid}`
 execFileSync('psql',[url,'-X','-q','-c',`create database ${name}`])
 const u=new URL(url);u.pathname=`/${name}`;const dbUrl=u.toString()
 const dir=mkdtempSync(join(tmpdir(),'durak-sql-')),stub=join(dir,'stub.sql')
 // Roles are shared by every database on the server and may exist from an earlier run. Test files that set up
 // at the same time on a fresh server race to create them; the loser gets unique_violation, not duplicate_object.
 writeFileSync(stub,SUPABASE_STUB.replace(/create role (\w+) nologin;/g,(_,role)=>`do $$ begin create role ${role} nologin; exception when duplicate_object or unique_violation then null; end $$;`))
 const apply=(file:string)=>execFileSync('psql',[dbUrl,'-X','-q','-1','-v','ON_ERROR_STOP=1','-f',file],{stdio:['ignore','ignore','pipe']})
 apply(stub)
 for(const f of migrationFiles())apply(join(MIGRATIONS,f))
 return {url:dbUrl,drop:()=>execFileSync('psql',[url,'-X','-q','-c',`drop database ${name} with (force)`])}
}
export const sqlText=(file:string)=>readFileSync(join(MIGRATIONS,file),'utf8')
