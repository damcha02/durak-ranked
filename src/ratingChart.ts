// Rating-over-time chart (Profile → Statistics): data, axes and layout. Pure functions, rendered by
// RatingChart.tsx. The data is public.my_rating_history: the server's running ledger balance per rated
// game, already in rating-replay order, so nothing here recalculates Elo.
// Times are shown in the device's local timezone (Date's local getters/setters and Intl defaults).

export type RatedGame={game_id:string;round_id:string;slot:number;games_in_round:number;state:'confirmed'|'tied';
 played_at:string;finalized_at:string|null;delta:number|string;rating_before:number|string;rating_after:number|string}
/** The first point is the 1200 start; every other point is one rated game, at its round's start time. */
export type ChartPoint={kind:'start'|'game';t:number;rating:number;delta:number;game?:RatedGame}

export const START_RATING=1200
const cents=(x:number|string)=>Math.round(Number(x)*100)

/** Start point, then one point per game in the order given (the server's replay order). Empty without games. */
export function buildSeries(games:RatedGame[]):ChartPoint[]{
 if(!games.length)return []
 return [{kind:'start',t:Date.parse(games[0].played_at),rating:START_RATING,delta:0},
  ...games.map(g=>({kind:'game' as const,t:Date.parse(g.played_at),rating:cents(g.rating_after)/100,delta:cents(g.delta)/100,game:g}))]
}

/** Index of the highest rating, the 1200 start included; on equal highs, the first time it was reached. */
export function peakIndex(points:ChartPoint[]):number{
 let best=-1
 points.forEach((p,i)=>{if(best<0||cents(p.rating)>cents(points[best].rating))best=i})
 return best
}

/** A step of 1, 2 or 5 × 10^k (2.5 × 10^k from 25 up), never below 1 Elo, so labels need no decimals. */
export function niceStep(raw:number):number{
 if(!(raw>0))return 1
 const exp=Math.pow(10,Math.floor(Math.log10(raw))),f=raw/exp
 const steps=exp>=10?[1,2,2.5,5,10]:[1,2,5,10]
 return Math.max(1,steps.find(s=>f<=s)!*exp)
}
/** Elo axis: the rating range with some padding (never forced to 0), rounded out to whole steps. */
export function ratingAxis(values:number[],maxTicks=5){
 let lo=Math.min(...values),hi=Math.max(...values)
 const pad=Math.max((hi-lo)*0.08,5)
 lo-=pad;hi+=pad
 const step=niceStep((hi-lo)/Math.max(1,maxTicks-1))
 const min=Math.floor(lo/step)*step,max=Math.ceil(hi/step)*step
 const ticks:number[]=[]
 for(let v=min;v<=max+step/1000;v+=step)ticks.push(Math.round(v*100)/100)
 return {min,max,step,ticks}
}
export const formatElo=(r:number,decimals=0)=>r.toLocaleString(undefined,{minimumFractionDigits:decimals,maximumFractionDigits:decimals})

type Unit='minute'|'hour'|'day'|'month'|'year'
export type TimeStep={unit:Unit;n:number}
const MINUTE=60_000,HOUR=60*MINUTE,DAY=24*HOUR
const APPROX:Record<Unit,number>={minute:MINUTE,hour:HOUR,day:DAY,month:30.44*DAY,year:365.25*DAY}
export const TIME_STEPS:TimeStep[]=[
 {unit:'minute',n:1},{unit:'minute',n:5},{unit:'minute',n:15},{unit:'minute',n:30},
 {unit:'hour',n:1},{unit:'hour',n:3},{unit:'hour',n:6},{unit:'hour',n:12},
 {unit:'day',n:1},{unit:'day',n:2},{unit:'day',n:3},{unit:'day',n:7},{unit:'day',n:14},
 {unit:'month',n:1},{unit:'month',n:3},{unit:'month',n:6},{unit:'year',n:1},{unit:'year',n:2},{unit:'year',n:5}]
/** Local-time floor to a whole step (local midnight for days, the 1st for months). */
function floorTo(t:number,{unit,n}:TimeStep){
 const d=new Date(t)
 if(unit==='minute'){d.setSeconds(0,0);d.setMinutes(Math.floor(d.getMinutes()/n)*n)}
 else if(unit==='hour'){d.setMinutes(0,0,0);d.setHours(Math.floor(d.getHours()/n)*n)}
 else{d.setHours(0,0,0,0);if(unit==='month')d.setDate(1);else if(unit==='year')d.setMonth(0,1)
  if(unit==='month')d.setMonth(Math.floor(d.getMonth()/n)*n);if(unit==='year')d.setFullYear(Math.floor(d.getFullYear()/n)*n)}
 return d.getTime()
}
function addStep(t:number,{unit,n}:TimeStep){
 const d=new Date(t)
 if(unit==='minute')d.setMinutes(d.getMinutes()+n);else if(unit==='hour')d.setHours(d.getHours()+n)
 else if(unit==='day')d.setDate(d.getDate()+n);else if(unit==='month')d.setMonth(d.getMonth()+n);else d.setFullYear(d.getFullYear()+n)
 return d.getTime()
}
function ticksOf(t0:number,t1:number,step:TimeStep){
 // Steps of several days count from the first local midnight in range, so any span of n days has a tick.
 let t=floorTo(t0,step.unit==='day'?{unit:'day',n:1}:step)
 if(step.unit==='day'&&t<t0)t=addStep(t,{unit:'day',n:1})
 const ticks:number[]=[]
 for(;t<=t1;t=addStep(t,step))if(t>=t0)ticks.push(t)
 return ticks
}
/**
 * The finest step with at most maxTicks ticks in [t0, t1], preferring one with at least two, and those
 * ticks in local time. Ticks are counted, not estimated: a coarse step can leave a short span bare.
 */
