import { useEffect, useMemo, useState } from 'react'
import { modeInfo, supabase } from '../lib'
import type { Mode, Profile, Rating } from '../lib'
import { Avatar, MIN_RANKED_GAMES, MODE_CARD, ModeChips, PlayerName, formatRating, useBlue } from '../ui'

// Top three as player cards with the rank as the corner index; everyone else as ledger rows.
export function Standings({
  ratings,
  names,
  me,
  mode,
}: {
  ratings: Rating[]
  names: Record<string, string>
  me: string
  mode: Mode
}) {
  const card = MODE_CARD[mode],
    who = (r: Rating) => names[r.user_id] || 'Player'
  // Blue theme: one white list card, no podium.
  if (useBlue())
    return (
      <ol className="listCard">
        {ratings.map((r, i) => (
          <li key={r.user_id} className={`rankRow ${r.user_id === me ? 'mine' : ''}`}>
            <span className="position" aria-hidden="true">
              {i + 1}
            </span>
            <Avatar id={r.user_id} name={who(r)} me={me} />
            <span className="rowText">
              <b>
                <PlayerName id={r.user_id} name={who(r)} />
                {r.user_id === me && ' (you)'}
              </b>
              <small>
                {r.games} games · {r.losses} losses{r.games < MIN_RANKED_GAMES && ' · provisional'}
              </small>
            </span>
            <span className="rowValue">{formatRating(r.rating)}</span>
          </li>
        ))}
      </ol>
    )
  return (
    <>
      <ol className="podium">
        {ratings.slice(0, 3).map((r, i) => (
          <li key={r.user_id} className={`seat podiumCard ${r.user_id === me ? 'mine' : ''}`}>
            <span className={`cornerIndex ${card.red ? 'red' : ''}`} aria-hidden="true">
              {i + 1}
              <br />
              {card.suit}
            </span>
            {r.user_id === me && <span className="seatYou">you</span>}
            <span className="seatInitials" aria-hidden="true">
              {who(r).slice(0, 2).toUpperCase()}
            </span>
            <b className="seatName" title={who(r)}>
              <PlayerName id={r.user_id} name={who(r)} />
            </b>
            <span className="podiumRating">{formatRating(r.rating)}</span>
            <span className="seatMeta">
              {r.games} {r.games === 1 ? 'game' : 'games'}
              {r.games < MIN_RANKED_GAMES && ' · provisional'}
            </span>
          </li>
        ))}
      </ol>
      {ratings.length > 3 && (
        <ol className="rankList" start={4}>
          {ratings.slice(3).map((r, i) => (
            <li key={r.user_id} className={`rankRow ${r.user_id === me ? 'mine' : ''}`}>
              <span className="position" aria-hidden="true">
                {i + 4}
              </span>
              <span className="playerAvatar" aria-hidden="true">
                {who(r).slice(0, 2).toUpperCase()}
              </span>
              <span className="rankName">
                <strong>
                  <PlayerName id={r.user_id} name={who(r)} />
                  {r.user_id === me && <span className="youTag">you</span>}
                </strong>
                <small>
                  {r.games} games · {r.losses} losses{r.games < MIN_RANKED_GAMES && ' · provisional'}
                </small>
              </span>
              <span className="rankScore">{formatRating(r.rating)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

export function LeaderboardScreen({ me }: { me: string }) {
  const [mode, setMode] = useState<Mode>('natural'),
    [ratings, setRatings] = useState<Rating[]>([]),
    [users, setUsers] = useState<Record<string, Profile>>({}),
    [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    void (async () => {
      const { data, error } = await supabase
        .from('ratings')
        .select('*')
        .eq('mode', mode)
        .gte('games', MIN_RANKED_GAMES)
        .order('rating', { ascending: false })
        .limit(100)
      if (error) throw error
      const scores = (data || []) as Rating[]
      const { data: p } = scores.length
        ? await supabase
            .from('profiles')
            .select('*')
            .in(
              'id',
              scores.map(r => r.user_id),
            )
        : { data: [] }
      if (live) {
        setRatings(scores)
        setUsers(Object.fromEntries(((p || []) as Profile[]).map(x => [x.id, x])))
        setLoading(false)
      }
    })().catch(console.error)
    return () => {
      live = false
    }
  }, [mode])
  const names = useMemo(() => Object.fromEntries(Object.values(users).map(u => [u.id, u.username])), [users])
  return (
    <div className="stack page pageEntry">
      <header className="pageHead">
        <h1>Rankings</h1>
        <p>
          Everyone starts at 1,200, and each game mode has its own standings. You appear after{' '}
          {MIN_RANKED_GAMES} games in a mode.
        </p>
      </header>
      <ModeChips mode={mode} setMode={setMode} />
      <section aria-label={`${modeInfo(mode).name} standings`}>
        {loading ? (
          <p className="emptyNote">Loading…</p>
        ) : ratings.length === 0 ? (
          <p className="emptyNote">
            Nobody has played {MIN_RANKED_GAMES} {modeInfo(mode).name} games yet. Start a table and play.
          </p>
        ) : (
          <Standings ratings={ratings} names={names} me={me} mode={mode} />
        )}
      </section>
    </div>
  )
}
