import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {Session} from '@supabase/supabase-js'
import {QRCodeSVG} from 'qrcode.react'
import {ArrowLeft,ArrowRight,CheckCircle2,ChevronDown,Clock3,Copy,Crown,History,LogOut,RefreshCw,Share2,ShieldCheck,Star,Timer,X} from 'lucide-react'
import {configured,date,errorMessage,MODES,modeInfo,rpc,supabase} from './lib'
import {isEmailIdentifier,isUsername} from './authValidation'
import {signInByUsername} from './usernameSignIn'
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
// Suits double as tab icons. Rendered twice (bottom bar on phones, header on desktop); CSS shows one.
function NavTabs({page,go,className}:{page:Page|null;go:(p:Page)=>void;className:string}){
 return <nav className={className} aria-label="Main">{NAV.map(n=><button key={n.id} className={`${page===n.id?'on':''} ${n.red?'red':''}`} aria-current={page===n.id?'page':undefined} onClick={()=>go(n.id)}><span className="navSuit" aria-hidden="true">{n.suit}</span><span>{n.label}</span></button>)}</nav>
}
function AuthScreen({joinCode}:{joinCode:string}){
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
 // Username problems are shown under the username field; everything else above the submit button.
 const usernameError=tab==='register'&&/username/i.test(notice)
 const errorLine=<p id="auth-error" className="fieldError" role="alert"><span aria-hidden="true">{'\u2666\uFE0E'}</span>{notice}</p>
 return <div className="authWrap"><main className="authInner">
  {joinCode?<>
   <h1 className="brandHeading"><Brand/></h1>
   <div className="authInvite" role="status"><span className="inviteCard" aria-hidden="true">{joinCode.slice(0,4)}<br/>{joinCode.slice(4)}</span><p>You've been invited to table <strong>{joinCode}</strong>. Sign in or create an account and you'll join it straight away.</p></div>
  </>:<header className="authIntro">
   <div className="brandLarge"><span className="brandFan" aria-hidden="true"><span className="fanBack"/><span className="fanFront"><span className="miniIndex">D</span>{'\u2660\uFE0E'}</span></span><h1>Durak<br/>Ranked</h1></div>
   <p>Keep score for the games you play with a real deck. Vote on who's left holding cards, and see your rating per mode.</p>
  </header>}
  <div className="authTabs" role="group" aria-label="Account">
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
 const user=session?.user
 const reloadProfile=useCallback(async()=>{if(!user)return;const {data,error}=await supabase.from('profiles').select('*').eq('id',user.id).single();if(error)throw error;setProfile(data as Profile)},[user?.id])
 useEffect(()=>{let valid=true;void supabase.auth.getSession().then(({data})=>{if(valid){setSession(data.session);setLoading(false)}});const{subscription}=supabase.auth.onAuthStateChange((_event,s)=>{setSession(s);setLoading(false)}).data;return()=>{valid=false;subscription.unsubscribe()}},[])
 useEffect(()=>{if(user){void reloadProfile().catch(e=>setMessage(errorMessage(e))) }else setProfile(null)},[user?.id,reloadProfile])
 useEffect(()=>{if(!joinCode||!user)return;const c=joinCode;setJoinCode('');void (async()=>{try{setBusy(true);const id=await rpc<string>('join_table',{p_code:c});setTableId(id);history.replaceState(null,'',location.pathname)}catch(e){setMessage(errorMessage(e))}finally{setBusy(false)}})()},[user?.id,joinCode])
 useEffect(()=>{window.scrollTo(0,0)},[page,tableId])
 const action:Action=async fn=>{if(busy)return;setBusy(true);setMessage(null);try{await fn()}catch(e){setMessage(errorMessage(e))}finally{setBusy(false)}}
 if(!configured)return <div className="setup"><Brand/><h1>Connect your backend</h1><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to a <code>.env</code> file, then restart Vite.</p><p className="muted">See README.md for the complete Supabase setup.</p></div>
 if(loading)return <div className="loading" role="status"><Brand/><p>Loading {APP_NAME}…</p></div>
 if(!session)return <AuthScreen joinCode={joinCode}/>
 const initials=(profile?.username||'U').slice(0,2).toUpperCase()
 const go=(p:Page)=>{setTableId(null);setPage(p)}
 return <div className="appShell">
  <header className="topbar"><div className="topbarInner">
   <button className="brandButton" aria-label={`${APP_NAME}, home`} onClick={()=>go('home')}><Brand/></button>
   <NavTabs className="headerNav" page={tableId?null:page} go={go}/>
   <button className="avatar" aria-label="Your profile" title="Your profile" onClick={()=>go('profile')}><span>{initials}</span></button>
  </div></header>
  <main className={`main ${tableId?'':'withNav'}`}>
   {tableId?<TableScreen key={tableId} tableId={tableId} me={user!.id} action={action} busy={busy} onLeave={()=>{setTableId(null);setPage('home')}}/>:
   page==='home'?<HomeScreen me={user!.id} profile={profile} openTable={setTableId} openRankings={()=>setPage('leaderboard')} action={action} busy={busy}/>:
   page==='leaderboard'?<LeaderboardScreen me={user!.id}/>:
   page==='groups'?<GroupsScreen me={user!.id} action={action} busy={busy}/>:
   <ProfileScreen me={user!.id} profile={profile} action={action} reload={reloadProfile}/>}
  </main>
  {!tableId&&<NavTabs className="bottomNav" page={page} go={go}/>}
  {message&&<div className="toast" role="alert">{message}<button aria-label="Dismiss message" onClick={()=>setMessage(null)}><X size={16}/></button></div>}
 </div>
}

