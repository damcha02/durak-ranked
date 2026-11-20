import {
  ArrowRight,
  ChevronDown,
  Clock3,
  Copy,
  Crown,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MODES, modeInfo, rpc, supabase } from '../lib'
import type { Game, Member, Profile, TableRow, VoteTotal } from '../lib'
import { lossChances } from '../lossChance'
import { pickVerdicts } from '../verdict'
import {
  APP_NAME,
  Avatar,
  Button,
  ChanceLine,
  MODE_CARD,
  PlayerName,
  STATUS_TEXT,
  Sheet,
  Stars,
  dateTime,
  deltaClass,
  listNames,
  signed,
  statusOf,
  useBlue,
  useReputation,
} from '../ui'
import type { Action } from '../ui'

// The vote countdown ticks on its own, once per second on the second boundary, so only this number re-renders.
function VoteTimer({ deadline }: { deadline: string }) {
  const end = new Date(deadline).getTime(),
    left = () => Math.max(0, Math.ceil((end - Date.now()) / 1000))
  const [secs, setSecs] = useState(left)
  useEffect(() => {
    let t = 0
    const tick = () => {
      const s = left()
      setSecs(s)
      if (s > 0) t = window.setTimeout(tick, (end - Date.now()) % 1000 || 1000)
    }
    tick()
    return () => clearTimeout(t)
  }, [end])
  return (
    <div className={`voteTimer ${secs <= 10 ? 'low' : ''}`} role="timer" aria-label={`${secs} seconds left`}>
      <b>{secs}</b>
      <span>sec</span>
    </div>
  )
}

// "Vote closed" pop-up (see pickVerdicts): shown once per game per session.
const shownVerdicts = new Set<string>()
type Ballot = { voter_id: string; nominee_id: string }
type Verdict = { game: Game; delta: number | null; ballots: Ballot[] }

