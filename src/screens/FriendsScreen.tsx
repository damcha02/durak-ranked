import { useCallback, useEffect, useState } from 'react'
import { MODES, errorMessage, modeInfo, rpc, supabase } from '../lib'
import type { Mode, Rating } from '../lib'
import type { RatedGame } from '../ratingChart'
import { RatingChart } from '../RatingChart'
import { Standings } from './LeaderboardScreen'
import { Button, MIN_FRIEND_GAMES, ModeChips, PlayerName, formatRating } from '../ui'
import type { Action } from '../ui'

// A friend's ratings and Elo chart, shown in the player sheet. The chart opens on the mode they play most.
export function FriendStats({ id, name }: { id: string; name: string }) {
  const [ratings, setRatings] = useState<Rating[] | null>(null),
    [mode, setMode] = useState<Mode | null>(null),
    [chart, setChart] = useState<{ mode: Mode; games: RatedGame[] } | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void supabase
      .from('ratings')
      .select('*')
      .eq('user_id', id)
      .then(({ data, error }) => {
        if (!live) return
        if (error) {
          setError(errorMessage(error))
          return
        }
        const rs = (data || []) as Rating[]
        setRatings(rs)
        setMode(
          MODES.reduce(
            (best, m) =>
              (rs.find(r => r.mode === m.id)?.games || 0) > (rs.find(r => r.mode === best)?.games || 0)
                ? m.id
                : best,
            'natural' as Mode,
          ),
        )
      })
    return () => {
      live = false
    }
  }, [id])
  useEffect(() => {
    if (!mode) return
    let live = true
    setError('')
    rpc<RatedGame[]>('friend_rating_history', { p_user: id, p_mode: mode })
      .then(games => {
        if (live) setChart({ mode, games })
      })
      .catch(e => {
        if (live) setError(errorMessage(e))
      })
    return () => {
      live = false
    }
  }, [id, mode])
  const r = mode ? ratings?.find(x => x.mode === mode) : undefined,
    info = modeInfo(mode || 'natural')
  return (
    <div className="stack sm">
      <p>{name} is your friend.</p>
      {mode && <ModeChips mode={mode} setMode={setMode} />}
      <div className="chartCard">
        <h3>
          {info.name}
          {r && r.games > 0 && (
            <small className="chartMeta">
              {' '}
              · {formatRating(r.rating)} Elo · {r.games} {r.games === 1 ? 'game' : 'games'} · {r.losses}{' '}
              {r.losses === 1 ? 'loss' : 'losses'}
            </small>
          )}
        </h3>
        {error ? (
          <p className="emptyNote" role="alert">
            {error}
          </p>
        ) : !chart || chart.mode !== mode ? (
          <p className="emptyNote">Loading…</p>
        ) : chart.games.length ? (
          <RatingChart games={chart.games} modeName={info.name} />
        ) : (
          <p className="emptyNote">
            {name} has no rated {info.name} games yet.
          </p>
        )}
      </div>
    </div>
  )
}

