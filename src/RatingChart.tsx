// Elo over time for one mode: Elo axis, local-time axis, light grid, the peak marked, and a readout of
// whichever point is touched, hovered or chosen with the arrow keys. Layout and data: ratingChart.ts.
import {useEffect,useMemo,useRef,useState} from 'react'
import {buildSeries,formatElo,layout,nearestIndex,pointDate,pointTime} from './ratingChart'
import type {ChartPoint,RatedGame} from './ratingChart'

export const CHART_HEIGHT=220
// Above this many games the line alone carries the shape; the peak and the chosen point keep their markers.
const MAX_DOTS=120
const signed=(d:number)=>`${d>0?'+':d<0?'−':'±'}${Math.abs(d).toFixed(2)}`
const deltaClass=(d:number)=>d>0?'gainDelta':d<0?'lossDelta':''
const when=(p:ChartPoint)=>p.kind==='start'?'Starting rating':`${pointTime(p.t)}${p.game&&p.game.games_in_round>1?` · Game ${p.game.slot} of ${p.game.games_in_round}`:''}`

export function RatingChart({games,modeName}:{games:RatedGame[];modeName:string}){
 const box=useRef<HTMLDivElement>(null),[width,setWidth]=useState(320),[selected,setSelected]=useState<number|null>(null)
 useEffect(()=>{
  const el=box.current;if(!el)return
  const update=()=>setWidth(Math.max(240,Math.round(el.clientWidth)))
  update()
  if(typeof ResizeObserver==='undefined')return
  const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect()
 },[])
 const points=useMemo(()=>buildSeries(games),[games])
 const view=useMemo(()=>points.length?layout(points,width,CHART_HEIGHT):null,[points,width])
 useEffect(()=>setSelected(null),[games])
 if(!view)return null
 const {plot,xs,ys,peak}=view,last=points.length-1
 const pick=(clientX:number)=>{const r=box.current?.getBoundingClientRect();if(r)setSelected(nearestIndex(xs,clientX-r.left))}
 const onKey=(e:React.KeyboardEvent)=>{
  const at=selected??last
  const next=e.key==='ArrowLeft'?Math.max(0,at-1):e.key==='ArrowRight'?Math.min(last,at+1):e.key==='Home'?0:e.key==='End'?last:null
  if(next!==null){e.preventDefault();setSelected(next)}else if(e.key==='Escape')setSelected(null)
 }
 const shown=selected??last,p=points[shown],top=points[peak]
 const summary=`${modeName} rating over time: ${points.length-1} rated ${points.length===2?'game':'games'}, from ${formatElo(points[0].rating,2)} to ${formatElo(points[last].rating,2)}. Highest ${formatElo(top.rating,2)}${top.kind==='start'?' at the start':` on ${pointDate(top.t)}`}.`
 return <div className="ratingChart">
  <p className="chartPeak"><span className="peakKey" aria-hidden="true"/>Highest <b>{formatElo(top.rating,2)}</b> · {top.kind==='start'?'starting rating':pointDate(top.t)}</p>
  <div className="chartReadout" aria-live="polite">
   <span className="readoutWhen">{selected===null?'Latest':when(p)}</span>
   <span className="readoutValue"><b>{formatElo(p.rating,2)}</b>{p.kind==='game'&&<span className={deltaClass(p.delta)}>{signed(p.delta)}</span>}</span>
  </div>
  <div ref={box} className="chartPlot" tabIndex={0} role="group" aria-label={`${summary} Use the arrow keys to read each game.`} onKeyDown={onKey}>
   <svg width={view.width} height={view.height} viewBox={`0 0 ${view.width} ${view.height}`} role="img" aria-label={summary}
    onPointerDown={e=>{e.currentTarget.setPointerCapture?.(e.pointerId);pick(e.clientX)}}
    onPointerMove={e=>{if(e.pointerType==='mouse'||e.buttons)pick(e.clientX)}}
    onPointerLeave={e=>{if(e.pointerType==='mouse')setSelected(null)}}>
    <g className="chartGrid">
     {view.yTicks.map(t=><line key={`y${t.v}`} x1={plot.x0} x2={plot.x1} y1={t.y} y2={t.y}/>)}
     {view.xTicks.map(t=><line key={`x${t.t}`} x1={t.x} x2={t.x} y1={plot.y0} y2={plot.y1}/>)}
    </g>
    <line className="chartAxis" x1={plot.x0} x2={plot.x1} y1={plot.y1} y2={plot.y1}/>
    <g className="chartLabels">
     {view.yTicks.map(t=><text key={`y${t.v}`} x={plot.x0-8} y={t.y} textAnchor="end" dominantBaseline="middle">{t.label}</text>)}
     {view.xTicks.map(t=><text key={`x${t.t}`} x={t.x} y={plot.y1+18} textAnchor="middle">{t.label}</text>)}
    </g>
    {selected!==null&&<line className="chartGuide" x1={xs[selected]} x2={xs[selected]} y1={plot.y0} y2={plot.y1}/>}
    <polyline className="chartLine" points={xs.map((x,i)=>`${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')}/>
    {points.length<=MAX_DOTS&&<g className="chartDots">{points.map((q,i)=><circle key={i} className={q.kind==='start'?'start':''} cx={xs[i]} cy={ys[i]} r={2.6}/>)}</g>}
    <g className="chartPeakMark"><circle cx={xs[peak]} cy={ys[peak]} r={6.5}/><circle className="core" cx={xs[peak]} cy={ys[peak]} r={2.8}/></g>
    {selected!==null&&<circle className="chartSelected" cx={xs[selected]} cy={ys[selected]} r={5}/>}
   </svg>
  </div>
  <p className="chartHint">Tap or hover a point to see its Elo, time and change. Times are in your timezone.</p>
 </div>
}