export function TableScreen({
  tableId,
  me,
  action,
  busy,
  showChances,
  openTable,
  openHistory,
  onLeave,
}: {
  tableId: string
  me: string
  action: Action
  busy: boolean
  showChances: boolean
  openTable: (id: string) => void
  openHistory: () => void
  onLeave: () => void
}) {
  const [table, setTable] = useState<TableRow | null>(null),
    [members, setMembers] = useState<Member[]>([]),
    [profiles, setProfiles] = useState<Record<string, Profile>>({}),
    [players, setPlayers] = useState<string[]>([]),
    [games, setGames] = useState<Game[]>([]),
    [totals, setTotals] = useState<VoteTotal[]>([]),
    [historyGames, setHistoryGames] = useState<Game[]>([]),
    [cases, setCases] = useState<{ id: string; game_id: string; state: string; created_at: string }[]>([]),
    [yesCounts, setYesCounts] = useState<Record<string, number>>({}),
    [showQR, setShowQR] = useState(false),
    [mySelections, setMySelections] = useState<Record<string, string>>({}),
    [showHistory, setShowHistory] = useState(false),
    [ballots, setBallots] = useState<Record<string, { voter_id: string; nominee_id: string }[]>>({}),
    [myFriends, setMyFriends] = useState<{ id: string; name: string }[]>([]),
    [verdicts, setVerdicts] = useState<Verdict[]>([])
  // Ids the realtime listeners watch (comma-joined, so an unchanged set does not resubscribe).
  const [watchRounds, setWatchRounds] = useState(''),
    [watchGames, setWatchGames] = useState(''),
    [watchHistory, setWatchHistory] = useState('')
  const blue = useBlue(),
    [shareNote, setShareNote] = useState('')
  // Ratings behind the losing-chance estimate, tagged with the round they belong to (null = lobby preview).
  const [chanceInput, setChanceInput] = useState<{
    round: string | null
    ratings: Record<string, number | null>
  } | null>(null)
  const leaveRef = useRef(onLeave)
  leaveRef.current = onLeave
  const fetchTable = useCallback(async () => {
    const { data: tt, error: te } = await supabase.from('tables').select('*').eq('id', tableId).single()
    if (te?.code === 'PGRST116') {
      leaveRef.current()
      return
    }
    if (te) throw te
    const t = tt as TableRow
    setTable(t)
    const [{ data: mm }, { data: allR }] = await Promise.all([
      supabase
        .from('table_members')
        .select('*')
        .eq('table_id', tableId)
        .eq('is_active', true)
        .order('joined_at'),
      supabase
        .from('rounds')
        .select('id')
        .eq('table_id', tableId)
        .order('started_at', { ascending: false })
        .limit(12),
    ])
    setMembers((mm || []) as Member[])
    if (t.host_id === me && t.status === 'lobby' && !t.closed_at) {
      const { data: ff } = await supabase.from('friendships').select('user_a,user_b').eq('status', 'accepted')
      const fids = (ff || []).map(f => (f.user_a === me ? f.user_b : f.user_a))
      if (fids.length) {
        const { data: pp } = await supabase.from('profiles').select('id,username').in('id', fids)
        setMyFriends(
          ((pp || []) as { id: string; username: string }[])
            .map(p => ({ id: p.id, name: p.username }))
            .sort((x, y) => x.name.localeCompare(y.name)),
        )
      } else setMyFriends([])
    }
    const rids = (allR || []).map(r => r.id)
    setWatchRounds(rids.join(','))
    const seated = (mm || []).map(m => m.user_id),
      none = Promise.resolve({ data: [], error: null })
    const [{ data: rp }, { data: gg }, { data: historic }, chanceRows] = await Promise.all([
      t.current_round_id
        ? supabase.from('round_players').select('user_id').eq('round_id', t.current_round_id)
        : Promise.resolve({ data: [] }),
      t.current_round_id
        ? supabase.from('round_games').select('*').eq('round_id', t.current_round_id).order('slot')
        : Promise.resolve({ data: [] }),
      rids.length
        ? supabase
            .from('round_games')
            .select('*')
            .in('round_id', rids)
            .order('finalized_at', { ascending: false })
            .limit(24)
        : Promise.resolve({ data: [] }),
      // Losing chance: live ratings of whoever is seated in the lobby; once the round is locked, the ratings stored when it started.
      // A failed read (e.g. before the snapshot migration is applied) only hides the estimate.
      t.status === 'lobby'
        ? seated.length
          ? supabase.from('ratings').select('user_id,rating').eq('mode', t.mode).in('user_id', seated)
          : none
        : t.status === 'playing' && t.current_round_id
          ? supabase
              .from('round_players')
              .select('user_id,rating:rating_at_start')
              .eq('round_id', t.current_round_id)
          : none,
    ])
    setChanceInput(
      chanceRows.error || t.status === 'results'
        ? null
        : {
            round: t.status === 'lobby' ? null : t.current_round_id,
            ratings: Object.fromEntries((chanceRows.data || []).map(r => [r.user_id, r.rating])),
          },
    )
    setPlayers((rp || []).map(x => x.user_id))
    setGames((gg || []) as Game[])
    setHistoryGames((historic || []) as Game[])
    const allIds = [
      ...(mm || []).map(m => m.user_id),
      ...(rp || []).map(p => p.user_id),
      ...(historic || []).flatMap(g => g.loser_ids),
    ]
    if (allIds.length) {
      const { data: people } = await supabase
        .from('profiles')
        .select('*')
        .in('id', [...new Set(allIds)])
      setProfiles(Object.fromEntries(((people || []) as Profile[]).map(p => [p.id, p])))
    }
    const gameIds = (gg || []).map(g => g.id)
    setWatchGames(gameIds.join(','))
    setWatchHistory((historic || []).map(g => g.id).join(','))
    if (gameIds.length) {
      const { data: voteData } = await supabase.from('vote_totals').select('*').in('game_id', gameIds)
      setTotals((voteData || []) as VoteTotal[])
    } else setTotals([])
    const histIds = (historic || []).map(g => g.id)
    const votesByGame: Record<string, Ballot[]> = {}
    if (histIds.length) {
      const { data: vv } = await supabase
        .from('game_votes')
        .select('game_id,voter_id,nominee_id')
        .in('game_id', histIds)
      for (const v of vv || [])
        (votesByGame[v.game_id] ||= []).push({ voter_id: v.voter_id, nominee_id: v.nominee_id })
      setBallots(votesByGame)
      const { data: cc } = await supabase.from('reversal_cases').select('*').in('game_id', histIds)
      setCases((cc || []) as typeof cases)
      const cs = (cc || []).filter(c => c.state === 'open').map(c => c.id)
      if (cs.length) {
        const { data: vv } = await supabase.from('reversal_votes').select('case_id,approve').in('case_id', cs)
        const counts: Record<string, number> = {}
        for (const v of vv || []) if (v.approve) counts[v.case_id] = (counts[v.case_id] || 0) + 1
        setYesCounts(counts)
      } else setYesCounts({})
    } else setCases([])
    // rids is newest first, so rids[0] is the latest round: a result from before it never pops up.
    const fresh = pickVerdicts((historic || []) as Game[], rids[0], Date.now(), shownVerdicts)
    // A new round makes the older results still waiting in the queue stale; the one on screen stays.
    setVerdicts(v => v.filter((x, i) => i === 0 || x.game.round_id === rids[0]))
    if (fresh.length) {
      for (const g of fresh) shownVerdicts.add(g.id)
      const { data: ll } = await supabase
        .from('rating_ledger')
        .select('game_id,delta')
        .eq('user_id', me)
        .in(
          'game_id',
          fresh.map(g => g.id),
        )
      const deltas = new Map((ll || []).map(l => [l.game_id as string, Number(l.delta)]))
      const next = fresh.map(g => ({
        game: g,
        delta: deltas.get(g.id) ?? null,
        ballots: votesByGame[g.id] || [],
      }))
      setVerdicts(v => [...v, ...next])
    }
  }, [tableId, me])
  // One fetch at a time: a call made while one is running waits for it plus one fresh rerun, so slow
  // mobile connections do not stack up overlapping fetches (and every caller still sees fresh data).
  const inFlight = useRef<Promise<void> | null>(null),
    again = useRef(false)
  const load = useCallback((): Promise<void> => {
    if (inFlight.current) {
      again.current = true
      return inFlight.current
    }
    const run = async () => {
      try {
        do {
          again.current = false
          await fetchTable()
        } while (again.current)
      } finally {
        inFlight.current = null
      }
    }
    return (inFlight.current = run())
  }, [fetchTable])
  // Realtime does the live updates; the poll is only a safety net, skipped while the app is in the background.
  useEffect(() => {
    void load().catch(console.error)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load().catch(console.error)
    }, 15000)
    const visibility = () => {
      if (document.visibilityState === 'visible') void load().catch(console.error)
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [load])
  // Listen only to this table's rows. A burst of changes (one vote touches several rows) becomes one reload.
  useEffect(() => {
    let debounce = 0
    const kick = () => {
      clearTimeout(debounce)
      debounce = window.setTimeout(() => void load().catch(console.error), 300)
    }
    const ch = supabase
      .channel(`table-${tableId}-${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tables', filter: `id=eq.${tableId}` },
        kick,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'table_members', filter: `table_id=eq.${tableId}` },
        kick,
      )
    if (watchRounds)
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'round_games', filter: `round_id=in.(${watchRounds})` },
        kick,
      )
    if (watchGames)
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'vote_totals', filter: `game_id=in.(${watchGames})` },
        kick,
      )
    if (watchHistory)
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reversal_cases', filter: `game_id=in.(${watchHistory})` },
        kick,
      )
    ch.subscribe()
    return () => {
      clearTimeout(debounce)
      void supabase.removeChannel(ch)
    }
  }, [tableId, watchRounds, watchGames, watchHistory, load])
  const activeGame = games.find(g => !['confirmed', 'tied', 'unresolved', 'void'].includes(g.state))
  const pendingBefore =
    activeGame &&
    games.some(
      g => g.slot < activeGame.slot && !['confirmed', 'tied', 'unresolved', 'void'].includes(g.state),
    )
  // When the vote deadline passes, ask the server to resolve it; retry every few seconds until the game's state moves on.
  useEffect(() => {
    if (!activeGame || !['voting', 'tie_offer'].includes(activeGame.state) || !activeGame.deadline) return
    const id = activeGame.id
    let retry = 0
    const advance = () => void rpc('advance_expired', { p_game: id }).then(load).catch(console.error)
    const first = window.setTimeout(
      () => {
        advance()
        retry = window.setInterval(advance, 3000)
      },
      Math.max(0, new Date(activeGame.deadline).getTime() - Date.now() + 300),
    )
    return () => {
      clearTimeout(first)
      clearInterval(retry)
    }
  }, [activeGame?.id, activeGame?.deadline, activeGame?.state, load])
  const name = (id: string) => profiles[id]?.username || `Player ${id.slice(0, 4)}`
  const reps = useReputation(
    members.map(m => m.user_id),
    historyGames.map(g => g.id + g.state).join(),
  )
  const invite = table ? `${location.origin}${location.pathname}?join=${table.code}` : ''
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join my table on ${APP_NAME}`,
          text: `Join my Durak table on ${APP_NAME} with code ${table?.code}.`,
          url: invite,
        })
        return
      } catch {
        /* copy fallback */
      }
    }
    try {
      await navigator.clipboard.writeText(invite)
      setShareNote('Link copied')
    } catch {
      setShareNote('Could not copy. Share the code instead.')
    }
  }
  const play = () =>
    void action(async () => {
      await rpc('start_round', { p_table: tableId })
      await load()
    })
  const finishPlay = () =>
    void action(async () => {
      await rpc('begin_results', { p_table: tableId })
      await load()
    })
  const cast = (game: string, nominee: string) =>
    void action(async () => {
      await rpc('cast_vote', { p_game: game, p_nominee: nominee })
      setMySelections(s => ({ ...s, [game]: nominee }))
      await load()
    })
  const respond = (game: string, accept: boolean) =>
    void action(async () => {
      await rpc('respond_to_tie', { p_game: game, p_accept: accept })
      await load()
    })
  const leave = () =>
    void action(async () => {
      await rpc('leave_table', { p_table: tableId })
      onLeave()
    })
  const newTable = () =>
    void action(async () => {
      if (!table) return
      openTable(await rpc<string>('create_table', { p_mode: table.mode, p_group: null }))
    })
  const addFriend = (id: string) =>
    void action(async () => {
      await rpc('add_friend_to_table', { p_table: tableId, p_friend: id })
      await load()
    })
  const stopGame = () => {
    if (!window.confirm('Stop this game? Nothing is recorded and everyone goes back to the table.')) return
    void action(async () => {
      await rpc('cancel_round', { p_table: tableId })
      await load()
    })
  }
  const removeTable = () => {
    if (
      !window.confirm(
        'Delete this table for everyone? Players will no longer see it. Recorded results and ratings are kept.',
      )
    )
      return
    void action(async () => {
      await rpc('delete_table', { p_table: tableId })
      onLeave()
    })
  }
  const kick = (id: string, who: string) => {
    if (!window.confirm(`Remove ${who} from the table?`)) return
    void action(async () => {
      await rpc('kick_member', { p_table: tableId, p_user: id })
      await load()
    })
  }
  const promote = (id: string) =>
    void action(async () => {
      await rpc('transfer_host', { p_table: tableId, p_new_host: id })
      await load()
    })
  const restart = (id: string) =>
    void action(async () => {
      await rpc('restart_unresolved', { p_game: id })
      await load()
    })
  const openCorrection = (id: string) =>
    void action(async () => {
      const cid = await rpc<string>('request_reversal', { p_game: id })
      await rpc('vote_reversal', { p_case: cid, p_approve: true })
      await load()
    })
  const correctionVote = (cid: string, approve: boolean) =>
    void action(async () => {
      await rpc('vote_reversal', { p_case: cid, p_approve: approve })
      await load()
    })
  const info = table ? modeInfo(table.mode) : MODES[0]
  // Same rule as the server: a game with no result, not reopened, can be stopped.
  const canStop =
    games.length > 0 &&
    games.every(g => ['awaiting', 'voting', 'tie_offer'].includes(g.state) && !g.was_reopened)
  if (!table) return <div className="loading">Loading table…</div>
  const closed = Boolean(table.closed_at),
    seats = table.status === 'lobby' && !closed ? Math.max(0, info.min - members.length) : 0,
    card = MODE_CARD[table.mode]
  const tiedNames = activeGame ? activeGame.loser_ids.map(name).join(' and ') : ''
  const nominees = activeGame
    ? players.filter(id => !activeGame.allowed_nominees || activeGame.allowed_nominees.includes(id))
    : []
  // Lobby: a live preview for the current members. Playing: fixed at the round's start, the same for both games of a parallel round.
  const chanceRound = table.status === 'lobby' ? null : table.current_round_id
  const chances =
    showChances && table.status !== 'results' && chanceInput?.round === chanceRound
      ? lossChances(table.status === 'lobby' ? members.map(m => m.user_id) : players, chanceInput.ratings)
      : null
  const chanceNote = chances && (
    <p className="chanceNote">
      {table.status === 'lobby'
        ? "Estimated chance of losing, from each player's Elo in this mode. It changes as players join or leave."
        : `Estimated chance of losing, fixed when this round started${info.games > 1 ? ' and used for both games' : ''}.`}{' '}
      An estimate, not a prediction. You can hide it in Profile.
    </p>
  )
  const refresh = (
    <button
      className="iconButton"
      aria-label="Refresh table"
      title="Refresh table"
      onClick={() => void load()}
    >
      <RefreshCw size={18} />
    </button>
  )
  return (
    <div className="stack lobby pageEntry">
      {blue ? (
        <>
          <button className="backLink" onClick={onLeave}>
            <span aria-hidden="true">‹</span> Home
          </button>
          <div className="summaryCard">
            <span className={`statusChip status-${statusOf(table)}`}>{STATUS_TEXT[statusOf(table)]}</span>
            <div>
              <h1 className="summaryTitle">{info.name}</h1>
              <p className="summaryMeta">
                Table <span className="mono">{table.code}</span> ·{' '}
                {info.detail.split(' · ').slice(0, 2).join(' · ')}
              </p>
            </div>
            {table.status !== 'results' && !closed && (
              <Button kind="outline" className="wide" onClick={() => setShowQR(true)}>
                Invite / QR
              </Button>
            )}
          </div>
          <Sheet
            open={showQR && table.status !== 'results' && !closed}
            title="Invite friends"
            onClose={() => {
              setShowQR(false)
              setShareNote('')
            }}
          >
            <div className="inviteSheet">
              <div className="qrInner">
                <QRCodeSVG value={invite} size={184} includeMargin />
              </div>
              <div className="codeLarge">{table.code}</div>
              <p>Friends can scan this, type the code, or open the link.</p>
              <Button className="wide" onClick={() => void share()}>
                {shareNote || 'Share invite link'}
              </Button>
            </div>
          </Sheet>
        </>
      ) : (
        <>
          <div className="lobbyHero">
            <span className={`heroCard ${card.red ? 'red' : ''}`} aria-hidden="true">
              <span className="heroIndex">
                {card.abbr}
                <br />
                {card.suit}
              </span>
              {card.suit}
            </span>
            <div>
              <h1>{info.name}</h1>
              <p>
                Table {table.code} · {STATUS_TEXT[statusOf(table)]}
              </p>
              <p className="heroDetail">
                {info.detail} ·{' '}
                <span className="nowrap">
                  {info.min}–{info.max} players
                </span>
              </p>
            </div>
          </div>
          {table.status !== 'results' && !closed && (
            <Button kind="outline" className="wide inviteButton" onClick={() => setShowQR(s => !s)}>
              {showQR ? 'Hide invite' : 'Invite / QR'}
            </Button>
          )}
          {showQR && table.status !== 'results' && !closed && (
            <section className="card qrCard" aria-label="Invite">
              <div className="qrInner">
                <QRCodeSVG value={invite} size={184} includeMargin />
              </div>
              <p>Scan to join this table, or type the code</p>
              <div className="codeLarge">{table.code}</div>
              <Button kind="secondary" onClick={() => void share()}>
                <Copy size={15} /> {shareNote || 'Share link'}
              </Button>
            </section>
          )}
        </>
      )}
      {closed && (
        <section className="closedNotice" role="status" aria-labelledby="closed-title">
          <h2 id="closed-title">Table closed due to inactivity</h2>
          <p>
            Nothing happened at this table for 2 hours, so it closed
            {table.closed_at ? ` on ${dateTime(table.closed_at)}` : ''}. Nobody can join it or start a game
            here any more. Every result and rating is kept.
          </p>
          <Button className="wide" onClick={newTable} disabled={busy}>
            Start a new {info.name} table
          </Button>
          <Button kind="outline" className="wide" onClick={openHistory}>
            See your game history
          </Button>
          <button className="leaveLink" onClick={leave} disabled={busy}>
            Remove from your tables <LogOut size={14} />
          </button>
        </section>
      )}
      {table.status !== 'results' && !closed && (
        <section aria-labelledby="players-title">
          {blue ? (
            <div className="sectionHeading">
              <h2 id="players-title">Players</h2>
              <span className="countText">
                {members.length} of {info.max}
                {refresh}
              </span>
            </div>
          ) : (
            <div className="sectionHeading">
              <h2 id="players-title">
                Players · {members.length} of {info.max}
              </h2>
              {refresh}
            </div>
          )}
          {blue ? (
            <ul className="rowList">
              {members.map(m => {
                const host = m.user_id === table.host_id,
                  mine = m.user_id === me,
                  who = name(m.user_id)
                return (
                  <li key={m.user_id} className="playerRow">
                    <Avatar id={m.user_id} name={who} me={me} size="md" />
                    <span className="rowText">
                      <b>
                        <PlayerName id={m.user_id} name={who} />
                        {mine && <span className="youChip">you</span>}
                      </b>
                      {chances?.[m.user_id] && <ChanceLine chance={chances[m.user_id]} />}
                      {host && (
                        <small>
                          <Crown className="hostIcon" size={13} aria-hidden="true" /> Host
                        </small>
                      )}
                    </span>
                    {table.status === 'lobby' && table.host_id === me && !mine && (
                      <button
                        className="linkButton"
                        disabled={busy}
                        aria-label={`Make ${who} the host`}
                        onClick={() => promote(m.user_id)}
                      >
                        Make host
                      </button>
                    )}
                    {table.status === 'lobby' && table.host_id === me && !mine && (
                      <button
                        className="linkButton danger"
                        disabled={busy}
                        aria-label={`Remove ${who} from the table`}
                        onClick={() => kick(m.user_id, who)}
                      >
                        Remove
                      </button>
                    )}
                    <span className="rowRep">
                      <Stars rep={reps[m.user_id]} />
                    </span>
                  </li>
                )
              })}
              {seats > 0 && (
                <li>
                  <button
                    className="playerRow waiting"
                    aria-label="Waiting for someone to join. Show the invite"
                    onClick={() => setShowQR(true)}
                  >
                    <span className="tintAvatar md empty" aria-hidden="true" />
                    <span>Waiting for someone to join…</span>
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <ul className="seatGrid">
              {members.map(m => {
                const host = m.user_id === table.host_id,
                  mine = m.user_id === me,
                  who = name(m.user_id)
                return (
                  <li key={m.user_id} className={`seat ${mine ? 'mine' : ''}`}>
                    {host && <Crown className="seatCrown" size={16} aria-hidden="true" />}
                    {mine && <span className="seatYou">you</span>}
                    <span className="seatInitials" aria-hidden="true">
                      {who.slice(0, 2).toUpperCase()}
                    </span>
                    <b className="seatName" title={who}>
                      <PlayerName id={m.user_id} name={who} />
                    </b>
                    {chances?.[m.user_id] && <ChanceLine chance={chances[m.user_id]} />}
                    {(host || reps[m.user_id]) && (
                      <span className="seatMeta">
                        <Stars rep={reps[m.user_id]} />
                        {host && (reps[m.user_id] ? ' · host' : 'host')}
                      </span>
                    )}
                    {table.status === 'lobby' && table.host_id === me && !mine && (
                      <button
                        className="seatAction"
                        disabled={busy}
                        aria-label={`Make ${who} the host`}
                        onClick={() => promote(m.user_id)}
                      >
                        Make host
                      </button>
                    )}
                    {table.status === 'lobby' && table.host_id === me && !mine && (
                      <button
                        className="seatAction danger"
                        disabled={busy}
                        aria-label={`Remove ${who} from the table`}
                        onClick={() => kick(m.user_id, who)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                )
              })}
              {Array.from({ length: seats }, (_, i) => (
                <li key={`empty-${i}`} className="seatSlot">
                  <button
                    className="seat empty"
                    aria-label="Empty seat, show the invite QR code"
                    onClick={() => setShowQR(true)}
                  >
                    Empty seat
                  </button>
                </li>
              ))}
            </ul>
          )}
          {table.status === 'lobby' &&
            table.host_id === me &&
            (() => {
              const here = new Set(members.map(m => m.user_id)),
                avail = myFriends.filter(f => !here.has(f.id))
              return (
                avail.length > 0 && (
                  <section className="card" aria-label="Add friends">
                    <h3 className="listLabel">Add friends</h3>
                    <ul className="rowList">
                      {avail.map(f => (
                        <li key={f.id} className="playerRow">
                          <span className="rowText">
                            <b>{f.name}</b>
                          </span>
                          <Button
                            kind="secondary"
                            disabled={busy || members.length >= info.max}
                            onClick={() => addFriend(f.id)}
                          >
                            Add
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              )
            })()}
          {chanceNote}
          {table.status === 'lobby' && (
            <div className="lobbyFooter">
              <p>
                {members.length < info.min
                  ? `Need ${info.min - members.length} more player${info.min - members.length === 1 ? '' : 's'} to start`
                  : 'Everyone ready? Deal the cards.'}
              </p>
              <Button onClick={play} disabled={busy || members.length < info.min} className="wide">
                Start new game
              </Button>
              <button className="leaveLink" onClick={leave} disabled={busy}>
                Leave table <LogOut size={14} />
              </button>
              {table.host_id === me && (
                <button className="leaveLink" onClick={removeTable} disabled={busy}>
                  Delete table <Trash2 size={14} />
                </button>
              )}
            </div>
          )}
          {table.status === 'playing' && (
            <div className="lobbyFooter">
              <div className="hint">
                <ShieldCheck size={18} /> All players are locked into this round. You can close your phone
                while playing.
              </div>
              <Button onClick={finishPlay} disabled={busy} className="wide">
                Cards finished — record results <ArrowRight size={17} />
              </Button>
              {table.host_id === me && canStop && (
                <button className="leaveLink" onClick={stopGame} disabled={busy}>
                  Started by mistake? Stop this game <X size={14} />
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {table.status === 'results' && (
        <section className="voting" aria-labelledby="vote-title">
          <div className="voteHead">
            <div>
              {games.length > 1 && activeGame && (
                <p className="voteGame">
                  Game {activeGame.slot} of {games.length}
                </p>
              )}
              <h2 id="vote-title">
                {!activeGame
                  ? 'Results'
                  : pendingBefore
                    ? 'One game at a time'
                    : activeGame.state === 'tie_offer'
                      ? "It's a tie"
                      : 'Who lost?'}
              </h2>
            </div>
            {activeGame &&
              !pendingBefore &&
              (activeGame.deadline ? (
                <VoteTimer deadline={activeGame.deadline} />
              ) : (
                <div className="voteTimer idle" aria-label="The 30-second timer starts with the first vote">
                  <b>30</b>
                  <span>sec</span>
                </div>
              ))}
          </div>
          {activeGame && !pendingBefore ? (
            activeGame.state === 'tie_offer' ? (
              <>
                {blue ? (
                  <ul className="rowList">
                    {activeGame.loser_ids.map(id => (
                      <li key={id} className="playerRow">
                        <Avatar id={id} name={name(id)} me={me} size="md" />
                        <span className="rowText">
                          <b>
                            {name(id)}
                            {id === me && <span className="youChip">you</span>}
                          </b>
                          <small>Tied</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="voteGrid tied">
                    {activeGame.loser_ids.map(id => (
                      <li key={id} className="seat">
                        <span className="seatInitials" aria-hidden="true">
                          {name(id).slice(0, 2).toUpperCase()}
                        </span>
                        <b className="seatName">{name(id)}</b>
                        <span className="seatMeta">{id === me ? 'you · tied' : 'tied'}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="voteRules">
                  {tiedNames} have the same number of votes. If everyone tied accepts, they share the loss and
                  each loses less rating. If anyone declines, they vote again between themselves.
                </p>
                {activeGame.loser_ids.includes(me) ? (
                  <div className="voteActions">
                    <Button className="wide" onClick={() => respond(activeGame.id, true)} disabled={busy}>
                      Accept shared loss
                    </Button>
                    <Button
                      kind="outline"
                      className="wide"
                      onClick={() => respond(activeGame.id, false)}
                      disabled={busy}
                    >
                      Decline, vote again
                    </Button>
                  </div>
                ) : (
                  <p className="voteNote">Waiting for {tiedNames} to decide.</p>
                )}
              </>
            ) : (
              <>
                <p className="voteRules">
                  {activeGame.allowed_nominees
                    ? `Vote again between ${activeGame.allowed_nominees.map(name).join(' and ')}.`
                    : 'Tap the player who was left holding cards.'}{' '}
                  A clear majority decides straight away; otherwise the most votes after 30 seconds wins, with
                  at least 2 votes.
                </p>
                {blue ? (
                  <ul className="rowList voteRows">
                    {nominees.map(id => {
                      const votes =
                          totals.find(v => v.game_id === activeGame.id && v.nominee_id === id)?.votes || 0,
                        picked = mySelections[activeGame.id] === id,
                        count = `${votes} ${votes === 1 ? 'vote' : 'votes'}`
                      return (
                        <li key={id}>
                          <button
                            className={`playerRow voteRow ${picked ? 'picked' : ''}`}
                            aria-pressed={picked}
                            aria-label={`${name(id)}${id === me ? ' (you)' : ''}, ${count}`}
                            disabled={busy}
                            onClick={() => cast(activeGame.id, id)}
                          >
                            <Avatar id={id} name={name(id)} me={me} size="md" />
                            <span className="rowText" aria-hidden="true">
                              <b>
                                {name(id)}
                                {id === me && <span className="youChip">you</span>}
                              </b>
                              <small>{count}</small>
                            </span>
                            {picked && (
                              <span className="voteCheck" aria-hidden="true">
                                ✓
                              </span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <ul className="voteGrid">
                    {nominees.map(id => {
                      const votes =
                          totals.find(v => v.game_id === activeGame.id && v.nominee_id === id)?.votes || 0,
                        picked = mySelections[activeGame.id] === id,
                        count = `${votes} ${votes === 1 ? 'vote' : 'votes'}`
                      return (
                        <li key={id}>
                          <button
                            className={`seat voteCard ${picked ? 'picked' : ''}`}
                            aria-pressed={picked}
                            aria-label={`${name(id)}${id === me ? ' (you)' : ''}, ${count}`}
                            disabled={busy}
                            onClick={() => cast(activeGame.id, id)}
                          >
                            {picked && (
                              <span className="voteCheck" aria-hidden="true">
                                ✓
                              </span>
                            )}
                            <span className="seatInitials" aria-hidden="true">
                              {name(id).slice(0, 2).toUpperCase()}
                            </span>
                            <b className="seatName">{name(id)}</b>
                            <span className={`votePips ${card.red ? 'red' : ''}`} aria-hidden="true">
                              {card.suit.repeat(Math.min(votes, 6))}
                            </span>
                            <span className="seatMeta" aria-hidden="true">
                              {id === me ? 'you · ' : ''}
                              {count}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <p className="voteNote">
                  {activeGame.state === 'awaiting'
                    ? 'The timer starts with the first vote.'
                    : 'Totals are public; who voted for whom stays hidden until the result is final. You can change your vote.'}
                </p>
              </>
            )
          ) : activeGame ? (
            <p className="voteRules">Game {activeGame.slot} opens once the earlier game has a result.</p>
          ) : null}
          {games.some(g => FINAL.includes(g.state)) && (
            <ol className="roundResults" aria-label="Results so far">
              {games
                .filter(g => FINAL.includes(g.state))
                .map(g => (
                  <li key={g.id}>
                    <ResultRow game={g} name={name} restart={() => restart(g.id)} busy={busy} />
                  </li>
                ))}
            </ol>
          )}
          {table.host_id === me && canStop && (
            <button className="leaveLink" onClick={stopGame} disabled={busy}>
              Started by mistake? Stop this game <X size={14} />
            </button>
          )}
          {games.some(g => g.state === 'unresolved') && (
            <div className="hint">
              <Clock3 size={17} /> Games without a result can be voted on again later. The table stays open
              until they have one.
            </div>
          )}
        </section>
      )}
      {table.status === 'lobby' && historyGames.length > 0 && (
        <section className="card historyCard">
          <h2>
            <button
              className="historyToggle"
              aria-expanded={showHistory}
              aria-controls="history-list"
              onClick={() => setShowHistory(s => !s)}
            >
              Recent results{' '}
              <ChevronDown size={18} className={showHistory ? 'flip' : ''} aria-hidden="true" />
            </button>
          </h2>
          {showHistory && (
            <ul className="historyList" id="history-list">
              {historyGames
                .filter(g => FINAL.includes(g.state))
                .slice(0, 12)
                .map(g => (
                  <li key={g.id} className="historyItem">
                    <ResultRow
                      game={g}
                      name={name}
                      restart={closed ? undefined : () => restart(g.id)}
                      busy={busy}
                    />
                    {ballots[g.id]?.length > 0 && (
                      <p className="ballots">
                        <span className="ballotsLabel">Votes</span>
                        {ballots[g.id].map(v => (
                          <span key={v.voter_id}>
                            {name(v.voter_id)} → {name(v.nominee_id)}
                          </span>
                        ))}
                      </p>
                    )}
                    {['confirmed', 'tied'].includes(g.state) &&
                      g.finalized_at &&
                      Date.now() - new Date(g.finalized_at).getTime() < 86400000 && (
                        <button className="linkButton" onClick={() => openCorrection(g.id)}>
                          Request correction
                        </button>
                      )}
                    {cases
                      .filter(c => c.game_id === g.id && c.state === 'open')
                      .map(c => (
                        <div className="correction" key={c.id}>
                          <span>
                            Correction vote · {yesCounts[c.id] || 0}{' '}
                            {yesCounts[c.id] === 1 ? 'approval' : 'approvals'}
                          </span>
                          <Button kind="secondary" onClick={() => correctionVote(c.id, true)}>
                            Approve
                          </Button>
                          <Button kind="ghost" onClick={() => correctionVote(c.id, false)}>
                            Reject
                          </Button>
                        </div>
                      ))}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}
      <VerdictSheet
        verdict={verdicts[0]}
        me={me}
        name={name}
        parallel={info.games > 1}
        onClose={() => setVerdicts(v => v.slice(1))}
      />
    </div>
  )
}

/** "Vote closed": who the Durak is, your rating change and every ballot, once the vote is final. */
function VerdictSheet({
  verdict,
  me,
  name,
  parallel,
  onClose,
}: {
  verdict?: Verdict
  me: string
  name: (id: string) => string
  parallel: boolean
  onClose: () => void
}) {
  const g = verdict?.game
  const myBallot = verdict?.ballots.find(b => b.voter_id === me)
  // Telling the player who just denied their own loss what it cost (see the reputation migration).
  const denied = g?.state === 'confirmed' && g.loser_ids[0] === me && myBallot && myBallot.nominee_id !== me
  return (
    <Sheet open={Boolean(verdict)} title="Vote closed" onClose={onClose}>
      {g && verdict && (
        <div className="verdict" role="status">
          {parallel && <p className="voteGame">Game {g.slot}</p>}
          <p className="verdictName">
            {g.state === 'confirmed' ? (
              g.loser_ids[0] === me ? (
                <>
                  You're the <b>Durak</b>
                </>
              ) : (
                <>
                  <b>{name(g.loser_ids[0])}</b> is the Durak
                </>
              )
            ) : (
              <>
                Shared loss: <b>{listNames(g.loser_ids.map(id => (id === me ? 'you' : name(id))))}</b>
              </>
            )}
          </p>
          {verdict.delta !== null && (
            <p className="verdictDelta">
              Your rating <strong className={deltaClass(verdict.delta)}>{signed(verdict.delta)}</strong>
            </p>
          )}
          {verdict.ballots.length > 0 && (
            <p className="ballots">
              <span className="ballotsLabel">Votes</span>
              {verdict.ballots.map(b => (
                <span key={b.voter_id}>
                  {name(b.voter_id)} → {name(b.nominee_id)}
                </span>
              ))}
            </p>
          )}
          {denied && (
            <p className="verdictWarning">
              You voted for {name(myBallot.nominee_id)}. Voting for someone else in a game you lost costs a
              reputation star.
            </p>
          )}
          <Button className="wide" onClick={onClose}>
            OK
          </Button>
        </div>
      )}
    </Sheet>
  )
}

const FINAL: Game['state'][] = ['confirmed', 'tied', 'unresolved', 'void']

// Without restart (a closed table, which never has a game without a result), there is no "Vote again".
function ResultRow({
  game,
  name,
  restart,
  busy,
}: {
  game: Game
  name: (id: string) => string
  restart?: () => void
  busy: boolean
}) {
  return (
    <div className={`resultRow ${game.state}`}>
      <span className="resultGame">Game {game.slot}</span>
      <span className="resultText">
        {game.state === 'confirmed' ? (
          <>
            <b>
              <PlayerName id={game.loser_ids[0]} name={name(game.loser_ids[0])} />
            </b>{' '}
            lost
          </>
        ) : game.state === 'tied' ? (
          <>
            Shared loss:{' '}
            <b>
              {game.loser_ids.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <PlayerName id={id} name={name(id)} />
                </span>
              ))}
            </b>
          </>
        ) : game.state === 'unresolved' ? (
          'No result'
        ) : game.state === 'void' ? (
          'Reversed after a correction vote'
        ) : (
          'Waiting for a result'
        )}
      </span>
      {game.state === 'unresolved' && restart && (
        <button className="linkButton" disabled={busy} onClick={restart}>
          Vote again
        </button>
      )}
    </div>
  )
}
