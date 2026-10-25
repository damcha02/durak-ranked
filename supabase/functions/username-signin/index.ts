/**
 * Authenticated password login by public username.
 * Must be deployed with --no-verify-jwt to allow signed-out users to call it.
 * The service role key NEVER leaves the Edge Function.
 * The user's password is checked by Supabase Auth, not by this function.
 */
import {createClient} from 'npm:@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL')!
const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const origins = (Deno.env.get('DURAK_ALLOWED_ORIGINS') || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map(v=>v.trim()).filter(Boolean)
const admin = createClient(url,adminKey,{auth:{persistSession:false,autoRefreshToken:false}})
const respond=(body:Record<string,unknown>,status:number,origin:string|null)=>new Response(JSON.stringify(body),{
  status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    ...(origin&&origins.includes(origin)?{'access-control-allow-origin':origin,vary:'Origin'}:{})}
})
const sha256=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('')

Deno.serve(async request=>{
  const origin=request.headers.get('origin')
  if(request.method==='OPTIONS'){
    if(!origin||!origins.includes(origin))return new Response(null,{status:403})
    return new Response(null,{status:204,headers:{
      'access-control-allow-origin':origin,
      'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'authorization, apikey, content-type, x-client-info',
      'access-control-max-age':'3600',vary:'Origin'
    }})
  }
  if(origin&&!origins.includes(origin))return respond({error:'Forbidden'},403,origin)
  if(request.method!=='POST')return respond({error:'Method not allowed'},405,origin)
  if(Number(request.headers.get('content-length')||'0')>4096)return respond({error:'Request too large'},413,origin)

  try{
    const input=await request.json() as Record<string,unknown>
    const username=input.username, password=input.password
    if(typeof username!=='string'||!(/^[A-Za-z0-9_]{3,22}$/).test(username)||typeof password!=='string'||password.length>128||password.length===0){
      return respond({error:'Invalid credentials'},401,origin)
    }
    // Per-user throttling remains effective even when caller IP is not available.
    // Supabase's own password-auth rate limits provide another layer.
    const ip=(request.headers.get('cf-connecting-ip')||request.headers.get('x-forwarded-for')?.split(',')[0]||'unknown').trim()
    for(const [name,max,period] of [[`username:${username.toLowerCase()}`,10,600],[`ip:${ip}`,40,600]] as const){
      const {data,error}=await admin.rpc('username_signin_rate_limit',{
        p_key_hash:await sha256(name),p_max_attempts:max,p_window_seconds:period
      })
      if(error){console.error('Rate limit query failed',error.message);return respond({error:'Authentication unavailable'},503,origin)}
      if(!data)return respond({error:'Too many attempts'},429,origin)
    }

    const {data:userId,error:lookupError}=await admin.rpc('lookup_username_for_login',{p_username:username})
    if(lookupError){console.error('Username lookup failed',lookupError.message);return respond({error:'Authentication unavailable'},503,origin)}
    if(!userId)return respond({error:'Invalid credentials'},401,origin)
    const {data:userData,error:userError}=await admin.auth.admin.getUserById(userId as string)
    if(userError||!userData.user.email)return respond({error:'Invalid credentials'},401,origin)
    const authClient=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}})
    const {data,error}=await authClient.auth.signInWithPassword({email:userData.user.email,password})
    if(error||!data.session)return respond({error:'Invalid credentials'},401,origin)
    return respond({access_token:data.session.access_token,refresh_token:data.session.refresh_token},200,origin)
  }catch(error){
    console.error('Username sign-in unavailable',error instanceof Error?error.message:'unknown error')
    return respond({error:'Authentication unavailable'},503,origin)
  }
})