function HomeScreen({me,profile,openTable,openRankings,action,busy}:{me:string;profile:Profile|null;openTable:(id:string)=>void;openRankings:()=>void;action:Action;busy:boolean}){
 const[mode,setMode]=useState<Mode>('natural'),[expanded,setExpanded]=useState(false),[join,setJoin]=useState(''),[tables,setTables]=useState<TableRow[]>([]),[ratings,setRatings]=useState<Rating[]>([]),[groups,setGroups]=useState<Group[]>([]),[group,setGroup]=useState('')
 const [loaded,setLoaded]=useState(false),[front,setFront]=useState(0)
 const load=useCallback(async()=>{const {data:members}=await supabase.from('table_members').select('table_id').eq('user_id',me).eq('is_active',true);const ids=(members||[]).map(m=>m.table_id);const [{data:tt},{data:rr},{data:gm}]=await Promise.all([
  ids.length?supabase.from('tables').select('*').in('id',ids).order('created_at',{ascending:false}):Promise.resolve({data:[]}),
  supabase.from('ratings').select('*').eq('user_id',me),supabase.from('group_members').select('group_id').eq('user_id',me)])
 setTables((tt||[]) as TableRow[]);setRatings((rr||[]) as Rating[]);setLoaded(true)
 const groupIds=(gm||[]).map(x=>x.group_id);if(groupIds.length){const{data}=await supabase.from('friend_groups').select('*').in('id',groupIds);setGroups((data||[]) as Group[])}else setGroups([])
 },[me])
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
 const status=current?current.status==='lobby'?'Your table is still open.':'Your game is still going.':!loaded?'':played?'No open tables right now. Start one, or join a friend\'s.':'No tables yet. Pick a game to start one, or join a friend\'s.'
 return <div className="stack home pageEntry">
  <section className="greeting"><h1>{greeting()}, {profile?.username||'friend'}</h1>{status&&<p>{status}</p>}</section>
  <div className={`homeGrid ${current?'withHand':''}`}>
   {current&&<section aria-labelledby="tables-title">
    <div className="sectionHeading"><h2 id="tables-title">Your tables</h2><span className="handMeta">{hand>1&&<span>Swipe · {idx+1} of {hand}</span>}<button className="iconButton" aria-label="Refresh tables" title="Refresh tables" onClick={()=>void load()}><RefreshCw size={18}/></button></span></div>
    <div className="hand" onPointerDown={e=>startSwipe(e.clientX)} onClickCapture={e=>{if(swiped.current){swiped.current=false;e.preventDefault();e.stopPropagation()}}}>
     {next&&<button className="tableCard back" aria-label={`Show ${describe(next)}`} onClick={()=>setFront((idx+1)%hand)}><CornerIndex mode={next.mode}/><span className="tableName">{modeInfo(next.mode).name}</span><span>{next.code}</span><span>{STATUS_TEXT[next.status]}</span></button>}
     <div className="tableCard front" key={current.id}>
      <CornerIndex mode={current.mode}/><CornerIndex mode={current.mode} flip/>
      <div className="tableCardBody"><span className={`tableStatus ${current.status}`}>{STATUS_TEXT[current.status]}</span><h3>{modeInfo(current.mode).name}</h3><span className="tableCode">Table {current.code}</span></div>
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
      {groups.length>0&&<label className="field">Friend group (optional)<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">No group</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
      <Button onClick={create} disabled={busy} className="wide">Create {picked.name} table</Button>
     </div>
    </section>
    <section aria-labelledby="join-title">
     <h2 id="join-title" className="sectionTitle">Join a table</h2>
     <form onSubmit={e=>{e.preventDefault();joinRoom()}}>
      <label className="field" htmlFor="join-code">Table code</label>
      <div className="joinRow"><input id="join-code" className="codeInput" placeholder="8 characters" maxLength={8} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" aria-describedby="join-hint" value={join} onChange={e=>setJoin(e.target.value.toUpperCase())}/><Button type="submit" kind="outline" disabled={busy||!join.trim()}>Join</Button></div>
      <p id="join-hint" className="fieldHint">Type the 8-character code from the host, or scan the QR code on their phone.</p>
     </form>
    </section>
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
 const share=async()=>{if(navigator.share){try{await navigator.share({title:`Join my table on ${APP_NAME}`,text:`Join my Durak table on ${APP_NAME} with code ${table?.code}.`,url:invite});return}catch{/* copy fallback */}}await navigator.clipboard.writeText(invite)}
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
 return <div className="stack pageEntry"><button className="backLink" onClick={onLeave}><ArrowLeft size={18}/> All tables</button>
  <div className="tableHero"><div><div className="eyebrow">LIVE DURAK TABLE <span className="dotDivider">·</span> #{table.code}</div><h1>{info.name}</h1><p>{info.detail} · {info.min}–{info.max} players</p></div><span className={`statusChip ${table.status}`}><span className="liveDot"/>{table.status==='lobby'?'LOBBY':table.status==='playing'?'PLAYING':'VOTING'}</span></div>
  <div className="tableActions"><Button kind="secondary" onClick={()=>setShowQR(!showQR)}><Share2 size={17}/> Invite / QR</Button><Button kind="secondary" onClick={()=>void load()}><RefreshCw size={17}/> Refresh</Button></div>
  {showQR&&<section className="card qrCard"><div className="qrInner"><QRCodeSVG value={invite} size={184} includeMargin/></div><p>Scan to join this table</p><div className="codeLarge">{table.code}</div><Button kind="secondary" onClick={()=>void share()}><Copy size={15}/> Share link</Button></section>}
  <section className="card"><div className="sectionHeading"><h2>Players <span className="softCount">{members.length}/{info.max}</span></h2><span className="muted tiny">{table.status==='lobby'?'ROSTER OPEN':'ROSTER LOCKED'}</span></div>
   <div className="playerList">{members.map((m,i)=><div className="playerRow" key={m.user_id}><div className="playerNum">{String(i+1).padStart(2,'0')}</div><div className="playerAvatar">{name(m.user_id).slice(0,2).toUpperCase()}</div><div className="playerName"><b>{name(m.user_id)}</b>{m.user_id===me&&<span className="youPill">YOU</span>}{m.user_id===table.host_id&&<span title="Host"><Crown size={14} className="hostCrown"/></span>}</div><Stars compact/>{table.status==='lobby'&&table.host_id===me&&m.user_id!==me&&<button className="subtle" title="Transfer host" disabled={busy} onClick={()=>promote(m.user_id)}><Crown size={15}/></button>}</div>)}</div>
   {table.status==='lobby'&&<div className="playerFooter"><p>{members.length<info.min?`Need ${info.min-members.length} more player${info.min-members.length===1?'':'s'} to start`:'Everyone ready? Deal the cards.'}</p><Button onClick={play} disabled={busy||members.length<info.min} className="wide">Start new game <ArrowRight size={18}/></Button></div>}
   {table.status==='playing'&&<div className="playerFooter"><div className="hint"><ShieldCheck size={18}/> All players are locked into this round. You can close your phone while playing.</div><Button onClick={finishPlay} disabled={busy} className="wide">Cards finished — record results <ArrowRight size={17}/></Button></div>}
   {table.status==='lobby'&&<button className="leaveLink" onClick={leave} disabled={busy}>Leave table <LogOut size={14}/></button>}
  </section>
  {table.status==='results'&&<section className="card votingCard"><div className="sectionHeading"><div><div className="eyebrow">RESULT VERIFICATION</div><h2>{activeGame?`Game ${activeGame.slot} of ${games.length}`:'Results'}</h2></div><div className="timerBadge"><Timer size={17}/>{activeGame?.deadline?`${Math.max(0,Math.ceil((new Date(activeGame.deadline).getTime()-displayNow)/1000))}s`:'30s'}</div></div>
   {activeGame&& !pendingBefore ? <>
     {activeGame.state==='tie_offer'?<div className="stack sm"><p>Tie between {activeGame.loser_ids.map(name).join(' and ')}. Each tied player must accept a shared, reduced Elo loss. Otherwise voting restarts among them.</p>{activeGame.loser_ids.includes(me)?<div className="buttonPair"><Button onClick={()=>respond(activeGame.id,true)} disabled={busy}>Accept shared loss</Button><Button kind="secondary" onClick={()=>respond(activeGame.id,false)} disabled={busy}>Reject / revote</Button></div>:<p className="muted">Waiting for the tied players to respond.</p>}</div>:<>
     <p>Who lost? Vote for one person. A strict majority confirms early; otherwise the most votes after 30 seconds wins (minimum 2).</p>
     <div className="voteOptions">{players.filter(id=>!activeGame.allowed_nominees||activeGame.allowed_nominees.includes(id)).map(id=>{const votes=totals.find(v=>v.game_id===activeGame.id&&v.nominee_id===id)?.votes||0;const selected=mySelections[activeGame.id]===id;return <button disabled={busy} className={`voteOption ${selected?'picked':''}`} key={id} onClick={()=>cast(activeGame.id,id)}><span className="playerAvatar">{name(id).slice(0,2).toUpperCase()}</span><span className="voteName">{name(id)} {id===me?'(me)':''}</span><span className="voteCount">{votes} {votes===1?'vote':'votes'}</span>{selected&&<CheckCircle2 size={19}/>}</button>})}</div>
     {activeGame.state==='awaiting'&&<p className="muted tiny">The timer begins with the first vote.</p>}
     {activeGame.state==='voting'&&<p className="muted tiny">Totals are public, individual votes stay anonymous until the result is final. Votes may be changed.</p>}
    </>}
    </>:<p className="muted">Waiting for Game 1 to finish its vote.</p>}
   {games.filter(g=>['confirmed','tied','unresolved','void'].includes(g.state)).map(g=><ResultLine key={g.id} game={g} name={name} restart={()=>restart(g.id)} busy={busy}/>) }
  </section>}
  {table.status==='lobby'&&historyGames.length>0&&<section className="card"><button className="sectionHeading historyToggle" onClick={()=>setShowHistory(s=>!s)}><h2><History size={18}/> Recent results</h2><ChevronDown size={18}/></button>{showHistory&&<div className="stack sm">{historyGames.filter(g=>['confirmed','tied','void','unresolved'].includes(g.state)).slice(0,12).map(g=><div key={g.id} className="historyItem"><ResultLine game={g} name={name} restart={()=>restart(g.id)} busy={busy}/>{ballots[g.id]?.length>0&&<div className="ballots">{ballots[g.id].map(v=><span key={v.voter_id}>{name(v.voter_id)} → {name(v.nominee_id)}</span>)}</div>}{['confirmed','tied'].includes(g.state)&&g.finalized_at&&Date.now()-new Date(g.finalized_at).getTime()<86400000&&<button className="subtle" onClick={()=>openCorrection(g.id)}>Request correction</button>}{cases.filter(c=>c.game_id===g.id&&c.state==='open').map(c=><div className="correction" key={c.id}><span>Correction vote · {yesCounts[c.id]||0} approvals</span><Button kind="secondary" onClick={()=>correctionVote(c.id,true)}>Approve</Button><Button kind="ghost" onClick={()=>correctionVote(c.id,false)}>Reject</Button></div>)}</div>)}</div>}</section>}
  {table.status==='results'&&games.some(g=>g.state==='unresolved')&&<div className="hint"><Clock3 size={17}/> Unresolved votes can be manually restarted before the next round.</div>}
  <p className="center muted tiny">Results and ratings are saved securely. Real cards, real rivalries.</p>
 </div>
}
function ResultLine({game,name,restart,busy}:{game:Game;name:(id:string)=>string;restart:()=>void;busy:boolean}){
 return <div className="resultLine"><span className="muted tiny">GAME {game.slot}</span><span>{game.state==='confirmed'?<><CheckCircle2 size={15}/> Lost: <b>{name(game.loser_ids[0])}</b></>:game.state==='tied'?<>Shared loss: <b>{game.loser_ids.map(name).join(', ')}</b></>:game.state==='unresolved'?<><Clock3 size={15}/> Unresolved</>:game.state==='void'?'Reversed':'Awaiting result'}</span>{game.state==='unresolved'&&<button className="subtle" disabled={busy} onClick={restart}>Revote</button>}</div>
}

function LeaderboardScreen({me}:{me:string}){
 const [mode,setMode]=useState<Mode>('natural'),[ratings,setRatings]=useState<Rating[]>([]),[users,setUsers]=useState<Record<string,Profile>>({}),[loading,setLoading]=useState(true)
 useEffect(()=>{let live=true;setLoading(true);void (async()=>{const{data,error}=await supabase.from('ratings').select('*').eq('mode',mode).order('rating',{ascending:false}).limit(100);if(error)throw error;const scores=(data||[]) as Rating[];const{data:p}=scores.length?await supabase.from('profiles').select('*').in('id',scores.map(r=>r.user_id)):{data:[]};if(live){setRatings(scores);setUsers(Object.fromEntries(((p||[]) as Profile[]).map(x=>[x.id,x])));setLoading(false)}})().catch(console.error);return()=>{live=false}},[mode])
 return <div className="stack pageEntry"><div className="pageHead"><div className="eyebrow">THE GLOBAL BOARD</div><h1>Rankings<span className="period">.</span></h1><p>Every defeat reshapes the standings.</p></div>
  <div className="modeTabs">{MODES.map(m=><button key={m.id} onClick={()=>setMode(m.id)} className={m.id===mode?'on':''}>{m.name}</button>)}</div>
  <section className="card leaderboard">{loading?<p>Loading…</p>:ratings.length===0?<p>No ranked games yet. Start the first table.</p>:ratings.map((r,i)=><div className={`rankRow ${r.user_id===me?'mine':''}`} key={r.user_id}><span className="position">#{i+1}</span><div className="playerAvatar">{users[r.user_id]?.username.slice(0,2).toUpperCase()||'?'}</div><div className="rankName"><strong>{users[r.user_id]?.username||'Player'} {r.user_id===me&&<span className="youPill">YOU</span>}</strong><small>{r.games} games · {r.losses} losses</small></div><span className="rankScore">{formatRating(r.rating)}</span></div>)}</section>
  <p className="center muted tiny">Ratings are specific to each mode. Everyone starts at 1200.</p>
 </div>
}

function GroupsScreen({me,action,busy}:{me:string;action:Action;busy:boolean}){
 const [groupName,setGroupName]=useState(''),[joinCode,setJoinCode]=useState(''),[groups,setGroups]=useState<Group[]>([]),[selected,setSelected]=useState<string>(''),[memberIds,setMemberIds]=useState<string[]>([]),[mode,setMode]=useState<Mode>('natural'),[ranked,setRanked]=useState<{profile:Profile;rating:Rating}[]>([])
 const load=useCallback(async()=>{const{data:mm}=await supabase.from('group_members').select('group_id').eq('user_id',me);const ids=(mm||[]).map(x=>x.group_id);if(!ids.length){setGroups([]);return}const{data:gg}=await supabase.from('friend_groups').select('*').in('id',ids);setGroups((gg||[]) as Group[]);setSelected(s=>s||ids[0])},[me])
 useEffect(()=>{void load()},[load])
 useEffect(()=>{if(!selected)return;void (async()=>{const{data:gm}=await supabase.from('group_members').select('user_id').eq('group_id',selected);const ids=(gm||[]).map(x=>x.user_id);setMemberIds(ids);if(!ids.length){setRanked([]);return}const[{data:rr},{data:pp}]=await Promise.all([supabase.from('ratings').select('*').in('user_id',ids).eq('mode',mode).order('rating',{ascending:false}),supabase.from('profiles').select('*').in('id',ids)]);const pm=Object.fromEntries(((pp||[]) as Profile[]).map(x=>[x.id,x]));setRanked(((rr||[]) as Rating[]).map(r=>({profile:pm[r.user_id],rating:r})).filter(x=>x.profile))})()},[selected,mode])
 const create=()=>void action(async()=>{const id=await rpc<string>('create_friend_group',{p_name:groupName});setSelected(id);setGroupName('');await load()})
 const join=()=>void action(async()=>{const id=await rpc<string>('join_friend_group',{p_code:joinCode});setSelected(id);setJoinCode('');await load()})
 return <div className="stack pageEntry"><div className="pageHead"><div className="eyebrow">YOUR CIRCLE</div><h1>Friend groups<span className="period">.</span></h1><p>Private leaderboards for every rivalry.</p></div>
 <section className="card"><h2>Create a group</h2><div className="inlineField"><input placeholder="Group name" maxLength={60} value={groupName} onChange={e=>setGroupName(e.target.value)}/><Button disabled={busy||groupName.trim().length<2} onClick={create}>Create</Button></div><div className="or">or</div><div className="inlineField"><input placeholder="Group invite code" maxLength={8} value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())}/><Button kind="secondary" disabled={busy||!joinCode.trim()} onClick={join}>Join</Button></div></section>
 {groups.length>0&&<section className="card stack sm"><div className="sectionHeading"><h2>My groups</h2><span className="muted tiny">{groups.length} GROUPS</span></div><select value={selected} onChange={e=>setSelected(e.target.value)}>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select><p className="muted">Share the invite code with friends: <strong className="inviteCode">{groups.find(g=>g.id===selected)?.code}</strong></p><div className="modeTabs">{MODES.map(m=><button className={mode===m.id?'on':''} onClick={()=>setMode(m.id)} key={m.id}>{m.name}</button>)}</div>{ranked.map((x,i)=><div className="rankRow" key={x.profile.id}><span className="position">#{i+1}</span><strong className="rankName">{x.profile.username}</strong><span className="rankScore">{formatRating(x.rating.rating)}</span></div>)}<p className="muted tiny">{memberIds.length} members · group-specific leaderboard uses each player's global mode rating.</p></section>}
 </div>
}

function ProfileScreen({me,profile,action,reload}:{me:string;profile:Profile|null;action:Action;reload:()=>Promise<void>}){
 const [name,setName]=useState(profile?.username||''),[ratings,setRatings]=useState<Rating[]>([]),[admissions,setAdmissions]=useState(0),[ledger,setLedger]=useState<{game_id:string;delta:number;recorded_at:string;mode:Mode}[]>([])
 const [accountEmail,setAccountEmail]=useState(''),[oldPassword,setOldPassword]=useState(''),[nextPassword,setNextPassword]=useState(''),[accountNotice,setAccountNotice]=useState('')
 useEffect(()=>{let live=true;void supabase.auth.getUser().then(({data})=>{if(live)setAccountEmail(data.user?.email||'')}).catch(console.error);return()=>{live=false}},[me])
 useEffect(()=>{if(profile)setName(profile.username)},[profile?.username])
 useEffect(()=>{void (async()=>{const[{data:r},{count},{data:ll}]=await Promise.all([supabase.from('ratings').select('*').eq('user_id',me),supabase.from('honesty_events').select('*',{count:'exact',head:true}).eq('user_id',me),supabase.from('rating_ledger').select('game_id,delta,recorded_at,mode').eq('user_id',me).order('recorded_at',{ascending:false}).limit(200)]);setRatings((r||[]) as Rating[]);setAdmissions(count||0);setLedger((ll||[]) as {game_id:string;delta:number;recorded_at:string;mode:Mode}[])})()},[me])
 const total=ratings.reduce((s,r)=>s+r.games,0)
 const naturalPath=useMemo(()=>{const events=ledger.filter(l=>l.mode==='natural').slice().reverse();let rating=1200;const vals=[1200,...events.map(l=>(rating+=l.delta))];const min=Math.min(...vals)-10,max=Math.max(...vals)+10;return vals.map((v,i)=>`${10+(i/Math.max(1,vals.length-1))*300},${95-(v-min)/Math.max(1,max-min)*80}`).join(' ')},[ledger])
 return <div className="stack pageEntry"><div className="pageHead"><div className="eyebrow">YOUR PERFORMANCE</div><h1>My profile<span className="period">.</span></h1></div>
  <section className="card profileCard"><div className="profileIcon">{profile?.username.slice(0,2).toUpperCase()}</div><h2>{profile?.username}</h2><Stars/><div className="profileQuick"><div><b>{total}</b><span>Ranked results</span></div><div><b>{Math.max(0,total-ratings.reduce((s,r)=>s+r.losses,0))}</b><span>Wins</span></div><div><b>{ratings.reduce((s,r)=>s+r.losses,0)}</b><span>Losses</span></div></div></section>
  <section className="card stack sm"><h2>My ratings</h2>{MODES.map(m=>{const r=ratings.find(r=>r.mode===m.id);return <div className="ratingRow" key={m.id}><div><b>{m.name}</b><small>{r?.games||0} results · {r?.losses||0} losses</small></div><strong>{formatRating(r?.rating||1200)}</strong></div>})}</section>
  {total>=10?<section className="card stack sm"><div className="sectionHeading"><h2>Advanced statistics</h2><CheckCircle2 className="statOk" size={20} aria-hidden="true"/></div><div className="statsGrid"><div><span>Win rate</span><b>{total?Math.round(100*(total-ratings.reduce((s,r)=>s+r.losses,0))/total):0}%</b></div><div><span>Verified self-admissions</span><b>{admissions}</b></div><div><span>Modes played</span><b>{ratings.filter(r=>r.games>0).length}</b></div><div><span>Ranked results</span><b>{total}</b></div></div><div className="chartCard"><div className="eyebrow">DURAK · RATING TREND</div><svg viewBox="0 0 320 105" role="img" aria-label="Durak cumulative rating trend"><polyline fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={naturalPath}/></svg></div><div className="eyebrow">RECENT RATING CHANGES</div>{ledger.slice(0,8).map(entry=><div className="ratingRow" key={entry.game_id}><div><b>{modeInfo(entry.mode).name}</b><small>{date(entry.recorded_at)}</small></div><strong className={entry.delta<0?'lossDelta':'gainDelta'}>{entry.delta>=0?'+':''}{entry.delta.toFixed(1)}</strong></div>)}</section>:<div className="hint"><ShieldCheck size={18}/> Advanced statistics unlock after 10 validated individual game results. {Math.max(0,10-total)} more to go.</div>}
  <section className="card stack sm"><h2>Account settings</h2>
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
  </section>
 </div>
}
