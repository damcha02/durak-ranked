#!/usr/bin/env python3
"""Update the existing Durak App.tsx without overwriting the rest of the app."""
from pathlib import Path

app_path = Path('src/App.tsx')
lib_path = Path('src/lib.ts')
if not app_path.exists() or not lib_path.exists():
    raise SystemExit('Run this from the durak-rating directory (with src/App.tsx present).')
app = app_path.read_text()
lib = lib_path.read_text()
if 'signInByUsername' in app:
    raise SystemExit('Auth patch appears already applied; no changes made.')
if 'usernameAuth' in app or Path('src/authUsername.ts').exists():
    raise SystemExit('The OLD username-only patch appears applied. Stop and restore the Stage 4 Git commit before proceeding.')

start = app.find('function AuthScreen(){')
end = app.find('\nexport default function App(){',start)
if start < 0 or end < 0:
    raise SystemExit('Cannot locate expected AuthScreen. No changes made.')
new_auth = '''function AuthScreen(){
 const [identifier,setIdentifier]=useState(''),[email,setEmail]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState('')
 const [tab,setTab]=useState<'sign-in'|'register'>('sign-in'),[notice,setNotice]=useState(''),[working,setWorking]=useState(false)
 const act=async(fn:()=>Promise<void>)=>{setWorking(true);setNotice('');try{await fn()}catch(e){setNotice(errorMessage(e))}finally{setWorking(false)}}
 const submit=()=>void act(async()=>{
  if(tab==='register'){
   const handle=username.trim()
   if(!isUsername(handle))throw new Error('Username must contain 3–22 letters, numbers or underscores.')
   if(password.length<10)throw new Error('Choose a password of at least 10 characters.')
   const {data,error}=await supabase.auth.signUp({
     email:email.trim(),password,options:{data:{username:handle}}
   })
   if(error){
    if(/database error saving new user/i.test(error.message))throw new Error('Registration failed. This username may already be taken.')
    throw error
   }
   if(!data.session)throw new Error('Account created but no session returned. Disable Confirm Email in Supabase Authentication → Email provider, or confirm your email.')
   // The onAuthStateChange listener switches directly to the dashboard.
  }else if(isEmailIdentifier(identifier)){
   const {error}=await supabase.auth.signInWithPassword({email:identifier.trim(),password})
   if(error)throw error
  }else{
   if(!isUsername(identifier.trim()))throw new Error('Enter a valid username or email address.')
   await signInByUsername(identifier.trim(),password)
  }
 })
 const provider=(p:'google'|'apple')=>void act(async()=>{const{error}=await supabase.auth.signInWithOAuth({provider:p,options:{redirectTo:location.origin+location.pathname}});if(error)throw error})
 return <div className="authWrap"><div className="authGlow"/><div className="authPanel">
  <div className="logo large"><span className="logoIcon">♠</span><span>durak<span className="logoDot">.</span></span></div>
  <div className="eyebrow">THE GAME STAYS ON THE TABLE</div>
  <h1>Make every<br/><em>loss count.</em></h1>
  <p className="authSub">Play with real cards. Track every round. Climb the leaderboard with friends.</p>
  <div className="segmented"><button className={tab==='sign-in'?'selected':''} onClick={()=>setTab('sign-in')}>Sign in</button><button className={tab==='register'?'selected':''} onClick={()=>setTab('register')}>Create account</button></div>
  <form onSubmit={e=>{e.preventDefault();submit()}} className="stack sm">
   {tab==='register'?<>
    <label>Username<input required type="text" minLength={3} maxLength={22} pattern="[A-Za-z0-9_]{3,22}" placeholder="cookie" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)}/></label>
    <label>Email address<input required type="email" placeholder="you@example.com" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>
   </>:<label>Username or email<input required type="text" placeholder="cookie or you@example.com" autoComplete="username" value={identifier} onChange={e=>setIdentifier(e.target.value)}/></label>}
   <label>Password<input required minLength={tab==='register'?10:1} type="password" placeholder="••••••••••" autoComplete={tab==='register'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>
   <Button type="submit" disabled={working}>{working?'Please wait…':tab==='register'?'Create account':'Sign in'} <ArrowRight size={17}/></Button>
  </form>
  {tab==='register'&&<p className="muted tiny">No email confirmation required during this testing phase. Use an email address you control so you can recover your account.</p>}
  <div className="or">or continue with</div>
  <div className="social"><Button kind="secondary" onClick={()=>provider('google')} disabled={working}>Google</Button><Button kind="secondary" onClick={()=>provider('apple')} disabled={working}>Apple</Button></div>
  <p className="muted tiny">Google and Apple require provider configuration. Apple sign-in typically requires an Apple Developer membership.</p>
  {notice&&<div className="alert" role="alert">{notice}</div>}
 </div></div>
}
'''