export function timeAxis(t0:number,t1:number,maxTicks:number){
 const span=Math.max(t1-t0,MINUTE),limit=Math.max(1,maxTicks)
 let fallback:{step:TimeStep;ticks:number[]}|null=null
 for(const step of TIME_STEPS){
  if(span/(APPROX[step.unit]*step.n)>limit+2)continue // far too many; skip without generating them
  const ticks=ticksOf(t0,t1,step)
  if(ticks.length>limit)continue
  if(ticks.length>=Math.min(2,limit))return {step,ticks}
  if(ticks.length&&!fallback)fallback={step,ticks}
 }
 if(fallback)return fallback
 const step=TIME_STEPS[TIME_STEPS.length-1]
 return {step,ticks:ticksOf(t0,t1,step)}
}
const isMidnight=(t:number)=>{const d=new Date(t);return d.getHours()===0&&d.getMinutes()===0}
/** Axis label: times within a day (the date at local midnight), dates, months; the year only when the axis spans years. */
export function timeLabel(t:number,step:TimeStep,multiYear:boolean):string{
 const d=new Date(t)
 if((step.unit==='minute'||step.unit==='hour')&&!isMidnight(t))return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})
 if(step.unit==='minute'||step.unit==='hour'||step.unit==='day')return d.toLocaleDateString(undefined,{month:'short',day:'numeric',...(multiYear?{year:'2-digit'}:{})})
 if(step.unit==='month')return d.toLocaleDateString(undefined,{month:'short',...(multiYear?{year:'numeric'}:{})})
 return String(d.getFullYear())
}
/** Date and time of a point, for the readout. The year is added when it is not the current one. */
export function pointTime(t:number,now=Date.now()):string{
 const d=new Date(t),sameYear=d.getFullYear()===new Date(now).getFullYear()
 return d.toLocaleString(undefined,{month:'short',day:'numeric',...(sameYear?{}:{year:'numeric'}),hour:'2-digit',minute:'2-digit'})
}
export function pointDate(t:number):string{return new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}

/** Width estimate of an axis label in px (12px sans-serif), used to keep labels from overlapping. */
export const labelWidth=(s:string)=>Math.ceil(s.length*6.6)+2
export const PAD={top:14,right:12,bottom:30,left:48}
export const LABEL_GAP=8
/** Data stays this far inside the plot, so markers never sit on the Elo labels or the right edge. */
export const INSET=8

export type Layout={
 width:number;height:number;plot:{x0:number;x1:number;y0:number;y1:number}
 xs:number[];ys:number[];yTicks:{v:number;y:number;label:string}[];xTicks:{t:number;x:number;label:string}[]
 peak:number;domain:{t0:number;t1:number}
}
/**
 * Positions every point. x is the game's time on a linear time axis; the 1200 start sits at the left end,
 * just before the first game. Games at the same time (both games of a parallel round, or several in one
 * minute) are spread a few pixels apart in replay order, so each stays visible and tappable.
 */
export function layout(points:ChartPoint[],width:number,height:number):Layout{
 const plot={x0:PAD.left,x1:width-PAD.right,y0:PAD.top,y1:height-PAD.bottom},w=plot.x1-plot.x0
 const games=points.filter(p=>p.kind==='game'),first=games[0]?.t??0,last=games[games.length-1]?.t??0
 const pad=Math.max((last-first)*0.06,30*MINUTE),t0=first-pad,t1=last+pad
 const left=plot.x0+INSET,right=plot.x1-INSET
 const sx=(t:number)=>left+(t-t0)/(t1-t0)*(right-left)
 const xs=points.map(p=>p.kind==='start'?left:sx(p.t))
 const gap=Math.min(6,w/(2*Math.max(1,points.length)))
 for(let i=1;i<xs.length;i++)xs[i]=Math.max(xs[i],xs[i-1]+gap)
 if(xs.length)xs[xs.length-1]=Math.min(xs[xs.length-1],right)
 for(let i=xs.length-2;i>=0;i--)xs[i]=Math.min(xs[i],xs[i+1]-gap)

 const axis=ratingAxis(points.map(p=>p.rating),Math.max(3,Math.min(6,Math.floor((plot.y1-plot.y0)/36)+1)))
 const sy=(r:number)=>plot.y1-(r-axis.min)/(axis.max-axis.min)*(plot.y1-plot.y0)
 const ys=points.map(p=>sy(p.rating))
 const yTicks=axis.ticks.map(v=>({v,y:sy(v),label:formatElo(v)}))

 // Allow roughly one label per 56px, then drop any label that would still touch its neighbour or the edges.
 const {step,ticks}=timeAxis(t0,t1,Math.max(2,Math.floor(w/56)))
 const multiYear=new Date(t0).getFullYear()!==new Date(t1).getFullYear()
 const xTicks:{t:number;x:number;label:string}[]=[]
 let end=-Infinity
 for(const t of ticks){
  const x=sx(t),label=timeLabel(t,step,multiYear),half=labelWidth(label)/2
  if(x-half<end+LABEL_GAP||x-half<0||x+half>width)continue
  xTicks.push({t,x,label});end=x+half
 }
 return {width,height,plot,xs,ys,yTicks,xTicks,peak:peakIndex(points),domain:{t0,t1}}
}

/** The point whose x is closest to px (xs ascending). */
export function nearestIndex(xs:number[],px:number):number{
 if(!xs.length)return -1
 let lo=0,hi=xs.length-1
 while(lo<hi){const mid=(lo+hi)>>1;if(xs[mid]<px)lo=mid+1;else hi=mid}
 return lo>0&&px-xs[lo-1]<=xs[lo]-px?lo-1:lo
}
