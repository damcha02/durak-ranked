import { useEffect, useRef, useState } from 'react'

const THRESHOLD=70 // px of drag (after damping) needed to trigger
const MAX_PULL=110

// Installed PWAs keep running the JS they started with, so a new deploy stays hidden until a full
// restart. Pulling down at the top of any screen checks for a new build, then reloads.
async function refreshApp(){
 try{
  const reg=await navigator.serviceWorker?.getRegistration()
  if(reg){
   await reg.update()
   const sw=reg.installing||reg.waiting
   if(sw&&sw.state!=='activated')await new Promise<void>(done=>{
    const t=setTimeout(done,4000)
    sw.addEventListener('statechange',()=>{if(sw.state==='activated'){clearTimeout(t);done()}})
    if(reg.waiting===sw)sw.postMessage({type:'SKIP_WAITING'})
   })
  }
 }catch{/* offline or no service worker: a plain reload is still fine */}
 window.location.reload()
}

export function PullToRefresh(){
 const [pull,setPull]=useState(0)
 const [busy,setBusy]=useState(false)
 const start=useRef<number|null>(null),dist=useRef(0)
 useEffect(()=>{
  const onStart=(e:TouchEvent)=>{start.current=e.touches.length===1&&window.scrollY<=0?e.touches[0].clientY:null;dist.current=0}
  const onMove=(e:TouchEvent)=>{
   if(start.current===null)return
   if(e.touches.length!==1||window.scrollY>0){start.current=null;dist.current=0;setPull(0);return}
   const dy=e.touches[0].clientY-start.current
   if(dy<=0){dist.current=0;setPull(0);return}
   dist.current=Math.min(MAX_PULL,dy*0.5)
   setPull(dist.current)
  }
  const onEnd=()=>{
   const fire=start.current!==null&&dist.current>=THRESHOLD
   start.current=null
   if(fire){setBusy(true);setPull(THRESHOLD);void refreshApp()}else{dist.current=0;setPull(0)}
  }
  document.addEventListener('touchstart',onStart,{passive:true})
  document.addEventListener('touchmove',onMove,{passive:true})
  document.addEventListener('touchend',onEnd,{passive:true})
  document.addEventListener('touchcancel',onEnd,{passive:true})
  return()=>{document.removeEventListener('touchstart',onStart);document.removeEventListener('touchmove',onMove);document.removeEventListener('touchend',onEnd);document.removeEventListener('touchcancel',onEnd)}
 },[])
 if(pull<=0&&!busy)return null
 return <div className={`pullIndicator ${busy?'spinning':''}`} aria-hidden="true" style={{transform:`translate(-50%,${pull-40}px)`,opacity:Math.min(1,pull/THRESHOLD)}}><span style={busy?undefined:{transform:`rotate(${pull*4}deg)`}}/></div>
}