app = app[:start] + new_auth + app[end:]
import_needle = "import {configured,date,errorMessage,MODES,modeInfo,rpc,supabase} from './lib'"
if import_needle not in app:
    raise SystemExit('Cannot find lib import. No changes saved.')
app=app.replace(import_needle,import_needle+"\nimport {isEmailIdentifier,isUsername} from './authValidation'\nimport {signInByUsername} from './usernameSignIn'",1)
profile_line = " const [name,setName]=useState(profile?.username||''),[ratings,setRatings]=useState<Rating[]>([]),[admissions,setAdmissions]=useState(0),[ledger,setLedger]=useState<{game_id:string;delta:number;recorded_at:string;mode:Mode}[]>([])"
if profile_line not in app:
    raise SystemExit('Cannot find profile state line. No changes saved.')
profile_add='''
 const [accountEmail,setAccountEmail]=useState(''),[oldPassword,setOldPassword]=useState(''),[nextPassword,setNextPassword]=useState(''),[accountNotice,setAccountNotice]=useState('')
 useEffect(()=>{let live=true;void supabase.auth.getUser().then(({data})=>{if(live)setAccountEmail(data.user?.email||'')}).catch(console.error);return()=>{live=false}},[me])'''
app=app.replace(profile_line,profile_line+profile_add,1)
old_section='''  <section className="card stack sm"><h2>Account settings</h2><label>Display username<input value={name} onChange={e=>setName(e.target.value)} maxLength={22}/></label><Button kind="secondary" onClick={()=>void action(async()=>{await rpc('set_username',{p_username:name.trim()});await reload()})}>Save username</Button><Button kind="danger" onClick={()=>void supabase.auth.signOut()}>Sign out <LogOut size={17}/></Button></section>'''
new_section='''  <section className="card stack sm"><h2>Account settings</h2>
   <label>Display username<input value={name} onChange={e=>setName(e.target.value)} maxLength={22}/></label>
   <Button kind="secondary" onClick={()=>void action(async()=>{await rpc('set_username',{p_username:name.trim()});await reload();setAccountNotice('Username updated.')})}>Save username</Button>
   <label>Email address<input type="email" autoComplete="email" value={accountEmail} onChange={e=>setAccountEmail(e.target.value)}/></label>
   <Button kind="secondary" onClick={()=>void action(async()=>{
    if(!accountEmail.trim())throw new Error('Enter an email address.')
    const {data,error}=await supabase.auth.updateUser({email:accountEmail.trim()})
    if(error)throw error
    setAccountNotice(data.user?.new_email ? 'Email change pending. Follow the verification instructions sent to your email.' : 'Email update requested. If Supabase sends confirmation links, complete them to finish.')
   })}>Update email</Button>
   <p className="muted tiny">Keep Secure email change enabled in Supabase. Email changes may require confirmation of the old and new addresses.</p>
   <label>Current password<input type="password" autoComplete="current-password" value={oldPassword} onChange={e=>setOldPassword(e.target.value)}/></label>
   <label>New password<input type="password" minLength={10} autoComplete="new-password" value={nextPassword} onChange={e=>setNextPassword(e.target.value)}/></label>
   <Button kind="secondary" onClick={()=>void action(async()=>{
    if(nextPassword.length<10)throw new Error('New password must be at least 10 characters.')
    if(!oldPassword)throw new Error('Enter your current password.')
    const {data:user,error:userError}=await supabase.auth.getUser()
    if(userError||!user.user?.email)throw userError||new Error('Cannot determine current email.')
    const {error:loginError}=await supabase.auth.signInWithPassword({email:user.user.email,password:oldPassword})
    if(loginError)throw new Error('Current password is incorrect.')
    const {error:updateError}=await supabase.auth.updateUser({password:nextPassword})
    if(updateError)throw updateError
    setOldPassword('');setNextPassword('');setAccountNotice('Password changed.')
   })}>Change password</Button>
   {accountNotice&&<p className="muted tiny" role="status">{accountNotice}</p>}
   <Button kind="danger" onClick={()=>void supabase.auth.signOut()}>Sign out <LogOut size={17}/></Button>
  </section>'''
if old_section not in app:
    raise SystemExit('Cannot find expected account-settings section. No changes saved.')
app=app.replace(old_section,new_section,1)
app=app.replace('NATURAL ELO','DURAK ELO').replace('NATURAL DURAK · RATING TREND','DURAK · RATING TREND').replace('Natural Durak cumulative rating trend','Durak cumulative rating trend')
lib=lib.replace("name:'Natural Durak'","name:'Durak'")
app_path.write_text(app)
lib_path.write_text(lib)
print('Applied email + username + password frontend update; existing game logic preserved.')
