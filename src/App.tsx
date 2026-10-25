import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react'
import type {Session} from '@supabase/supabase-js'
import {QRCodeSVG} from 'qrcode.react'
import {ArrowRight,ChevronDown,Clock3,Copy,Crown,LogOut,RefreshCw,ShieldCheck,Star,X} from 'lucide-react'
import {configured,date,errorMessage,MODES,modeInfo,rpc,supabase} from './lib'
import {isEmailIdentifier,isUsername} from './authValidation'
import {signInByUsername} from './usernameSignIn'
import {applyTheme,readTheme,saveTheme,THEMES} from './theme'
import type {Theme} from './theme'
import type {Game,Group,Member,Mode,Profile,Rating,TableRow,VoteTotal} from './lib'

type Page='home'|'leaderboard'|'groups'|'profile'
type Action=(fn:()=>Promise<unknown>)=>Promise<void>
const formatRating=(rating:number)=>Math.round(rating).toLocaleString()
const getJoinCode=()=>new URLSearchParams(location.search).get('join')?.trim().toUpperCase() || ''
const Stars=({compact=false}:{compact?:boolean})=><span className="stars" title="5-star reputation baseline"><Star size={compact?11:14} fill="currentColor"/> 5.0</span>
const APP_NAME='Durak Ranked'
// Every game mode is a card with a corner index (abbreviation + suit). \uFE0E keeps iOS from drawing the suits as emoji.
const MODE_CARD:Record<Mode,{abbr:string;suit:string;red:boolean}>={natural:{abbr:'D',suit:'\u2660\uFE0E',red:false},double_single:{abbr:'DS',suit:'\u2663\uFE0E',red:false},single_double:{abbr:'SD',suit:'\u2665\uFE0E',red:true},double_double:{abbr:'DD',suit:'\u2666\uFE0E',red:true}}
const CornerIndex=({mode,flip=false}:{mode:Mode;flip?:boolean})=><span className={`cornerIndex ${MODE_CARD[mode].red?'red':''} ${flip?'flip':''}`} aria-hidden="true">{MODE_CARD[mode].abbr}<br/>{MODE_CARD[mode].suit}</span>
const MiniModeCard=({mode}:{mode:Mode})=><span className={`miniCard ${MODE_CARD[mode].red?'red':''}`} aria-hidden="true"><span className="miniIndex">{MODE_CARD[mode].abbr}</span>{MODE_CARD[mode].suit}</span>
const Brand=()=><span className="brand"><span className="brandMark" aria-hidden="true">{'\u2660\uFE0E'}</span><span>{APP_NAME}</span></span>
const NAV:{id:Page;label:string;suit:string;red:boolean}[]=[{id:'home',label:'Home',suit:'\u2660\uFE0E',red:false},{id:'leaderboard',label:'Rankings',suit:'\u2663\uFE0E',red:false},{id:'groups',label:'Groups',suit:'\u2665\uFE0E',red:true},{id:'profile',label:'Profile',suit:'\u2666\uFE0E',red:true}]
const STATUS_TEXT:Record<TableRow['status'],string>={lobby:'Waiting for players',playing:'Game in progress',results:'Recording results'}
const STATUS_ORDER:Record<TableRow['status'],number>={results:0,playing:1,lobby:2}
const greeting=()=>{const h=new Date().getHours();return h>=5&&h<12?'Good morning':h>=12&&h<18?'Good afternoon':'Good evening'}

