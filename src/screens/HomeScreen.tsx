import { Camera, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MODES, modeInfo, rpc, supabase } from '../lib'
import type { Mode, Profile, Rating, TableRow } from '../lib'
import { QrScanner } from '../QrScanner'
import {
  Avatar,
  Button,
  CornerIndex,
  MODE_CARD,
  MiniModeCard,
  STATUS_TEXT,
  Sheet,
  SuitBox,
  dateTime,
  formatRating,
  listNames,
  statusOf,
  useBlue,
} from '../ui'
import type { Action, TableStatus } from '../ui'

const STATUS_ORDER: Record<TableStatus, number> = { results: 0, playing: 1, lobby: 2, closed: 3 }

// Closed tables stay on Home for a few days, so returning players see why their table is gone.
const CLOSED_SHOWN_MS = 3 * 86400000

const greeting = () => {
  const h = new Date().getHours()
  return h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 18 ? 'Good afternoon' : 'Good evening'
}

export function HomeScreen({
  me,
  profile,
  openTable,
  openRankings,
  action,
  busy,
}: {
  me: string
  profile: Profile | null
  openTable: (id: string) => void
  openRankings: () => void
  action: Action
  busy: boolean
}) {
  const [mode, setMode] = useState<Mode>('natural'),
    [expanded, setExpanded] = useState(false),
    [join, setJoin] = useState(''),
    [tables, setTables] = useState<TableRow[]>([]),
    [ratings, setRatings] = useState<Rating[]>([])
  const [loaded, setLoaded] = useState(false),
    [front, setFront] = useState(0)
  const blue = useBlue(),
    [people, setPeople] = useState<Record<string, { id: string; name: string }[]>>({}),
    [modeSheet, setModeSheet] = useState(false)
  const load = useCallback(async () => {
    const { data: members } = await supabase
      .from('table_members')
      .select('table_id')
      .eq('user_id', me)
      .eq('is_active', true)
    const ids = (members || []).map(m => m.table_id)
    const [{ data: tt }, { data: rr }] = await Promise.all([
      ids.length
        ? supabase
            .from('tables')
            .select('*')
            .in('id', ids)
            .or(`closed_at.is.null,closed_at.gt."${new Date(Date.now() - CLOSED_SHOWN_MS).toISOString()}"`)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),
      supabase.from('ratings').select('*').eq('user_id', me),
    ])
    setTables((tt || []) as TableRow[])
    setRatings((rr || []) as Rating[])
    setLoaded(true)
    // Both themes name the players at each table ("With Masha and Grisha"), so it also loads who sits at each table.
    if (ids.length) {
      const { data: seated } = await supabase
        .from('table_members')
        .select('table_id,user_id')
        .in('table_id', ids)
        .eq('is_active', true)
        .order('joined_at')
      const userIds = [...new Set((seated || []).map(s => s.user_id))]
      const { data: pp } = userIds.length
        ? await supabase.from('profiles').select('id,username').in('id', userIds)
        : { data: [] }
      const names = Object.fromEntries(
        ((pp || []) as { id: string; username: string }[]).map(p => [p.id, p.username]),
      )
      const byTable: Record<string, { id: string; name: string }[]> = {}
      for (const s of seated || [])
        (byTable[s.table_id] ||= []).push({ id: s.user_id, name: names[s.user_id] || 'Player' })
      setPeople(byTable)
    }
  }, [me])
  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 12000)
    return () => clearInterval(id)
  }, [load])
  const create = () =>
    void action(async () => {
      const id = await rpc<string>('create_table', { p_mode: mode, p_group: null })
      openTable(id)
    })
  const joinRoom = () =>
    void action(async () => {
      if (!join.trim()) throw new Error('Enter a table code')
      const id = await rpc<string>('join_table', { p_code: join })
      openTable(id)
    })
  const [scanning, setScanning] = useState(false)
  const scanned = (code: string) => {
    setScanning(false)
    setJoin(code)
    void action(async () => {
      openTable(await rpc<string>('join_table', { p_code: code }))
    })
  }
  // Tables that need attention first (results, then playing, then lobby); the sort is stable, so newest stays first within a status.
  const sorted = useMemo(
    () => [...tables].sort((a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)]),
    [tables],
  )
  const hand = sorted.length,
    idx = hand ? front % hand : 0,
    current = sorted[idx],
    next = hand > 1 ? sorted[(idx + 1) % hand] : undefined
  const picked = modeInfo(mode),
    played = ratings.some(r => r.games > 0)
  // New players see all four mode cards; everyone else gets the compact picker behind "Change".
  const showModes = expanded || (loaded && hand === 0)
  const modeGrid = useRef<HTMLDivElement>(null),
    changeButton = useRef<HTMLButtonElement>(null),
    returnFocus = useRef(false)
  useEffect(() => {
    if (expanded) modeGrid.current?.querySelector<HTMLButtonElement>('.on')?.focus()
    else if (returnFocus.current) {
      returnFocus.current = false
      changeButton.current?.focus()
    }
  }, [expanded])
  const pickMode = (m: Mode) => {
    setMode(m)
    if (expanded) {
      returnFocus.current = true
      setExpanded(false)
    }
  }
  // Horizontal swipe on the hand of table cards; a swipe must not also count as a tap on the card underneath.
  const swipeStart = useRef<number | null>(null),
    swiped = useRef(false)
  // The release is read from window: a mouse (unlike touch) is not captured, so it may be released outside the hand.
  const startSwipe = (x: number) => {
    swipeStart.current = x
    swiped.current = false
    const stop = () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const up = (e: PointerEvent) => {
      stop()
      const start = swipeStart.current
      swipeStart.current = null
      if (start === null) return
      const dx = e.clientX - start
      swiped.current = Math.abs(dx) > 40
      if (swiped.current && hand > 1) setFront((idx + (dx < 0 ? 1 : hand - 1)) % hand)
    }
    const cancel = () => {
      stop()
      swipeStart.current = null
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }
  const describe = (t: TableRow) =>
    `${modeInfo(t.mode).name}, table ${t.code}, ${STATUS_TEXT[statusOf(t)].toLowerCase()}`
  const lead = blue ? sorted[0] : current
  const status = lead
    ? lead.closed_at
      ? 'Your table closed after 2 hours without activity. Start a new one whenever you play again.'
      : lead.status === 'results'
        ? 'Your table is waiting for your vote.'
        : lead.status === 'playing'
          ? 'Your game is still going.'
          : 'Your table is waiting for players.'
    : !loaded
      ? ''
      : played
        ? "No open tables right now. Start one, or join a friend's."
        : "No tables yet. Pick a game to start one, or join a friend's."
  // Card theme: just the players, under the table code (the card already shows the status).
  const playersText = (t: TableRow) => {
    if (!people[t.id]) return ''
    const others = people[t.id].filter(p => p.id !== me).map(p => p.name)
    return others.length ? `With ${listNames(others)}` : 'Just you so far'
  }
  const withText = (t: TableRow) => {
    const others = (people[t.id] || []).filter(p => p.id !== me).map(p => p.name)
    return t.closed_at
      ? `Closed ${dateTime(t.closed_at)}`
      : people[t.id]
        ? others.length
          ? `With ${listNames(others)}`
          : 'Just you so far'
        : STATUS_TEXT[t.status]
  }
  const joinSection = (
    <section aria-labelledby="join-title">
      <h2 id="join-title" className="sectionTitle">
        Join a table
      </h2>
      <form
        onSubmit={e => {
          e.preventDefault()
          joinRoom()
        }}
      >
        <label className="field" htmlFor="join-code">
          Table code
        </label>
        <div className="joinRow">
          <input
            id="join-code"
            className="codeInput"
            placeholder="8 characters"
            maxLength={8}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-describedby="join-hint"
            value={join}
            onChange={e => setJoin(e.target.value.toUpperCase())}
          />
          <Button type="submit" kind="outline" disabled={busy || !join.trim()}>
            Join
          </Button>
        </div>
        <p id="join-hint" className="fieldHint">
          Type the 8-character code from the host, or scan the QR code on their phone.
        </p>
      </form>
      <Button kind="secondary" className="wide scanButton" onClick={() => setScanning(true)}>
        <Camera size={16} /> Scan QR code
      </Button>
      <Sheet open={scanning} title="Scan QR code" onClose={() => setScanning(false)}>
        {scanning && <QrScanner onCode={scanned} />}
      </Sheet>
    </section>
  )
  const greetingBlock = (
    <section className="greeting">
      <h1>
        {greeting()}, {profile?.username || 'friend'}
      </h1>
      {status && <p>{status}</p>}
    </section>
  )
  if (blue)
    return (
      <div className="stack home pageEntry">
        {greetingBlock}
        {lead && (
          <section className="stack sm" aria-labelledby="tables-title">
            <div className="sectionHeading">
              <h2 id="tables-title" className="listLabel">
                Your tables
              </h2>
              <button
                className="iconButton"
                aria-label="Refresh tables"
                title="Refresh tables"
                onClick={() => void load()}
              >
                <RefreshCw size={18} />
              </button>
            </div>
            <div className="summaryCard">
              <div className="summaryTop">
                <span className={`statusChip status-${statusOf(lead)}`}>{STATUS_TEXT[statusOf(lead)]}</span>
                {people[lead.id] && (
                  <span className="avatarStack" aria-hidden="true">
                    {people[lead.id].slice(0, 4).map(p => (
                      <Avatar key={p.id} id={p.id} name={p.name} me={me} size="sm" />
                    ))}
                  </span>
                )}
              </div>
              <div>
                <h3 className="summaryTitle">{modeInfo(lead.mode).name}</h3>
                <p className="summaryMeta">
                  Table <span className="mono">{lead.code}</span> · {withText(lead)}
                </p>
              </div>
              <Button
                className="wide"
                kind={lead.closed_at ? 'outline' : 'primary'}
                onClick={() => openTable(lead.id)}
              >
                {lead.closed_at ? 'View closed table' : 'Return to table'}
              </Button>
            </div>
            {sorted.length > 1 && (
              <div>
                <h3 className="listLabel">Other tables</h3>
                <ul className="rowList">
                  {sorted.slice(1).map(t => (
                    <li key={t.id}>
                      <button className="listRow" onClick={() => openTable(t.id)}>
                        <span className="rowText">
                          <b>{modeInfo(t.mode).name}</b>
                          <small>
                            Table <span className="mono">{t.code}</span> · {STATUS_TEXT[statusOf(t)]}
                          </small>
                        </span>
                        <span className="chevron" aria-hidden="true">
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
        <section className="stack sm" aria-labelledby="create-title">
          <h2 id="create-title">Start a table</h2>
          <button
            className="modeButton"
            aria-haspopup="dialog"
            aria-label={`Game mode: ${picked.name}. Change`}
            onClick={() => setModeSheet(true)}
          >
            <span className="modeButtonMain">
              <SuitBox mode={mode} />
              <span className="rowText">
                <b>{picked.name}</b>
                <small>
                  {picked.detail} ·{' '}
                  <span className="nowrap">
                    {picked.min}–{picked.max} players
                  </span>
                </small>
              </span>
            </span>
            <span className="modeButtonAction" aria-hidden="true">
              Change
            </span>
          </button>
          <Button onClick={create} disabled={busy} className="wide">
            Create table
          </Button>
        </section>
        {joinSection}
        <section aria-labelledby="ratings-title">
          <div className="sectionHeading">
            <h2 id="ratings-title">Your ratings</h2>
            <button className="linkButton plain" onClick={openRankings}>
              See rankings <span aria-hidden="true">›</span>
            </button>
          </div>
          <ul className="rowList">
            {MODES.map(m => {
              const r = ratings.find(r => r.mode === m.id),
                games = r?.games || 0
              return (
                <li key={m.id} className="rateRow">
                  <span className={`rowSuit ${MODE_CARD[m.id].red ? 'red' : ''}`} aria-hidden="true">
                    {MODE_CARD[m.id].suit}
                  </span>
                  <span className="rowText">
                    <b>{m.name}</b>
                    <small>{games ? `${games} ${games === 1 ? 'game' : 'games'}` : 'No games yet'}</small>
                  </span>
                  <strong className={`rowValue ${games ? '' : 'quiet'}`}>
                    {formatRating(r?.rating ?? 1200)}
                  </strong>
                </li>
              )
            })}
          </ul>
        </section>
        <Sheet open={modeSheet} title="Game mode" onClose={() => setModeSheet(false)}>
          <div className="sheetOptions" role="group" aria-label="Game mode">
            {MODES.map(m => (
              <button
                key={m.id}
                aria-pressed={mode === m.id}
                className={`sheetOption ${mode === m.id ? 'on' : ''}`}
                onClick={() => {
                  setMode(m.id)
                  setTimeout(() => setModeSheet(false), 200)
                }}
              >
                <SuitBox mode={m.id} />
                <span className="rowText">
                  <b>
                    {m.name}
                    {m.id === 'natural' && <span className="optionNote"> · default</span>}
                  </b>
                  <small>
                    {m.detail} · {m.min}–{m.max} players
                  </small>
                </span>
                <span className="radioDot" aria-hidden="true" />
              </button>
            ))}
          </div>
        </Sheet>
      </div>
    )
  return (
    <div className="stack home pageEntry">
      {greetingBlock}
      <div className={`homeGrid ${current ? 'withHand' : ''}`}>
        {current && (
          <section aria-labelledby="tables-title">
            <div className="sectionHeading">
              <h2 id="tables-title">Your tables</h2>
              <span className="handMeta">
                {hand > 1 && (
                  <span>
                    Swipe · {idx + 1} of {hand}
                  </span>
                )}
                <button
                  className="iconButton"
                  aria-label="Refresh tables"
                  title="Refresh tables"
                  onClick={() => void load()}
                >
                  <RefreshCw size={18} />
                </button>
              </span>
            </div>
            <div
              className="hand"
              onPointerDown={e => startSwipe(e.clientX)}
              onClickCapture={e => {
                if (swiped.current) {
                  swiped.current = false
                  e.preventDefault()
                  e.stopPropagation()
                }
              }}
            >
              {next && (
                <button
                  className="tableCard back"
                  aria-label={`Show ${describe(next)}`}
                  onClick={() => setFront((idx + 1) % hand)}
                >
                  <CornerIndex mode={next.mode} />
                  <span className="tableName">{modeInfo(next.mode).name}</span>
                  <span>{next.code}</span>
                  <span>{STATUS_TEXT[statusOf(next)]}</span>
                  {playersText(next) && <span className="tablePlayers">{playersText(next)}</span>}
                </button>
              )}
              <div className="tableCard front" key={current.id}>
                <CornerIndex mode={current.mode} />
                <CornerIndex mode={current.mode} flip />
                <div className="tableCardBody">
                  <span className={`tableStatus status-${statusOf(current)}`}>
                    {STATUS_TEXT[statusOf(current)]}
                  </span>
                  <h3>{modeInfo(current.mode).name}</h3>
                  <span className="tableCode">Table {current.code}</span>
                  {playersText(current) && <span className="tablePlayers">{playersText(current)}</span>}
                </div>
                <Button
                  kind={current.closed_at ? 'outline' : 'primary'}
                  onClick={() => openTable(current.id)}
                >
                  {current.closed_at ? 'View closed table' : 'Return to table'}
                </Button>
              </div>
            </div>
            {hand > 1 && (
              <div className="handDots">
                {sorted.map((t, i) => (
                  <button
                    key={t.id}
                    className={i === idx ? 'on' : ''}
                    aria-label={`Show ${describe(t)}`}
                    aria-current={i === idx || undefined}
                    onClick={() => setFront(i)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
        <div className="homeActions">
          <section aria-labelledby="create-title">
            <h2 id="create-title" className="sectionTitle">
              Start a table
            </h2>
            <div className={`startPanel ${showModes ? 'open' : ''}`}>
              {showModes ? (
                <div className="modeGrid" role="group" aria-label="Game mode" ref={modeGrid}>
                  {MODES.map(m => (
                    <button
                      key={m.id}
                      aria-pressed={mode === m.id}
                      className={`modeCard ${mode === m.id ? 'on' : ''} ${MODE_CARD[m.id].red ? 'red' : ''}`}
                      onClick={() => pickMode(m.id)}
                    >
                      <CornerIndex mode={m.id} />
                      {mode === m.id && (
                        <span className="chosen" aria-hidden="true">
                          ✓ Selected
                        </span>
                      )}
                      <span className="modeSuit" aria-hidden="true">
                        {MODE_CARD[m.id].suit}
                      </span>
                      <span className="modeName">{m.name}</span>
                      <span className="modeDetail">
                        {m.detail}
                        <br />
                        <span className="nowrap">
                          {m.min}–{m.max} players
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="modeSummary">
                  <MiniModeCard mode={mode} />
                  <div className="modeText">
                    <b>{picked.name}</b>
                    <small>
                      {picked.detail} ·{' '}
                      <span className="nowrap">
                        {picked.min}–{picked.max} players
                      </span>
                    </small>
                  </div>
                  <button
                    ref={changeButton}
                    className="linkButton"
                    aria-label={`Change game mode, currently ${picked.name}`}
                    onClick={() => setExpanded(true)}
                  >
                    Change
                  </button>
                </div>
              )}
              <Button onClick={create} disabled={busy} className="wide">
                Create {picked.name} table
              </Button>
            </div>
          </section>
          {joinSection}
        </div>
      </div>
      {played ? (
        <section aria-labelledby="ratings-title">
          <div className="sectionHeading">
            <h2 id="ratings-title">Your ratings</h2>
            <button className="linkButton" onClick={openRankings}>
              See rankings
            </button>
          </div>
          <ul className="rateList">
            {MODES.map(m => {
              const r = ratings.find(r => r.mode === m.id),
                games = r?.games || 0
              return (
                <li
                  key={m.id}
                  className={`rateItem ${games ? '' : 'unplayed'} ${MODE_CARD[m.id].red ? 'red' : ''}`}
                >
                  <span className="rateName">
                    <span className="rateNameSuit" aria-hidden="true">
                      {MODE_CARD[m.id].suit}
                    </span>
                    {m.name}
                  </span>
                  <span className="rateCard">
                    <span className="rateSuit" aria-hidden="true">
                      {MODE_CARD[m.id].suit}
                    </span>
                    <b className="rateValue">{formatRating(r?.rating ?? 1200)}</b>
                    <small>
                      {games} {games === 1 ? 'game' : 'games'}
                    </small>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : (
        loaded && (
          <p className="startsAt">
            <span>Everyone starts at 1,200 in each mode.</span>
            <button className="linkButton" onClick={openRankings}>
              Rankings
            </button>
          </p>
        )
      )}
    </div>
  )
}