export function FriendsScreen({ me, action, busy }: { me: string; action: Action; busy: boolean }) {
  type Row = { other: string; status: 'pending' | 'accepted'; mine: boolean }
  const [rows, setRows] = useState<Row[]>([]),
    [names, setNames] = useState<Record<string, string>>({}),
    [name, setName] = useState(''),
    [mode, setMode] = useState<Mode>('natural'),
    [ranked, setRanked] = useState<Rating[]>([])
  const load = useCallback(async () => {
    const { data } = await supabase.from('friendships').select('*')
    const rs: Row[] = (data || []).map(f => ({
      other: f.user_a === me ? f.user_b : f.user_a,
      status: f.status,
      mine: f.requested_by === me,
    }))
    setRows(rs)
    const ids = rs.map(r => r.other)
    if (ids.length) {
      const { data: pp } = await supabase.from('profiles').select('id,username').in('id', ids)
      setNames(
        Object.fromEntries(((pp || []) as { id: string; username: string }[]).map(p => [p.id, p.username])),
      )
    }
  }, [me])
  useEffect(() => {
    void load().catch(console.error)
  }, [load])
  const friendIds = rows.filter(r => r.status === 'accepted').map(r => r.other),
    key = friendIds.join(',')
  // Standings among you and your friends: same rating and the same minimum number of games as the global rankings.
  useEffect(() => {
    let live = true
    void (async () => {
      const { data } = await supabase
        .from('ratings')
        .select('*')
        .in('user_id', [me, ...friendIds])
        .eq('mode', mode)
        .gte('games', MIN_FRIEND_GAMES)
        .order('rating', { ascending: false })
      if (live) setRanked((data || []) as Rating[])
    })().catch(console.error)
    return () => {
      live = false
    }
  }, [me, mode, key])
  const label = (id: string) => (id === me ? 'You' : names[id] || 'Player')
  const allNames = { ...names, [me]: 'You' }
  const add = () =>
    void action(async () => {
      await rpc('send_friend_request', { p_username: name.trim() })
      setName('')
      await load()
    })
  const respond = (id: string, accept: boolean) =>
    void action(async () => {
      await rpc('respond_friend_request', { p_user: id, p_accept: accept })
      await load()
    })
  const remove = (id: string) => {
    if (!window.confirm(`Remove ${label(id)} from your friends?`)) return
    void action(async () => {
      await rpc('remove_friend', { p_user: id })
      await load()
    })
  }
  const incoming = rows.filter(r => r.status === 'pending' && !r.mine),
    sent = rows.filter(r => r.status === 'pending' && r.mine),
    accepted = rows.filter(r => r.status === 'accepted')
  return (
    <div className="stack page pageEntry">
      <header className="pageHead">
        <h1>Friends</h1>
        <p>Add friends once, then seat them at your table in one tap. No code or QR needed.</p>
      </header>
      <section aria-labelledby="add-friend-title">
        <h2 id="add-friend-title" className="sectionTitle">
          Add a friend
        </h2>
        <form
          onSubmit={e => {
            e.preventDefault()
            if (name.trim()) add()
          }}
        >
          <label className="field" htmlFor="friend-name">
            Their username
          </label>
          <div className="joinRow">
            <input
              id="friend-name"
              placeholder="username"
              maxLength={22}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              Send request
            </Button>
          </div>
        </form>
      </section>
      {incoming.length > 0 && (
        <section aria-labelledby="requests-title">
          <h2 id="requests-title" className="listLabel">
            Requests
          </h2>
          <ul className="rowList">
            {incoming.map(r => (
              <li key={r.other} className="playerRow">
                <span className="rowText">
                  <b>{label(r.other)}</b>
                  <small>wants to be friends</small>
                </span>
                <Button kind="secondary" disabled={busy} onClick={() => respond(r.other, true)}>
                  Accept
                </Button>
                <Button kind="ghost" disabled={busy} onClick={() => respond(r.other, false)}>
                  Decline
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="friends-title">
        <h2 id="friends-title" className="listLabel">
          Your friends
        </h2>
        {accepted.length ? (
          <ul className="rowList">
            {accepted.map(r => (
              <li key={r.other} className="playerRow">
                <span className="rowText">
                  <b>
                    <PlayerName id={r.other} name={label(r.other)} />
                  </b>
                  <small>tap to see their rating chart</small>
                </span>
                <button className="linkButton danger" disabled={busy} onClick={() => remove(r.other)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="emptyNote">No friends yet. Send a request by username.</p>
        )}
        {sent.length > 0 && (
          <>
            <h3 className="listLabel">Waiting for them</h3>
            <ul className="rowList">
              {sent.map(r => (
                <li key={r.other} className="playerRow">
                  <span className="rowText">
                    <b>{label(r.other)}</b>
                    <small>request sent</small>
                  </span>
                  <button className="linkButton" disabled={busy} onClick={() => remove(r.other)}>
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {accepted.length > 0 && (
        <Duel
          friends={accepted
            .map(r => ({ id: r.other, name: label(r.other) }))
            .sort((x, y) => x.name.localeCompare(y.name))}
        />
      )}
      {accepted.length > 0 && (
        <section aria-label="Standings among friends">
          <h2 className="listLabel">Standings with friends</h2>
          <ModeChips mode={mode} setMode={setMode} />
          {ranked.length ? (
            <Standings ratings={ranked} names={allNames} me={me} mode={mode} />
          ) : (
            <p className="emptyNote">
              Nobody here has played {MIN_FRIEND_GAMES} {modeInfo(mode).name} games yet.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

type DuelRow = { games: number; my_losses: number; their_losses: number; both_lost: number }

function Duel({ friends }: { friends: { id: string; name: string }[] }) {
  const [pick, setPick] = useState(''),
    [duel, setDuel] = useState<{ id: string; row: DuelRow } | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    if (pick && !friends.some(f => f.id === pick)) setPick('')
  }, [friends, pick])
  useEffect(() => {
    if (!pick) return
    let live = true
    setError('')
    rpc<DuelRow[]>('duel_stats', { p_friend: pick, p_mode: 'natural' })
      .then(r => {
        if (live) setDuel({ id: pick, row: r[0] })
      })
      .catch(e => {
        if (live) setError(errorMessage(e))
      })
    return () => {
      live = false
    }
  }, [pick])
  const them = friends.find(f => f.id === pick)?.name || '',
    d = duel?.id === pick ? duel.row : null
  const decided = d ? d.my_losses + d.their_losses : 0,
    neither = d ? d.games - d.my_losses - d.their_losses + d.both_lost : 0,
    mine = decided ? Math.round((100 * d!.my_losses) / decided) : 50
  return (
    <section aria-labelledby="duel-title" className="stack sm">
      <h2 id="duel-title" className="listLabel">
        Duel
      </h2>
      <label className="field" htmlFor="duel-friend">
        Compare yourself with
      </label>
      <select id="duel-friend" value={pick} onChange={e => setPick(e.target.value)}>
        <option value="">Choose a friend</option>
        {friends.map(f => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {pick &&
        (error ? (
          <p className="emptyNote" role="alert">
            {error}
          </p>
        ) : !d ? (
          <p className="emptyNote">Loading…</p>
        ) : !d.games ? (
          <p className="emptyNote">
            You and {them} haven't finished a rated Natural Durak game together yet.
          </p>
        ) : (
          <div className="duelCard">
            <p className="duelVerdict">
              {d.my_losses === d.their_losses
                ? `Dead even: you've both been the Durak ${d.my_losses} ${d.my_losses === 1 ? 'time' : 'times'}.`
                : d.my_losses < d.their_losses
                  ? `You're ahead: ${them} has been the Durak more often.`
                  : `${them} is ahead: you've been the Durak more often.`}
            </p>
            <div className="duelScore">
              <div>
                <b>{d.my_losses}</b>
                <small>You were the Durak</small>
              </div>
              <span aria-hidden="true">–</span>
              <div>
                <b>{d.their_losses}</b>
                <small>{them} was the Durak</small>
              </div>
            </div>
            {decided > 0 && (
              <div
                className="duelBar"
                role="img"
                aria-label={`Of the games one of you lost, you lost ${mine}%`}
              >
                <span className="you" style={{ width: `${mine}%` }} />
                <span className="them" style={{ width: `${100 - mine}%` }} />
              </div>
            )}
            <p className="fieldHint">
              {d.games} rated Natural Durak {d.games === 1 ? 'game' : 'games'} together
              {neither > 0 && `; in ${neither} someone else was the Durak`}
              {d.both_lost > 0 &&
                `; ${d.both_lost} shared ${d.both_lost === 1 ? 'loss' : 'losses'} between you two`}
              .{decided > 0 && ` Of the times one of you was the Durak, it was you ${mine}%.`}
            </p>
          </div>
        ))}
    </section>
  )
}