function Button({children,onClick,kind='primary',disabled=false,className='',type='button'}:{children:React.ReactNode;onClick?:()=>void;kind?:'primary'|'secondary'|'outline'|'ghost'|'danger';disabled?:boolean;className?:string;type?:'button'|'submit'}){
 return <button type={type} className={`button ${kind} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>
}
// Two looks share every screen: "cards" (card stock, corner indices) and "blue" (the light-blue prototype).
// Where the layouts differ, components branch on useBlue(); data loading and actions are shared.
const ThemeContext=createContext<{theme:Theme;setTheme:(t:Theme)=>void}>({theme:'cards',setTheme:()=>{}})
const useBlue=()=>useContext(ThemeContext).theme==='blue'
// Soft avatar tints for the blue theme, picked from the user id so each player keeps one colour; you are always the action tint.
const TINTS=['#F1DCCF','#D9E8DC','#ECE3C8','#E2DDEE','#F3E1E8']
const tint=(id:string,me?:string)=>id===me?'#D6E6F2':TINTS[[...id].reduce((s,c)=>s+c.charCodeAt(0),0)%TINTS.length]
const Avatar=({id,name,me,size=''}:{id:string;name:string;me?:string;size?:string})=><span className={`tintAvatar ${size}`} style={{background:tint(id,me)}} aria-hidden="true">{name.slice(0,2).toUpperCase()}</span>
const listNames=(names:string[])=>names.length<=1?(names[0]||''):`${names.slice(0,-1).join(', ')} and ${names[names.length-1]}`
const SuitBox=({mode}:{mode:Mode})=><span className={`suitBox ${MODE_CARD[mode].red?'red':''}`} aria-hidden="true">{MODE_CARD[mode].suit}</span>

// Bottom sheet (blue theme): pickers and the invite open over the page so you keep your place.
function Sheet({open,title,onClose,children}:{open:boolean;title:string;onClose:()=>void;children:React.ReactNode}){
 const panel=useRef<HTMLDivElement>(null),close=useRef(onClose)
 close.current=onClose
 useEffect(()=>{
  if(!open)return
  const back=document.activeElement as HTMLElement|null
  const focusable=()=>[...(panel.current?.querySelectorAll<HTMLElement>('button,a[href],input,select')||[])].filter(el=>!el.hasAttribute('disabled'))
  ;(panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]')||focusable()[0])?.focus()
  const key=(e:KeyboardEvent)=>{
   if(e.key==='Escape'){e.preventDefault();close.current();return}
   if(e.key!=='Tab')return
   const items=focusable();if(!items.length)return
   const first=items[0],last=items[items.length-1]
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  }
  document.addEventListener('keydown',key)
  return()=>{document.removeEventListener('keydown',key);back?.focus()}
 },[open])
 return <>
  <div className={`scrim ${open?'open':''}`} onClick={onClose} aria-hidden="true"/>
  <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className={`sheet ${open?'open':''}`} inert={!open}>
   <span className="sheetGrip" aria-hidden="true"/>
   <div className="sheetHead"><h2>{title}</h2><button className="linkButton plain" onClick={onClose}>Done</button></div>
   {children}
  </div>
 </>
}

// Suits double as tab icons in the cards theme; the blue theme shows labels on a sliding pill.
// Rendered twice (bottom bar on phones, header on desktop); CSS shows one.
function NavTabs({page,go,className}:{page:Page|null;go:(p:Page)=>void;className:string}){
 const index=NAV.findIndex(n=>n.id===page)
 return <nav className={className} aria-label="Main">
  {index>=0&&<span className="navPill" aria-hidden="true" style={{transform:`translateX(${index*100}%)`}}/>}
  {NAV.map(n=><button key={n.id} className={`${page===n.id?'on':''} ${n.red?'red':''}`} aria-current={page===n.id?'page':undefined} onClick={()=>go(n.id)}><span className="navSuit" aria-hidden="true">{n.suit}</span><span>{n.label}</span></button>)}
 </nav>
}
function AuthScreen({joinCode}:{joinCode:string}){
 const [identifier,setIdentifier]=useState(''),[email,setEmail]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState('')
 const [tab,setTab]=useState<'sign-in'|'register'>('sign-in'),[notice,setNotice]=useState(''),[working,setWorking]=useState(false)
 const blue=useBlue()
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
 // Username problems are shown under the username field; everything else above the submit button.
 const usernameError=tab==='register'&&/username/i.test(notice)
 const errorLine=<p id="auth-error" className="fieldError" role="alert"><span aria-hidden="true">{'\u2666\uFE0E'}</span>{notice}</p>
 return <div className="authWrap"><main className="authInner">
  {joinCode?<>
   <h1 className="brandHeading"><Brand/></h1>
   <div className="authInvite" role="status"><span className="inviteCard" aria-hidden="true">{joinCode.slice(0,4)}<br/>{joinCode.slice(4)}</span><p>You've been invited to table <strong>{joinCode}</strong>. Sign in or create an account and you'll join it straight away.</p></div>
  </>:blue?<header className="authIntro">
   <span className="authMark" aria-hidden="true">{'\u2660\uFE0E'}</span>
   <h1>{APP_NAME}</h1>
   <p>A scorebook for your Durak nights. Play with real cards, vote on who lost, and keep a rating for each game mode.</p>
  </header>:<header className="authIntro">
   <div className="brandLarge"><span className="brandFan" aria-hidden="true"><span className="fanBack"/><span className="fanFront"><span className="miniIndex">D</span>{'\u2660\uFE0E'}</span></span><h1>Durak<br/>Ranked</h1></div>
   <p>Keep score for the games you play with a real deck. Vote on who's left holding cards, and see your rating per mode.</p>
  </header>}
  <div className="authTabs" role="group" aria-label="Account">
   <span className={`authThumb ${tab==='register'?'right':''}`} aria-hidden="true"/>
   <button type="button" aria-pressed={tab==='sign-in'} className={tab==='sign-in'?'selected':''} onClick={()=>setTab('sign-in')}>Sign in</button>
   <button type="button" aria-pressed={tab==='register'} className={tab==='register'?'selected':''} onClick={()=>setTab('register')}>Create account</button>
  </div>
  <form className="authCard" aria-label={tab==='register'?'Create account':'Sign in'} onSubmit={e=>{e.preventDefault();submit()}}>
   {tab==='register'?<>
    <div className="fieldGroup"><label className="field">Username<input required type="text" minLength={3} maxLength={22} pattern="[A-Za-z0-9_]{3,22}" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={usernameError||undefined} aria-describedby={usernameError?'auth-error':undefined} value={username} onChange={e=>setUsername(e.target.value)}/></label>{usernameError&&errorLine}</div>
    <label className="field">Email address<input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>
   </>:<label className="field">Username or email<input required type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={identifier} onChange={e=>setIdentifier(e.target.value)}/></label>}
   <div className="fieldGroup"><label className="field">Password<input required minLength={tab==='register'?10:1} type="password" autoComplete={tab==='register'?'new-password':'current-password'} aria-describedby={tab==='register'?'password-hint':undefined} value={password} onChange={e=>setPassword(e.target.value)}/></label>{tab==='register'&&<p id="password-hint" className="fieldHint">At least 10 characters</p>}</div>
   {notice&&!usernameError&&errorLine}
   <Button type="submit" disabled={working} className="wide">{working?'Please wait…':tab==='register'?'Create account':'Sign in'}</Button>
  </form>
  {tab==='register'&&<p className="authNote">No email confirmation required during this testing phase. Use an email address you control so you can recover your account.</p>}
 </main></div>
}

export default function App(){
 const [session,setSession]=useState<Session|null>(null),[loading,setLoading]=useState(true),[profile,setProfile]=useState<Profile|null>(null)
 const [page,setPage]=useState<Page>('home'),[tableId,setTableId]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[busy,setBusy]=useState(false)
 const [joinCode,setJoinCode]=useState(getJoinCode())
 const [theme,setThemeState]=useState<Theme>(readTheme)
 const themeValue=useMemo(()=>({theme,setTheme:(t:Theme)=>{setThemeState(t);saveTheme(t);applyTheme(t)}}),[theme])
 const user=session?.user
 const reloadProfile=useCallback(async()=>{if(!user)return;const {data,error}=await supabase.from('profiles').select('*').eq('id',user.id).single();if(error)throw error;setProfile(data as Profile)},[user?.id])
 useEffect(()=>{let valid=true;void supabase.auth.getSession().then(({data})=>{if(valid){setSession(data.session);setLoading(false)}});const{subscription}=supabase.auth.onAuthStateChange((_event,s)=>{setSession(s);setLoading(false)}).data;return()=>{valid=false;subscription.unsubscribe()}},[])
 useEffect(()=>{if(user){void reloadProfile().catch(e=>setMessage(errorMessage(e))) }else setProfile(null)},[user?.id,reloadProfile])
 useEffect(()=>{if(!joinCode||!user)return;const c=joinCode;setJoinCode('');void (async()=>{try{setBusy(true);const id=await rpc<string>('join_table',{p_code:c});setTableId(id);history.replaceState(null,'',location.pathname)}catch(e){setMessage(errorMessage(e))}finally{setBusy(false)}})()},[user?.id,joinCode])
 useEffect(()=>{window.scrollTo(0,0)},[page,tableId])
 const action:Action=async fn=>{if(busy)return;setBusy(true);setMessage(null);try{await fn()}catch(e){setMessage(errorMessage(e))}finally{setBusy(false)}}
 // Screen transitions: opening a table moves forward, leaving it moves back, switching tabs crossfades (CSS decides how each theme animates).
 const screenKey=tableId?`table-${tableId}`:page,depth=tableId?2:1
 const nav=useRef({key:screenKey,depth,dir:'fade'})
 if(nav.current.key!==screenKey)nav.current={key:screenKey,depth,dir:depth>nav.current.depth?'forward':depth<nav.current.depth?'back':'fade'}
 const themed=(content:React.ReactNode)=><ThemeContext.Provider value={themeValue}>{content}</ThemeContext.Provider>
 if(!configured)return themed(<div className="setup"><Brand/><h1>Connect your backend</h1><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to a <code>.env</code> file, then restart Vite.</p><p className="muted">See README.md for the complete Supabase setup.</p></div>)
 if(loading)return themed(<div className="loading" role="status"><Brand/><p>Loading {APP_NAME}…</p></div>)
 if(!session)return themed(<AuthScreen joinCode={joinCode}/>)
 const initials=(profile?.username||'U').slice(0,2).toUpperCase()
 const go=(p:Page)=>{setTableId(null);setPage(p)}
 return themed(<div className="appShell">
  <header className="topbar"><div className="topbarInner">
   <button className="brandButton" aria-label={`${APP_NAME}, home`} onClick={()=>go('home')}><Brand/></button>
   <NavTabs className="headerNav" page={tableId?'home':page} go={go}/>
   <button className="avatar" aria-label="Your profile" title="Your profile" onClick={()=>go('profile')}><span style={theme==='blue'?{background:tint(user!.id,user!.id)}:undefined}>{initials}</span></button>
  </div></header>
  <main className="main withNav">
   <div key={screenKey} className={`screen enter-${nav.current.dir}`}>
   {tableId?<TableScreen key={tableId} tableId={tableId} me={user!.id} action={action} busy={busy} onLeave={()=>{setTableId(null);setPage('home')}}/>:
   page==='home'?<HomeScreen me={user!.id} profile={profile} openTable={setTableId} openRankings={()=>setPage('leaderboard')} action={action} busy={busy}/>:
   page==='leaderboard'?<LeaderboardScreen me={user!.id}/>:
   page==='groups'?<GroupsScreen me={user!.id} action={action} busy={busy}/>:
   <ProfileScreen me={user!.id} profile={profile} action={action} reload={reloadProfile}/>}
   </div>
  </main>
  <NavTabs className="bottomNav" page={tableId?'home':page} go={go}/>
  {message&&<div className="toast" role="alert">{message}<button aria-label="Dismiss message" onClick={()=>setMessage(null)}><X size={16}/></button></div>}
 </div>)
}

function HomeScreen({me,profile,openTable,openRankings,action,busy}:{me:string;profile:Profile|null;openTable:(id:string)=>void;openRankings:()=>void;action:Action;busy:boolean}){
 const[mode,setMode]=useState<Mode>('natural'),[expanded,setExpanded]=useState(false),[join,setJoin]=useState(''),[tables,setTables]=useState<TableRow[]>([]),[ratings,setRatings]=useState<Rating[]>([]),[groups,setGroups]=useState<Group[]>([]),[group,setGroup]=useState('')
 const [loaded,setLoaded]=useState(false),[front,setFront]=useState(0)
 const blue=useBlue(),[people,setPeople]=useState<Record<string,{id:string;name:string}[]>>({}),[modeSheet,setModeSheet]=useState(false)
 const load=useCallback(async()=>{const {data:members}=await supabase.from('table_members').select('table_id').eq('user_id',me).eq('is_active',true);const ids=(members||[]).map(m=>m.table_id);const [{data:tt},{data:rr},{data:gm}]=await Promise.all([
  ids.length?supabase.from('tables').select('*').in('id',ids).order('created_at',{ascending:false}):Promise.resolve({data:[]}),
  supabase.from('ratings').select('*').eq('user_id',me),supabase.from('group_members').select('group_id').eq('user_id',me)])
 setTables((tt||[]) as TableRow[]);setRatings((rr||[]) as Rating[]);setLoaded(true)
 const groupIds=(gm||[]).map(x=>x.group_id);if(groupIds.length){const{data}=await supabase.from('friend_groups').select('*').in('id',groupIds);setGroups((data||[]) as Group[])}else setGroups([])
 // The blue theme's table summary names the players ("With Masha and Grisha"), so it also loads who sits at each table.
 if(blue&&ids.length){
  const{data:seated}=await supabase.from('table_members').select('table_id,user_id').in('table_id',ids).eq('is_active',true).order('joined_at')
  const userIds=[...new Set((seated||[]).map(s=>s.user_id))]
  const{data:pp}=userIds.length?await supabase.from('profiles').select('id,username').in('id',userIds):{data:[]}
  const names=Object.fromEntries(((pp||[]) as {id:string;username:string}[]).map(p=>[p.id,p.username]))
  const byTable:Record<string,{id:string;name:string}[]>={};for(const s of seated||[])(byTable[s.table_id]||=[]).push({id:s.user_id,name:names[s.user_id]||'Player'})
  setPeople(byTable)
 }
 },[me,blue])
 useEffect(()=>{void load();const id=setInterval(()=>void load(),12000);return()=>clearInterval(id)},[load])
 const create=()=>void action(async()=>{const id=await rpc<string>('create_table',{p_mode:mode,p_group:group||null});openTable(id)})
 const joinRoom=()=>void action(async()=>{if(!join.trim())throw new Error('Enter a table code');const id=await rpc<string>('join_table',{p_code:join});openTable(id)})
 // Tables that need attention first (results, then playing, then lobby); the sort is stable, so newest stays first within a status.
 const sorted=useMemo(()=>[...tables].sort((a,b)=>STATUS_ORDER[a.status]-STATUS_ORDER[b.status]),[tables])
 const hand=sorted.length,idx=hand?front%hand:0,current=sorted[idx],next=hand>1?sorted[(idx+1)%hand]:undefined
 const picked=modeInfo(mode),played=ratings.some(r=>r.games>0)
 // New players see all four mode cards; everyone else gets the compact picker behind "Change".
 const showModes=expanded||(loaded&&hand===0)
 const modeGrid=useRef<HTMLDivElement>(null),changeButton=useRef<HTMLButtonElement>(null),returnFocus=useRef(false)
 useEffect(()=>{if(expanded)modeGrid.current?.querySelector<HTMLButtonElement>('.on')?.focus();else if(returnFocus.current){returnFocus.current=false;changeButton.current?.focus()}},[expanded])
 const pickMode=(m:Mode)=>{setMode(m);if(expanded){returnFocus.current=true;setExpanded(false)}}
 // Horizontal swipe on the hand of table cards; a swipe must not also count as a tap on the card underneath.
 const swipeStart=useRef<number|null>(null),swiped=useRef(false)
 // The release is read from window: a mouse (unlike touch) is not captured, so it may be released outside the hand.
 const startSwipe=(x:number)=>{
  swipeStart.current=x;swiped.current=false
  const stop=()=>{window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel)}
  const up=(e:PointerEvent)=>{stop();const start=swipeStart.current;swipeStart.current=null;if(start===null)return;const dx=e.clientX-start;swiped.current=Math.abs(dx)>40;if(swiped.current&&hand>1)setFront((idx+(dx<0?1:hand-1))%hand)}
  const cancel=()=>{stop();swipeStart.current=null}
  window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel)
 }
 const describe=(t:TableRow)=>`${modeInfo(t.mode).name}, table ${t.code}, ${STATUS_TEXT[t.status].toLowerCase()}`
 const lead=blue?sorted[0]:current
 const status=lead?lead.status==='results'?'Your table is waiting for your vote.':lead.status==='playing'?'Your game is still going.':'Your table is waiting for players.':!loaded?'':played?'No open tables right now. Start one, or join a friend\'s.':'No tables yet. Pick a game to start one, or join a friend\'s.'
 const withText=(t:TableRow)=>{const others=(people[t.id]||[]).filter(p=>p.id!==me).map(p=>p.name);return people[t.id]?others.length?`With ${listNames(others)}`:'Just you so far':STATUS_TEXT[t.status]}
 const groupField=groups.length>0&&<label className="field">Friend group (optional)<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">No group</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
 const joinSection=<section aria-labelledby="join-title">
  <h2 id="join-title" className="sectionTitle">Join a table</h2>
  <form onSubmit={e=>{e.preventDefault();joinRoom()}}>
   <label className="field" htmlFor="join-code">Table code</label>
   <div className="joinRow"><input id="join-code" className="codeInput" placeholder="8 characters" maxLength={8} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" aria-describedby="join-hint" value={join} onChange={e=>setJoin(e.target.value.toUpperCase())}/><Button type="submit" kind="outline" disabled={busy||!join.trim()}>Join</Button></div>
   <p id="join-hint" className="fieldHint">Type the 8-character code from the host, or scan the QR code on their phone.</p>
  </form>
 </section>
 const greetingBlock=<section className="greeting"><h1>{greeting()}, {profile?.username||'friend'}</h1>{status&&<p>{status}</p>}</section>
 if(blue)return <div className="stack home pageEntry">
  {greetingBlock}
  {lead&&<section className="stack sm" aria-labelledby="tables-title">
   <div className="sectionHeading"><h2 id="tables-title" className="listLabel">Your tables</h2><button className="iconButton" aria-label="Refresh tables" title="Refresh tables" onClick={()=>void load()}><RefreshCw size={18}/></button></div>
   <div className="summaryCard">
    <div className="summaryTop"><span className={`statusChip status-${lead.status}`}>{STATUS_TEXT[lead.status]}</span>{people[lead.id]&&<span className="avatarStack" aria-hidden="true">{people[lead.id].slice(0,4).map(p=><Avatar key={p.id} id={p.id} name={p.name} me={me} size="sm"/>)}</span>}</div>
    <div><h3 className="summaryTitle">{modeInfo(lead.mode).name}</h3><p className="summaryMeta">Table <span className="mono">{lead.code}</span> · {withText(lead)}</p></div>
    <Button className="wide" onClick={()=>openTable(lead.id)}>Return to table</Button>
   </div>
   {sorted.length>1&&<div><h3 className="listLabel">Other tables</h3><ul className="rowList">{sorted.slice(1).map(t=><li key={t.id}><button className="listRow" onClick={()=>openTable(t.id)}><span className="rowText"><b>{modeInfo(t.mode).name}</b><small>Table <span className="mono">{t.code}</span> · {STATUS_TEXT[t.status]}</small></span><span className="chevron" aria-hidden="true">›</span></button></li>)}</ul></div>}
  </section>}
  <section className="stack sm" aria-labelledby="create-title">
   <h2 id="create-title">Start a table</h2>
   <button className="modeButton" aria-haspopup="dialog" aria-label={`Game mode: ${picked.name}. Change`} onClick={()=>setModeSheet(true)}><span className="modeButtonMain"><SuitBox mode={mode}/><span className="rowText"><b>{picked.name}</b><small>{picked.detail} · <span className="nowrap">{picked.min}–{picked.max} players</span></small></span></span><span className="modeButtonAction" aria-hidden="true">Change</span></button>
   {groupField}
   <Button onClick={create} disabled={busy} className="wide">Create table</Button>
  </section>
  {joinSection}
  <section aria-labelledby="ratings-title">
   <div className="sectionHeading"><h2 id="ratings-title">Your ratings</h2><button className="linkButton plain" onClick={openRankings}>See rankings <span aria-hidden="true">›</span></button></div>
   <ul className="rowList">{MODES.map(m=>{const r=ratings.find(r=>r.mode===m.id),games=r?.games||0;return <li key={m.id} className="rateRow"><span className={`rowSuit ${MODE_CARD[m.id].red?'red':''}`} aria-hidden="true">{MODE_CARD[m.id].suit}</span><span className="rowText"><b>{m.name}</b><small>{games?`${games} ${games===1?'game':'games'}`:'No games yet'}</small></span><strong className={`rowValue ${games?'':'quiet'}`}>{formatRating(r?.rating??1200)}</strong></li>})}</ul>
  </section>
  <Sheet open={modeSheet} title="Game mode" onClose={()=>setModeSheet(false)}>
   <div className="sheetOptions" role="group" aria-label="Game mode">{MODES.map(m=><button key={m.id} aria-pressed={mode===m.id} className={`sheetOption ${mode===m.id?'on':''}`} onClick={()=>{setMode(m.id);setTimeout(()=>setModeSheet(false),200)}}><SuitBox mode={m.id}/><span className="rowText"><b>{m.name}{m.id==='natural'&&<span className="optionNote"> · default</span>}</b><small>{m.detail} · {m.min}–{m.max} players</small></span><span className="radioDot" aria-hidden="true"/></button>)}</div>
  </Sheet>
 </div>
 return <div className="stack home pageEntry">
  {greetingBlock}
  <div className={`homeGrid ${current?'withHand':''}`}>
   {current&&<section aria-labelledby="tables-title">
    <div className="sectionHeading"><h2 id="tables-title">Your tables</h2><span className="handMeta">{hand>1&&<span>Swipe · {idx+1} of {hand}</span>}<button className="iconButton" aria-label="Refresh tables" title="Refresh tables" onClick={()=>void load()}><RefreshCw size={18}/></button></span></div>
    <div className="hand" onPointerDown={e=>startSwipe(e.clientX)} onClickCapture={e=>{if(swiped.current){swiped.current=false;e.preventDefault();e.stopPropagation()}}}>
     {next&&<button className="tableCard back" aria-label={`Show ${describe(next)}`} onClick={()=>setFront((idx+1)%hand)}><CornerIndex mode={next.mode}/><span className="tableName">{modeInfo(next.mode).name}</span><span>{next.code}</span><span>{STATUS_TEXT[next.status]}</span></button>}
     <div className="tableCard front" key={current.id}>
      <CornerIndex mode={current.mode}/><CornerIndex mode={current.mode} flip/>
      <div className="tableCardBody"><span className={`tableStatus status-${current.status}`}>{STATUS_TEXT[current.status]}</span><h3>{modeInfo(current.mode).name}</h3><span className="tableCode">Table {current.code}</span></div>
      <Button onClick={()=>openTable(current.id)}>Return to table</Button>
     </div>
    </div>
    {hand>1&&<div className="handDots">{sorted.map((t,i)=><button key={t.id} className={i===idx?'on':''} aria-label={`Show ${describe(t)}`} aria-current={i===idx||undefined} onClick={()=>setFront(i)}/>)}</div>}
   </section>}
   <div className="homeActions">
    <section aria-labelledby="create-title">
     <h2 id="create-title" className="sectionTitle">Start a table</h2>
     <div className={`startPanel ${showModes?'open':''}`}>
      {showModes?<div className="modeGrid" role="group" aria-label="Game mode" ref={modeGrid}>{MODES.map(m=><button key={m.id} aria-pressed={mode===m.id} className={`modeCard ${mode===m.id?'on':''} ${MODE_CARD[m.id].red?'red':''}`} onClick={()=>pickMode(m.id)}><CornerIndex mode={m.id}/>{mode===m.id&&<span className="chosen" aria-hidden="true">✓ Selected</span>}<span className="modeSuit" aria-hidden="true">{MODE_CARD[m.id].suit}</span><span className="modeName">{m.name}</span><span className="modeDetail">{m.detail}<br/><span className="nowrap">{m.min}–{m.max} players</span></span></button>)}</div>
      :<div className="modeSummary"><MiniModeCard mode={mode}/><div className="modeText"><b>{picked.name}</b><small>{picked.detail} · <span className="nowrap">{picked.min}–{picked.max} players</span></small></div><button ref={changeButton} className="linkButton" aria-label={`Change game mode, currently ${picked.name}`} onClick={()=>setExpanded(true)}>Change</button></div>}
      {groupField}
      <Button onClick={create} disabled={busy} className="wide">Create {picked.name} table</Button>
     </div>
    </section>
    {joinSection}
   </div>
  </div>
  {played?<section aria-labelledby="ratings-title">
   <div className="sectionHeading"><h2 id="ratings-title">Your ratings</h2><button className="linkButton" onClick={openRankings}>See rankings</button></div>
   <ul className="rateList">{MODES.map(m=>{const r=ratings.find(r=>r.mode===m.id),games=r?.games||0;return <li key={m.id} className={`rateItem ${games?'':'unplayed'} ${MODE_CARD[m.id].red?'red':''}`}><span className="rateName"><span className="rateNameSuit" aria-hidden="true">{MODE_CARD[m.id].suit}</span>{m.name}</span><span className="rateCard"><span className="rateSuit" aria-hidden="true">{MODE_CARD[m.id].suit}</span><b className="rateValue">{formatRating(r?.rating??1200)}</b><small>{games} {games===1?'game':'games'}</small></span></li>})}</ul>
  </section>:loaded&&<p className="startsAt"><span>Everyone starts at 1,200 in each mode.</span><button className="linkButton" onClick={openRankings}>Rankings</button></p>}
 </div>
}

function TableScreen({tableId,me,action,busy,onLeave}:{tableId:string;me:string;action:Action;busy:boolean;onLeave:()=>void}){
 const [table,setTable]=useState<TableRow|null>(null),[members,setMembers]=useState<Member[]>([]),[profiles,setProfiles]=useState<Record<string,Profile>>({}),[players,setPlayers]=useState<string[]>([]),[games,setGames]=useState<Game[]>([]),[totals,setTotals]=useState<VoteTotal[]>([]),[historyGames,setHistoryGames]=useState<Game[]>([]),[cases,setCases]=useState<{id:string;game_id:string;state:string;created_at:string}[]>([]),[yesCounts,setYesCounts]=useState<Record<string,number>>({}),[now,setNow]=useState(Date.now()),[showQR,setShowQR]=useState(false),[mySelections,setMySelections]=useState<Record<string,string>>({}),[showHistory,setShowHistory]=useState(false),[ballots,setBallots]=useState<Record<string,{voter_id:string;nominee_id:string}[]>>({})
 const [displayNow, setDisplayNow] = useState(Date.now())
 const blue=useBlue(),[shareNote,setShareNote]=useState('')

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayNow(Date.now())
    }, 250)

    return () => window.clearInterval(timer)
  }, [])
 const load=useCallback(async()=>{
  const{data:tt,error:te}=await supabase.from('tables').select('*').eq('id',tableId).single();if(te)throw te;const t=tt as TableRow;setTable(t)
  const[{data:mm},{data:allR}]=await Promise.all([
   supabase.from('table_members').select('*').eq('table_id',tableId).eq('is_active',true).order('joined_at'),
   supabase.from('rounds').select('id').eq('table_id',tableId).order('started_at',{ascending:false}).limit(12)
  ]);setMembers((mm||[]) as Member[])
  const rids=(allR||[]).map(r=>r.id)
  const [{data:rp},{data:gg},{data:historic}]=await Promise.all([
    t.current_round_id?supabase.from('round_players').select('user_id').eq('round_id',t.current_round_id):Promise.resolve({data:[]}),
    t.current_round_id?supabase.from('round_games').select('*').eq('round_id',t.current_round_id).order('slot'):Promise.resolve({data:[]}),
    rids.length?supabase.from('round_games').select('*').in('round_id',rids).order('finalized_at',{ascending:false}).limit(24):Promise.resolve({data:[]})
  ]);
  setPlayers((rp||[]).map(x=>x.user_id));setGames((gg||[]) as Game[]);setHistoryGames((historic||[]) as Game[])
  const allIds=[...(mm||[]).map(m=>m.user_id),...(rp||[]).map(p=>p.user_id),...(historic||[]).flatMap(g=>g.loser_ids)];
  if(allIds.length){const{data:people}=await supabase.from('profiles').select('*').in('id',[...new Set(allIds)]);setProfiles(Object.fromEntries(((people||[]) as Profile[]).map(p=>[p.id,p])))}
  const gameIds=(gg||[]).map(g=>g.id);if(gameIds.length){const{data:voteData}=await supabase.from('vote_totals').select('*').in('game_id',gameIds);setTotals((voteData||[]) as VoteTotal[])}else setTotals([])
  const histIds=(historic||[]).map(g=>g.id);if(histIds.length){
   const {data:vv}=await supabase.from('game_votes').select('game_id,voter_id,nominee_id').in('game_id',histIds);
   const votesByGame:Record<string,{voter_id:string;nominee_id:string}[]>={};for(const v of vv||[])(votesByGame[v.game_id] ||= []).push({voter_id:v.voter_id,nominee_id:v.nominee_id});setBallots(votesByGame);const{data:cc}=await supabase.from('reversal_cases').select('*').in('game_id',histIds);setCases((cc||[]) as typeof cases);const cs=(cc||[]).filter(c=>c.state==='open').map(c=>c.id);if(cs.length){const{data:vv}=await supabase.from('reversal_votes').select('case_id,approve').in('case_id',cs);const counts:Record<string,number>={};for(const v of vv||[])if(v.approve)counts[v.case_id]=(counts[v.case_id]||0)+1;setYesCounts(counts)}else setYesCounts({})}else setCases([])
 },[tableId])
 useEffect(()=>{void load().catch(console.error);const timer=setInterval(()=>{setNow(Date.now());void load().catch(console.error)},4500);
  const channel=supabase.channel(`table-${tableId}`)
   .on('postgres_changes',{event:'*',schema:'public',table:'tables',filter:`id=eq.${tableId}`},()=>void load())
   .on('postgres_changes',{event:'*',schema:'public',table:'table_members',filter:`table_id=eq.${tableId}`},()=>void load())
   .on('postgres_changes',{event:'*',schema:'public',table:'round_games'},()=>void load())
   .on('postgres_changes',{event:'*',schema:'public',table:'vote_totals'},()=>void load())
   .on('postgres_changes',{event:'*',schema:'public',table:'reversal_cases'},()=>void load()).subscribe();
  const visibility=()=>{if(document.visibilityState==='visible')void load()};document.addEventListener('visibilitychange',visibility)
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visibility);void supabase.removeChannel(channel)}
 },[load,tableId])
 const activeGame=games.find(g=>!['confirmed','tied','unresolved','void'].includes(g.state))
 const pendingBefore=activeGame&&games.some(g=>g.slot<activeGame.slot&&!['confirmed','tied','unresolved','void'].includes(g.state))
 useEffect(()=>{if(!activeGame||!['voting','tie_offer'].includes(activeGame.state)||!activeGame.deadline)return;
  if(new Date(activeGame.deadline).getTime()<=now+1500)void rpc('advance_expired',{p_game:activeGame.id}).then(load).catch(console.error)
 },[activeGame?.id,activeGame?.deadline,activeGame?.state,now,load])
 const name=(id:string)=>profiles[id]?.username||`Player ${id.slice(0,4)}`
 const invite=table?`${location.origin}${location.pathname}?join=${table.code}`:''
 const share=async()=>{if(navigator.share){try{await navigator.share({title:`Join my table on ${APP_NAME}`,text:`Join my Durak table on ${APP_NAME} with code ${table?.code}.`,url:invite});return}catch{/* copy fallback */}}
  try{await navigator.clipboard.writeText(invite);setShareNote('Link copied')}catch{setShareNote('Could not copy. Share the code instead.')}}
 const play=()=>void action(async()=>{await rpc('start_round',{p_table:tableId});await load()})
 const finishPlay=()=>void action(async()=>{await rpc('begin_results',{p_table:tableId});await load()})
 const cast=(game:string,nominee:string)=>void action(async()=>{await rpc('cast_vote',{p_game:game,p_nominee:nominee});setMySelections(s=>({...s,[game]:nominee}));await load()})
 const respond=(game:string,accept:boolean)=>void action(async()=>{await rpc('respond_to_tie',{p_game:game,p_accept:accept});await load()})
 const leave=()=>void action(async()=>{await rpc('leave_table',{p_table:tableId});onLeave()})
 const promote=(id:string)=>void action(async()=>{await rpc('transfer_host',{p_table:tableId,p_new_host:id});await load()})
 const restart=(id:string)=>void action(async()=>{await rpc('restart_unresolved',{p_game:id});await load()})
 const openCorrection=(id:string)=>void action(async()=>{const cid=await rpc<string>('request_reversal',{p_game:id});await rpc('vote_reversal',{p_case:cid,p_approve:true});await load()})
 const correctionVote=(cid:string,approve:boolean)=>void action(async()=>{await rpc('vote_reversal',{p_case:cid,p_approve:approve});await load()})
 const info=table?modeInfo(table.mode):MODES[0]
 if(!table)return <div className="loading">Loading table…</div>
 const seats=table.status==='lobby'?Math.max(0,info.min-members.length):0,card=MODE_CARD[table.mode]
 const secondsLeft=activeGame?.deadline?Math.max(0,Math.ceil((new Date(activeGame.deadline).getTime()-displayNow)/1000)):30
 const tiedNames=activeGame?activeGame.loser_ids.map(name).join(' and '):''
 const nominees=activeGame?players.filter(id=>!activeGame.allowed_nominees||activeGame.allowed_nominees.includes(id)):[]
 const refresh=<button className="iconButton" aria-label="Refresh table" title="Refresh table" onClick={()=>void load()}><RefreshCw size={18}/></button>
 return <div className="stack lobby pageEntry">
  {blue?<>
   <button className="backLink" onClick={onLeave}><span aria-hidden="true">‹</span> Home</button>
   <div className="summaryCard">
    <span className={`statusChip status-${table.status}`}>{STATUS_TEXT[table.status]}</span>
    <div><h1 className="summaryTitle">{info.name}</h1><p className="summaryMeta">Table <span className="mono">{table.code}</span> · {info.detail.split(' · ').slice(0,2).join(' · ')}</p></div>
    {table.status!=='results'&&<Button kind="outline" className="wide" onClick={()=>setShowQR(true)}>Invite / QR</Button>}
   </div>
   <Sheet open={showQR&&table.status!=='results'} title="Invite friends" onClose={()=>{setShowQR(false);setShareNote('')}}>
    <div className="inviteSheet"><div className="qrInner"><QRCodeSVG value={invite} size={184} includeMargin/></div><div className="codeLarge">{table.code}</div><p>Friends can scan this, type the code, or open the link.</p><Button className="wide" onClick={()=>void share()}>{shareNote||'Share invite link'}</Button></div>
   </Sheet>
  </>:<>
   <div className="lobbyHero"><span className={`heroCard ${card.red?'red':''}`} aria-hidden="true"><span className="heroIndex">{card.abbr}<br/>{card.suit}</span>{card.suit}</span><div><h1>{info.name}</h1><p>Table {table.code} · {STATUS_TEXT[table.status]}</p><p className="heroDetail">{info.detail} · <span className="nowrap">{info.min}–{info.max} players</span></p></div></div>
   {table.status!=='results'&&<Button kind="outline" className="wide inviteButton" onClick={()=>setShowQR(s=>!s)}>{showQR?'Hide invite':'Invite / QR'}</Button>}
   {showQR&&table.status!=='results'&&<section className="card qrCard" aria-label="Invite"><div className="qrInner"><QRCodeSVG value={invite} size={184} includeMargin/></div><p>Scan to join this table, or type the code</p><div className="codeLarge">{table.code}</div><Button kind="secondary" onClick={()=>void share()}><Copy size={15}/> {shareNote||'Share link'}</Button></section>}
  </>}
  {table.status!=='results'&&<section aria-labelledby="players-title">
   {blue?<div className="sectionHeading"><h2 id="players-title">Players</h2><span className="countText">{members.length} of {info.max}{refresh}</span></div>
   :<div className="sectionHeading"><h2 id="players-title">Players · {members.length} of {info.max}</h2>{refresh}</div>}
   {blue?<ul className="rowList">
    {members.map(m=>{const host=m.user_id===table.host_id,mine=m.user_id===me,who=name(m.user_id);return <li key={m.user_id} className="playerRow">
     <Avatar id={m.user_id} name={who} me={me} size="md"/>
     <span className="rowText"><b>{who}{mine&&<span className="youChip">you</span>}</b>{host&&<small><Crown className="hostIcon" size={13} aria-hidden="true"/> Host</small>}</span>
     {table.status==='lobby'&&table.host_id===me&&!mine&&<button className="linkButton" disabled={busy} aria-label={`Make ${who} the host`} onClick={()=>promote(m.user_id)}>Make host</button>}
     <span className="rowRep" title="5-star reputation baseline">★ 5.0</span>
    </li>})}
    {seats>0&&<li><button className="playerRow waiting" aria-label="Waiting for someone to join. Show the invite" onClick={()=>setShowQR(true)}><span className="tintAvatar md empty" aria-hidden="true"/><span>Waiting for someone to join…</span></button></li>}
   </ul>:<ul className="seatGrid">
    {members.map(m=>{const host=m.user_id===table.host_id,mine=m.user_id===me,who=name(m.user_id);return <li key={m.user_id} className={`seat ${mine?'mine':''}`}>
     {host&&<Crown className="seatCrown" size={16} aria-hidden="true"/>}
     {mine&&<span className="seatYou">you</span>}
     <span className="seatInitials" aria-hidden="true">{who.slice(0,2).toUpperCase()}</span>
     <b className="seatName" title={who}>{who}</b>
     <span className="seatMeta"><span title="5-star reputation baseline">★ 5.0</span>{host&&' · host'}</span>
     {table.status==='lobby'&&table.host_id===me&&!mine&&<button className="seatAction" disabled={busy} aria-label={`Make ${who} the host`} onClick={()=>promote(m.user_id)}>Make host</button>}
    </li>})}
    {Array.from({length:seats},(_,i)=><li key={`empty-${i}`} className="seatSlot"><button className="seat empty" aria-label="Empty seat, show the invite QR code" onClick={()=>setShowQR(true)}>Empty seat</button></li>)}
   </ul>}
   {table.status==='lobby'&&<div className="lobbyFooter"><p>{members.length<info.min?`Need ${info.min-members.length} more player${info.min-members.length===1?'':'s'} to start`:'Everyone ready? Deal the cards.'}</p><Button onClick={play} disabled={busy||members.length<info.min} className="wide">Start new game</Button><button className="leaveLink" onClick={leave} disabled={busy}>Leave table <LogOut size={14}/></button></div>}
   {table.status==='playing'&&<div className="lobbyFooter"><div className="hint"><ShieldCheck size={18}/> All players are locked into this round. You can close your phone while playing.</div><Button onClick={finishPlay} disabled={busy} className="wide">Cards finished — record results <ArrowRight size={17}/></Button></div>}
  </section>}
  {table.status==='results'&&<section className="voting" aria-labelledby="vote-title">
   <div className="voteHead">
    <div>{games.length>1&&activeGame&&<p className="voteGame">Game {activeGame.slot} of {games.length}</p>}<h2 id="vote-title">{!activeGame?'Results':pendingBefore?'One game at a time':activeGame.state==='tie_offer'?'It\'s a tie':'Who lost?'}</h2></div>
    {activeGame&&!pendingBefore&&(activeGame.deadline?<div className={`voteTimer ${secondsLeft<=10?'low':''}`} role="timer" aria-label={`${secondsLeft} seconds left`}><b>{secondsLeft}</b><span>sec</span></div>:<div className="voteTimer idle" aria-label="The 30-second timer starts with the first vote"><b>30</b><span>sec</span></div>)}
   </div>
   {activeGame&&!pendingBefore?activeGame.state==='tie_offer'?<>
    {blue?<ul className="rowList">{activeGame.loser_ids.map(id=><li key={id} className="playerRow"><Avatar id={id} name={name(id)} me={me} size="md"/><span className="rowText"><b>{name(id)}{id===me&&<span className="youChip">you</span>}</b><small>Tied</small></span></li>)}</ul>
    :<ul className="voteGrid tied">{activeGame.loser_ids.map(id=><li key={id} className="seat"><span className="seatInitials" aria-hidden="true">{name(id).slice(0,2).toUpperCase()}</span><b className="seatName">{name(id)}</b><span className="seatMeta">{id===me?'you · tied':'tied'}</span></li>)}</ul>}
    <p className="voteRules">{tiedNames} have the same number of votes. If everyone tied accepts, they share the loss and each loses less rating. If anyone declines, they vote again between themselves.</p>
    {activeGame.loser_ids.includes(me)?<div className="voteActions"><Button className="wide" onClick={()=>respond(activeGame.id,true)} disabled={busy}>Accept shared loss</Button><Button kind="outline" className="wide" onClick={()=>respond(activeGame.id,false)} disabled={busy}>Decline, vote again</Button></div>:<p className="voteNote">Waiting for {tiedNames} to decide.</p>}
   </>:<>
    <p className="voteRules">{activeGame.allowed_nominees?`Vote again between ${activeGame.allowed_nominees.map(name).join(' and ')}.`:'Tap the player who was left holding cards.'} A clear majority decides straight away; otherwise the most votes after 30 seconds wins, with at least 2 votes.</p>
    {blue?<ul className="rowList voteRows">{nominees.map(id=>{const votes=totals.find(v=>v.game_id===activeGame.id&&v.nominee_id===id)?.votes||0,picked=mySelections[activeGame.id]===id,count=`${votes} ${votes===1?'vote':'votes'}`
     return <li key={id}><button className={`playerRow voteRow ${picked?'picked':''}`} aria-pressed={picked} aria-label={`${name(id)}${id===me?' (you)':''}, ${count}`} disabled={busy} onClick={()=>cast(activeGame.id,id)}>
      <Avatar id={id} name={name(id)} me={me} size="md"/>
      <span className="rowText" aria-hidden="true"><b>{name(id)}{id===me&&<span className="youChip">you</span>}</b><small>{count}</small></span>
      {picked&&<span className="voteCheck" aria-hidden="true">✓</span>}
     </button></li>})}</ul>
    :<ul className="voteGrid">{nominees.map(id=>{const votes=totals.find(v=>v.game_id===activeGame.id&&v.nominee_id===id)?.votes||0,picked=mySelections[activeGame.id]===id,count=`${votes} ${votes===1?'vote':'votes'}`
     return <li key={id}><button className={`seat voteCard ${picked?'picked':''}`} aria-pressed={picked} aria-label={`${name(id)}${id===me?' (you)':''}, ${count}`} disabled={busy} onClick={()=>cast(activeGame.id,id)}>
      {picked&&<span className="voteCheck" aria-hidden="true">✓</span>}
      <span className="seatInitials" aria-hidden="true">{name(id).slice(0,2).toUpperCase()}</span>
      <b className="seatName">{name(id)}</b>
      <span className={`votePips ${card.red?'red':''}`} aria-hidden="true">{card.suit.repeat(Math.min(votes,6))}</span>
      <span className="seatMeta" aria-hidden="true">{id===me?'you · ':''}{count}</span>
     </button></li>})}</ul>}
    <p className="voteNote">{activeGame.state==='awaiting'?'The timer starts with the first vote.':'Totals are public; who voted for whom stays hidden until the result is final. You can change your vote.'}</p>
   </>:activeGame?<p className="voteRules">Game {activeGame.slot} opens once the earlier game has a result.</p>:null}
   {games.some(g=>FINAL.includes(g.state))&&<ol className="roundResults" aria-label="Results so far">{games.filter(g=>FINAL.includes(g.state)).map(g=><li key={g.id}><ResultRow game={g} name={name} restart={()=>restart(g.id)} busy={busy}/></li>)}</ol>}
   {games.some(g=>g.state==='unresolved')&&<div className="hint"><Clock3 size={17}/> Games without a result can be voted on again before the next round.</div>}
  </section>}
  {table.status==='lobby'&&historyGames.length>0&&<section className="card historyCard">
   <h2><button className="historyToggle" aria-expanded={showHistory} aria-controls="history-list" onClick={()=>setShowHistory(s=>!s)}>Recent results <ChevronDown size={18} className={showHistory?'flip':''} aria-hidden="true"/></button></h2>
   {showHistory&&<ul className="historyList" id="history-list">{historyGames.filter(g=>FINAL.includes(g.state)).slice(0,12).map(g=><li key={g.id} className="historyItem">
    <ResultRow game={g} name={name} restart={()=>restart(g.id)} busy={busy}/>
    {ballots[g.id]?.length>0&&<p className="ballots"><span className="ballotsLabel">Votes</span>{ballots[g.id].map(v=><span key={v.voter_id}>{name(v.voter_id)} → {name(v.nominee_id)}</span>)}</p>}
    {['confirmed','tied'].includes(g.state)&&g.finalized_at&&Date.now()-new Date(g.finalized_at).getTime()<86400000&&<button className="linkButton" onClick={()=>openCorrection(g.id)}>Request correction</button>}
    {cases.filter(c=>c.game_id===g.id&&c.state==='open').map(c=><div className="correction" key={c.id}><span>Correction vote · {yesCounts[c.id]||0} {yesCounts[c.id]===1?'approval':'approvals'}</span><Button kind="secondary" onClick={()=>correctionVote(c.id,true)}>Approve</Button><Button kind="ghost" onClick={()=>correctionVote(c.id,false)}>Reject</Button></div>)}
   </li>)}</ul>}
  </section>}
 </div>
}
const FINAL:Game['state'][]=['confirmed','tied','unresolved','void']
function ResultRow({game,name,restart,busy}:{game:Game;name:(id:string)=>string;restart:()=>void;busy:boolean}){
 return <div className={`resultRow ${game.state}`}><span className="resultGame">Game {game.slot}</span><span className="resultText">{game.state==='confirmed'?<><b>{name(game.loser_ids[0])}</b> lost</>:game.state==='tied'?<>Shared loss: <b>{game.loser_ids.map(name).join(', ')}</b></>:game.state==='unresolved'?'No result':game.state==='void'?'Reversed after a correction vote':'Waiting for a result'}</span>{game.state==='unresolved'&&<button className="linkButton" disabled={busy} onClick={restart}>Vote again</button>}</div>
}

// Game-mode switch shared by Rankings and Groups: one chip per mode, with its suit.
function ModeChips({mode,setMode}:{mode:Mode;setMode:(m:Mode)=>void}){
 return <div className="modeChips" role="group" aria-label="Game mode">{MODES.map(m=><button key={m.id} aria-pressed={mode===m.id} className={`${mode===m.id?'on':''} ${MODE_CARD[m.id].red?'red':''}`} onClick={()=>setMode(m.id)}><span className="chipSuit" aria-hidden="true">{MODE_CARD[m.id].suit}</span>{m.name}</button>)}</div>
}
// Top three as player cards with the rank as the corner index; everyone else as ledger rows.
function Standings({ratings,names,me,mode}:{ratings:Rating[];names:Record<string,string>;me:string;mode:Mode}){
 const card=MODE_CARD[mode],who=(r:Rating)=>names[r.user_id]||'Player'
 // Blue theme: one white list card, no podium.
 if(useBlue())return <ol className="listCard">{ratings.map((r,i)=><li key={r.user_id} className={`rankRow ${r.user_id===me?'mine':''}`}>
  <span className="position" aria-hidden="true">{i+1}</span>
  <Avatar id={r.user_id} name={who(r)} me={me}/>
  <span className="rowText"><b>{who(r)}{r.user_id===me&&' (you)'}</b><small>{r.games} games · {r.losses} losses</small></span>
  <span className="rowValue">{formatRating(r.rating)}</span>
 </li>)}</ol>
 return <>
  <ol className="podium">{ratings.slice(0,3).map((r,i)=><li key={r.user_id} className={`seat podiumCard ${r.user_id===me?'mine':''}`}>
   <span className={`cornerIndex ${card.red?'red':''}`} aria-hidden="true">{i+1}<br/>{card.suit}</span>
   {r.user_id===me&&<span className="seatYou">you</span>}
   <span className="seatInitials" aria-hidden="true">{who(r).slice(0,2).toUpperCase()}</span>
   <b className="seatName" title={who(r)}>{who(r)}</b>
   <span className="podiumRating">{formatRating(r.rating)}</span>
   <span className="seatMeta">{r.games} {r.games===1?'game':'games'}</span>
  </li>)}</ol>
  {ratings.length>3&&<ol className="rankList" start={4}>{ratings.slice(3).map((r,i)=><li key={r.user_id} className={`rankRow ${r.user_id===me?'mine':''}`}>
   <span className="position" aria-hidden="true">{i+4}</span>
   <span className="playerAvatar" aria-hidden="true">{who(r).slice(0,2).toUpperCase()}</span>
   <span className="rankName"><strong>{who(r)}{r.user_id===me&&<span className="youTag">you</span>}</strong><small>{r.games} games · {r.losses} losses</small></span>
   <span className="rankScore">{formatRating(r.rating)}</span>
  </li>)}</ol>}
 </>
}

function LeaderboardScreen({me}:{me:string}){
 const [mode,setMode]=useState<Mode>('natural'),[ratings,setRatings]=useState<Rating[]>([]),[users,setUsers]=useState<Record<string,Profile>>({}),[loading,setLoading]=useState(true)
 useEffect(()=>{let live=true;setLoading(true);void (async()=>{const{data,error}=await supabase.from('ratings').select('*').eq('mode',mode).order('rating',{ascending:false}).limit(100);if(error)throw error;const scores=(data||[]) as Rating[];const{data:p}=scores.length?await supabase.from('profiles').select('*').in('id',scores.map(r=>r.user_id)):{data:[]};if(live){setRatings(scores);setUsers(Object.fromEntries(((p||[]) as Profile[]).map(x=>[x.id,x])));setLoading(false)}})().catch(console.error);return()=>{live=false}},[mode])
 const names=useMemo(()=>Object.fromEntries(Object.values(users).map(u=>[u.id,u.username])),[users])
 return <div className="stack page pageEntry">
  <header className="pageHead"><h1>Rankings</h1><p>Everyone starts at 1,200, and each game mode has its own standings.</p></header>
  <ModeChips mode={mode} setMode={setMode}/>
  <section aria-label={`${modeInfo(mode).name} standings`}>{loading?<p className="emptyNote">Loading…</p>:ratings.length===0?<p className="emptyNote">No ranked {modeInfo(mode).name} games yet. Start a table and play the first one.</p>:<Standings ratings={ratings} names={names} me={me} mode={mode}/>}</section>
 </div>
}

function GroupsScreen({me,action,busy}:{me:string;action:Action;busy:boolean}){
 const [groupName,setGroupName]=useState(''),[joinCode,setJoinCode]=useState(''),[groups,setGroups]=useState<Group[]>([]),[selected,setSelected]=useState<string>(''),[memberIds,setMemberIds]=useState<string[]>([]),[mode,setMode]=useState<Mode>('natural'),[ranked,setRanked]=useState<{profile:Profile;rating:Rating}[]>([])
 const load=useCallback(async()=>{const{data:mm}=await supabase.from('group_members').select('group_id').eq('user_id',me);const ids=(mm||[]).map(x=>x.group_id);if(!ids.length){setGroups([]);return}const{data:gg}=await supabase.from('friend_groups').select('*').in('id',ids);setGroups((gg||[]) as Group[]);setSelected(s=>s||ids[0])},[me])
 useEffect(()=>{void load()},[load])
 useEffect(()=>{if(!selected)return;void (async()=>{const{data:gm}=await supabase.from('group_members').select('user_id').eq('group_id',selected);const ids=(gm||[]).map(x=>x.user_id);setMemberIds(ids);if(!ids.length){setRanked([]);return}const[{data:rr},{data:pp}]=await Promise.all([supabase.from('ratings').select('*').in('user_id',ids).eq('mode',mode).order('rating',{ascending:false}),supabase.from('profiles').select('*').in('id',ids)]);const pm=Object.fromEntries(((pp||[]) as Profile[]).map(x=>[x.id,x]));setRanked(((rr||[]) as Rating[]).map(r=>({profile:pm[r.user_id],rating:r})).filter(x=>x.profile))})()},[selected,mode])
 const create=()=>void action(async()=>{const id=await rpc<string>('create_friend_group',{p_name:groupName});setSelected(id);setGroupName('');await load()})
 const join=()=>void action(async()=>{const id=await rpc<string>('join_friend_group',{p_code:joinCode});setSelected(id);setJoinCode('');await load()})
 const current=groups.find(g=>g.id===selected),names=Object.fromEntries(ranked.map(x=>[x.profile.id,x.profile.username]))
 // Blue theme lists every group with its members ("You, Masha and Grisha"), so it loads member names for all of them.
 const blue=useBlue(),[groupPeople,setGroupPeople]=useState<Record<string,{id:string;name:string}[]>>({})
 useEffect(()=>{if(!blue||!groups.length)return;let live=true;void (async()=>{
  const{data:gm}=await supabase.from('group_members').select('group_id,user_id').in('group_id',groups.map(g=>g.id))
  const userIds=[...new Set((gm||[]).map(x=>x.user_id))]
  const{data:pp}=userIds.length?await supabase.from('profiles').select('id,username').in('id',userIds):{data:[]}
  const nm=Object.fromEntries(((pp||[]) as {id:string;username:string}[]).map(p=>[p.id,p.username]))
  const byGroup:Record<string,{id:string;name:string}[]>={};for(const x of gm||[])(byGroup[x.group_id]||=[]).push({id:x.user_id,name:nm[x.user_id]||'Player'})
  if(live)setGroupPeople(byGroup)
 })().catch(console.error);return()=>{live=false}},[blue,groups])
 const memberLine=(id:string)=>{const list=groupPeople[id];if(!list)return '';const others=list.filter(p=>p.id!==me).map(p=>p.name);return listNames(list.some(p=>p.id===me)?['You',...others]:others)}
 return <div className="stack page pageEntry">
  <header className="pageHead"><h1>{blue?'Groups':'Friend groups'}</h1><p>A private leaderboard for the people you play with.</p></header>
  {blue&&groups.length>0&&<ul className="listCard">{groups.map(g=><li key={g.id}><button className={`listRow ${g.id===selected?'on':''}`} aria-pressed={g.id===selected} onClick={()=>setSelected(g.id)}><span className="rowText"><b>{g.name}</b><small>{memberLine(g.id)||' '}</small></span><span className="chevron" aria-hidden="true">›</span></button></li>)}</ul>}
  {current&&<section className="stack sm groupDetail" aria-labelledby="group-title">
   {!blue&&groups.length>1&&<label className="field">Group<select value={selected} onChange={e=>setSelected(e.target.value)}>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
   <div className="groupHead">{!blue&&<span className="inviteCard" aria-hidden="true">{current.code.slice(0,4)}<br/>{current.code.slice(4)}</span>}<div><h2 id="group-title">{current.name}</h2><p>Code <strong className="inviteCode">{current.code}</strong> · {memberIds.length} {memberIds.length===1?'member':'members'}</p></div></div>
   <ModeChips mode={mode} setMode={setMode}/>
   {ranked.length?<Standings ratings={ranked.map(x=>x.rating)} names={names} me={me} mode={mode}/>:<p className="emptyNote">No ratings in this mode yet.</p>}
   <p className="fieldHint">Share the code so friends can join. Standings use each member's overall rating for this mode.</p>
  </section>}
  <div className="groupForms">
   <section aria-labelledby="new-group-title">
    <h2 id="new-group-title" className="sectionTitle">Start a group</h2>
    <form onSubmit={e=>{e.preventDefault();if(groupName.trim().length>=2)create()}}>
     <label className="field" htmlFor="group-name">Group name</label>
     <div className="joinRow"><input id="group-name" placeholder="Thursday regulars" maxLength={60} value={groupName} onChange={e=>setGroupName(e.target.value)}/><Button type="submit" disabled={busy||groupName.trim().length<2}>Create</Button></div>
    </form>
   </section>
   <section aria-labelledby="join-group-title">
    <h2 id="join-group-title" className="sectionTitle">Join a group</h2>
    <form onSubmit={e=>{e.preventDefault();if(joinCode.trim())join()}}>
     <label className="field" htmlFor="group-code">Group code</label>
     <div className="joinRow"><input id="group-code" className="codeInput" placeholder="8 characters" maxLength={8} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" aria-describedby="group-code-hint" value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())}/><Button type="submit" kind="outline" disabled={busy||!joinCode.trim()}>Join</Button></div>
     <p id="group-code-hint" className="fieldHint">Ask a member for the group's code.</p>
    </form>
   </section>
  </div>
 </div>
}

function ProfileScreen({me,profile,action,reload}:{me:string;profile:Profile|null;action:Action;reload:()=>Promise<void>}){
 const {theme,setTheme}=useContext(ThemeContext),blue=theme==='blue'
 const [name,setName]=useState(profile?.username||''),[ratings,setRatings]=useState<Rating[]>([]),[admissions,setAdmissions]=useState(0),[ledger,setLedger]=useState<{game_id:string;delta:number;recorded_at:string;mode:Mode}[]>([])
 const [accountEmail,setAccountEmail]=useState(''),[oldPassword,setOldPassword]=useState(''),[nextPassword,setNextPassword]=useState(''),[accountNotice,setAccountNotice]=useState('')
 useEffect(()=>{let live=true;void supabase.auth.getUser().then(({data})=>{if(live)setAccountEmail(data.user?.email||'')}).catch(console.error);return()=>{live=false}},[me])
 useEffect(()=>{if(profile)setName(profile.username)},[profile?.username])
 useEffect(()=>{void (async()=>{const[{data:r},{count},{data:ll}]=await Promise.all([supabase.from('ratings').select('*').eq('user_id',me),supabase.from('honesty_events').select('*',{count:'exact',head:true}).eq('user_id',me),supabase.from('rating_ledger').select('game_id,delta,recorded_at,mode').eq('user_id',me).order('recorded_at',{ascending:false}).limit(200)]);setRatings((r||[]) as Rating[]);setAdmissions(count||0);setLedger((ll||[]) as {game_id:string;delta:number;recorded_at:string;mode:Mode}[])})()},[me])
 const total=ratings.reduce((s,r)=>s+r.games,0),losses=ratings.reduce((s,r)=>s+r.losses,0),wins=Math.max(0,total-losses),who=profile?.username||''
 const naturalPath=useMemo(()=>{const events=ledger.filter(l=>l.mode==='natural').slice().reverse();let rating=1200;const vals=[1200,...events.map(l=>(rating+=l.delta))];const min=Math.min(...vals)-10,max=Math.max(...vals)+10;return vals.map((v,i)=>`${10+(i/Math.max(1,vals.length-1))*300},${95-(v-min)/Math.max(1,max-min)*80}`).join(' ')},[ledger])
 const saveName=()=>void action(async()=>{await rpc('set_username',{p_username:name.trim()});await reload();setAccountNotice('Username updated.')})
 const saveEmail=()=>void action(async()=>{
  if(!accountEmail.trim())throw new Error('Enter an email address.')
  const {data,error}=await supabase.auth.updateUser({email:accountEmail.trim()})
  if(error)throw error
  setAccountNotice(data.user?.new_email ? 'Email change pending. Follow the verification instructions sent to your email.' : 'Email update requested. If Supabase sends confirmation links, complete them to finish.')
 })
 const savePassword=()=>void action(async()=>{
  if(nextPassword.length<10)throw new Error('New password must be at least 10 characters.')
  if(!oldPassword)throw new Error('Enter your current password.')
  const {data:user,error:userError}=await supabase.auth.getUser()
  if(userError||!user.user?.email)throw userError||new Error('Cannot determine current email.')
  const {error:loginError}=await supabase.auth.signInWithPassword({email:user.user.email,password:oldPassword})
  if(loginError)throw new Error('Current password is incorrect.')
  const {error:updateError}=await supabase.auth.updateUser({password:nextPassword})
  if(updateError)throw updateError
  setOldPassword('');setNextPassword('');setAccountNotice('Password changed.')
 })
 return <div className="stack page pageEntry">
  {blue?<header className="profileHero">
   <Avatar id={me} name={who} me={me} size="lg"/>
   <div><h1>{who}</h1><p>{accountEmail&&<>{accountEmail} · </>}<Stars/> reputation</p></div>
  </header>:<header className="profileHero">
   <span className="seat mine heroPlayer" aria-hidden="true"><span className="seatInitials">{who.slice(0,2).toUpperCase()}</span></span>
   <div><h1>{who}</h1><p><Stars/> reputation</p></div>
  </header>}
  <dl className="statRow"><div><dt>Games</dt><dd>{total}</dd></div><div><dt>Wins</dt><dd>{wins}</dd></div><div><dt>Losses</dt><dd>{losses}</dd></div></dl>
  <section aria-labelledby="my-ratings-title">
   <h2 id="my-ratings-title" className="sectionTitle">Your ratings</h2>
   <ul className="modeRows">{MODES.map(m=>{const r=ratings.find(r=>r.mode===m.id);return <li key={m.id} className="modeRow">{blue?<span className={`rowSuit ${MODE_CARD[m.id].red?'red':''}`} aria-hidden="true">{MODE_CARD[m.id].suit}</span>:<MiniModeCard mode={m.id}/>}<span className="modeText"><b>{m.name}</b><small>{r?.games||0} games · {r?.losses||0} losses</small></span><strong className="modeRowRating">{formatRating(r?.rating||1200)}</strong></li>})}</ul>
  </section>
  {total>=10?<section className="stack sm" aria-labelledby="stats-title">
   <h2 id="stats-title">Statistics</h2>
   <dl className="statsGrid"><div><dt>Win rate</dt><dd>{total?Math.round(100*wins/total):0}%</dd></div><div><dt>Honest self-votes</dt><dd>{admissions}</dd></div><div><dt>Modes played</dt><dd>{ratings.filter(r=>r.games>0).length}</dd></div><div><dt>Games with a result</dt><dd>{total}</dd></div></dl>
   <div className="chartCard"><h3>Durak rating over time</h3><svg viewBox="0 0 320 105" role="img" aria-label="Durak cumulative rating trend"><polyline fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={naturalPath}/></svg></div>
   <h3 className="subTitle">Recent rating changes</h3>
   <ul className="modeRows">{ledger.slice(0,8).map(entry=><li key={entry.game_id} className="modeRow"><span className="modeText"><b>{modeInfo(entry.mode).name}</b><small>{date(entry.recorded_at)}</small></span><strong className={`modeRowRating ${entry.delta<0?'lossDelta':'gainDelta'}`}>{entry.delta>=0?'+':'−'}{Math.abs(entry.delta).toFixed(1)}</strong></li>)}</ul>
  </section>:<section className="unlock" aria-labelledby="stats-title">
   <h2 id="stats-title" className="sectionTitle">Statistics</h2>
   <div className="unlockCards" aria-hidden="true">{Array.from({length:10},(_,i)=><span key={i} className={i<total?'on':''}/>)}</div>
   <p>Statistics unlock after 10 games with a confirmed result. {Math.max(0,10-total)} more to go.</p>
  </section>}
  <section aria-labelledby="look-title">
   <h2 id="look-title" className="sectionTitle">Appearance</h2>
   <div className="themePicker" role="group" aria-label="Theme">{THEMES.map(t=><button key={t.id} aria-pressed={theme===t.id} className={`themeOption ${t.id} ${theme===t.id?'on':''}`} onClick={()=>setTheme(t.id)}><span className="themeSwatch" aria-hidden="true"><span/><span/><span/></span><span className="rowText"><b>{t.name}</b><small>{t.description}</small></span></button>)}</div>
   <p className="fieldHint">Saved on this device.</p>
  </section>
  <section className="card accountCard" aria-labelledby="account-title">
   <h2 id="account-title">Account</h2>
   <form onSubmit={e=>{e.preventDefault();saveName()}}><label className="field">Display username<input value={name} onChange={e=>setName(e.target.value)} maxLength={22} autoCapitalize="none" autoCorrect="off" spellCheck={false}/></label><Button type="submit" kind="outline">Save username</Button></form>
   <form onSubmit={e=>{e.preventDefault();saveEmail()}}><label className="field">Email address<input type="email" autoComplete="email" value={accountEmail} onChange={e=>setAccountEmail(e.target.value)}/></label><p className="fieldHint">Keep Secure email change enabled in Supabase. Email changes may require confirmation of the old and new addresses.</p><Button type="submit" kind="outline">Update email</Button></form>
   <form onSubmit={e=>{e.preventDefault();savePassword()}}><label className="field">Current password<input type="password" autoComplete="current-password" value={oldPassword} onChange={e=>setOldPassword(e.target.value)}/></label><label className="field">New password<input type="password" minLength={10} autoComplete="new-password" aria-describedby="new-password-hint" value={nextPassword} onChange={e=>setNextPassword(e.target.value)}/></label><p id="new-password-hint" className="fieldHint">At least 10 characters</p><Button type="submit" kind="outline">Change password</Button></form>
   {accountNotice&&<p className="accountNotice" role="status">{accountNotice}</p>}
   <Button kind="danger" onClick={()=>void supabase.auth.signOut()}>Sign out <LogOut size={17}/></Button>
  </section>
 </div>
}
