import { LogOut } from 'lucide-react'
import { useContext, useEffect, useState } from 'react'
import { MODES, date, errorMessage, modeInfo, rpc, supabase } from '../lib'
import type { Mode, Profile, Rating } from '../lib'
import { streakLabel, streakPenaltyNext } from '../lossStreak'
import type { RatedGame } from '../ratingChart'
import { RatingChart } from '../RatingChart'
import { THEMES } from '../theme'
import {
  Avatar,
  Button,
  MODE_CARD,
  MiniModeCard,
  ModeChips,
  PlayerName,
  ThemeContext,
  formatRating,
} from '../ui'
import type { Action } from '../ui'

type TableMate = {
  user_id: string
  username: string
  games: number
  losses: number
  expected_losses: number | string
}

const MIN_TABLE_GAMES = 5

/** Percentage points by which your loss rate with this player at the table exceeds your fair share. */
const tableEffect = (m: TableMate) => (100 * (m.losses - Number(m.expected_losses))) / m.games

export function ProfileScreen({
  me,
  profile,
  action,
  reload,
  showChances,
  setShowChances,
}: {
  me: string
  profile: Profile | null
  action: Action
  reload: () => Promise<void>
  showChances: boolean
  setShowChances: (show: boolean) => void
}) {
  const { theme, setTheme } = useContext(ThemeContext),
    blue = theme === 'blue'
  const [name, setName] = useState(profile?.username || ''),
    [ratings, setRatings] = useState<Rating[]>([]),
    [admissions, setAdmissions] = useState(0),
    [ledger, setLedger] = useState<{ game_id: string; delta: number; recorded_at: string; mode: Mode }[]>([])
  const [accountEmail, setAccountEmail] = useState(''),
    [oldPassword, setOldPassword] = useState(''),
    [nextPassword, setNextPassword] = useState(''),
    [accountNotice, setAccountNotice] = useState('')
  useEffect(() => {
    let live = true
    void supabase.auth
      .getUser()
      .then(({ data }) => {
        if (live) setAccountEmail(data.user?.email || '')
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [me])
  useEffect(() => {
    if (profile) setName(profile.username)
  }, [profile?.username])
  useEffect(() => {
    void (async () => {
      const [{ data: r }, { count }, { data: ll }] = await Promise.all([
        supabase.from('ratings').select('*').eq('user_id', me),
        supabase.from('honesty_events').select('*', { count: 'exact', head: true }).eq('user_id', me),
        supabase
          .from('rating_ledger')
          .select('game_id,delta,recorded_at,mode')
          .eq('user_id', me)
          .order('recorded_at', { ascending: false })
          .limit(200),
      ])
      setRatings((r || []) as Rating[])
      setAdmissions(count || 0)
      setLedger((ll || []) as { game_id: string; delta: number; recorded_at: string; mode: Mode }[])
    })()
  }, [me])
  const total = ratings.reduce((s, r) => s + r.games, 0),
    losses = ratings.reduce((s, r) => s + r.losses, 0),
    wins = Math.max(0, total - losses),
    who = profile?.username || ''
  // Rating over time, one mode at a time (the most played one first), from the server's replay-ordered history.
  const [chartMode, setChartMode] = useState<Mode | null>(null),
    [chart, setChart] = useState<{ mode: Mode; games: RatedGame[] } | null>(null),
    [chartError, setChartError] = useState('')
  useEffect(() => {
    if (!chartMode && ratings.length)
      setChartMode(
        MODES.reduce(
          (best, m) =>
            (ratings.find(r => r.mode === m.id)?.games || 0) >
            (ratings.find(r => r.mode === best)?.games || 0)
              ? m.id
              : best,
          'natural' as Mode,
        ),
      )
  }, [ratings, chartMode])
  useEffect(() => {
    if (!chartMode) return
    let live = true
    setChartError('')
    rpc<RatedGame[]>('my_rating_history', { p_mode: chartMode })
      .then(games => {
        if (live) setChart({ mode: chartMode, games })
      })
      .catch(e => {
        if (live) setChartError(errorMessage(e))
      })
    return () => {
      live = false
    }
  }, [chartMode, me])
  // Natural Durak results by table size (3–8 players), from public.my_player_count_stats.
  const [bySize, setBySize] = useState<
    { player_count: number; games: number; losses: number; elo_change: number | string }[] | null
  >(null)
  useEffect(() => {
    let live = true
    rpc<typeof bySize>('my_player_count_stats', { p_mode: 'natural' })
      .then(r => {
        if (live) setBySize(r || [])
      })
      .catch(e => {
        console.error(e)
        if (live) setBySize([])
      })
    return () => {
      live = false
    }
  }, [me, ratings])
  // Natural Durak: losses Elo expected (from everyone's pre-round rating) against actual ones (public.my_expected_losses).
  const [expectation, setExpectation] = useState<
    | { player_count: number; games: number; losses: number | string; expected_losses: number | string }[]
    | null
  >(null)
  useEffect(() => {
    let live = true
    rpc<NonNullable<typeof expectation>>('my_expected_losses', { p_mode: 'natural' })
      .then(r => {
        if (live) setExpectation(r || [])
      })
      .catch(e => {
        console.error(e)
        if (live) setExpectation([])
      })
    return () => {
      live = false
    }
  }, [me, ratings])
  // Natural Durak: how often you lose with each player at the table, against your fair share (public.my_table_effect).
  const [mates, setMates] = useState<TableMate[] | null>(null)
  useEffect(() => {
    let live = true
    rpc<TableMate[]>('my_table_effect', { p_mode: 'natural' })
      .then(r => {
        if (live)
          setMates(
            (r || []).filter(m => m.games >= MIN_TABLE_GAMES).sort((x, y) => tableEffect(y) - tableEffect(x)),
          )
      })
      .catch(e => {
        console.error(e)
        if (live) setMates([])
      })
    return () => {
      live = false
    }
  }, [me, ratings])
  const saveName = () =>
    void action(async () => {
      await rpc('set_username', { p_username: name.trim() })
      await reload()
      setAccountNotice('Username updated.')
    })
  const saveEmail = () =>
    void action(async () => {
      if (!accountEmail.trim()) throw new Error('Enter an email address.')
      const { data, error } = await supabase.auth.updateUser({ email: accountEmail.trim() })
      if (error) throw error
      setAccountNotice(
        data.user?.new_email
          ? 'Email change pending. Follow the verification instructions sent to your email.'
          : 'Email update requested. If Supabase sends confirmation links, complete them to finish.',
      )
    })
  const savePassword = () =>
    void action(async () => {
      if (nextPassword.length < 10) throw new Error('New password must be at least 10 characters.')
      if (!oldPassword) throw new Error('Enter your current password.')
      const { data: user, error: userError } = await supabase.auth.getUser()
      if (userError || !user.user?.email) throw userError || new Error('Cannot determine current email.')
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: user.user.email,
        password: oldPassword,
      })
      if (loginError) throw new Error('Current password is incorrect.')
      const { error: updateError } = await supabase.auth.updateUser({ password: nextPassword })
      if (updateError) throw updateError
      setOldPassword('')
      setNextPassword('')
      setAccountNotice('Password changed.')
    })
  return (
    <div className="stack page pageEntry">
      {blue ? (
        <header className="profileHero">
          <Avatar id={me} name={who} me={me} size="lg" />
          <div>
            <h1>{who}</h1>
            {accountEmail && <p>{accountEmail}</p>}
          </div>
        </header>
      ) : (
        <header className="profileHero">
          <span className="seat mine heroPlayer" aria-hidden="true">
            <span className="seatInitials">{who.slice(0, 2).toUpperCase()}</span>
          </span>
          <div>
            <h1>{who}</h1>
          </div>
        </header>
      )}
      <dl className="statRow">
        <div>
          <dt>Games</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>Wins</dt>
          <dd>{wins}</dd>
        </div>
        <div>
          <dt>Losses</dt>
          <dd>{losses}</dd>
        </div>
      </dl>
      <section aria-labelledby="my-ratings-title">
        <h2 id="my-ratings-title" className="sectionTitle">
          Your ratings
        </h2>
        <ul className="modeRows">
          {MODES.map(m => {
            const r = ratings.find(r => r.mode === m.id)
            return (
              <li key={m.id} className="modeRow">
                {blue ? (
                  <span className={`rowSuit ${MODE_CARD[m.id].red ? 'red' : ''}`} aria-hidden="true">
                    {MODE_CARD[m.id].suit}
                  </span>
                ) : (
                  <MiniModeCard mode={m.id} />
                )}
                <span className="modeText">
                  <b>{m.name}</b>
                  <small>
                    {r?.games || 0} games · {r?.losses || 0} losses
                  </small>
                  {streakLabel(r?.loss_streak) && (
                    <small className={`streakNote ${streakPenaltyNext(r?.loss_streak) ? 'warn' : ''}`}>
                      {streakLabel(r?.loss_streak)}
                    </small>
                  )}
                </span>
                <strong className="modeRowRating">{formatRating(r?.rating || 1200)}</strong>
              </li>
            )
          })}
        </ul>
      </section>
      {total >= 10 ? (
        <section className="stack sm" aria-labelledby="stats-title">
          <h2 id="stats-title">Statistics</h2>
          <dl className="statsGrid">
            <div>
              <dt>Win rate</dt>
              <dd>{total ? Math.round((100 * wins) / total) : 0}%</dd>
            </div>
            <div>
              <dt>Honest self-votes</dt>
              <dd>{admissions}</dd>
            </div>
            <div>
              <dt>Modes played</dt>
              <dd>{ratings.filter(r => r.games > 0).length}</dd>
            </div>
            <div>
              <dt>Games with a result</dt>
              <dd>{total}</dd>
            </div>
          </dl>
          <h3 className="subTitle">Expected vs. actual losses</h3>
          {!expectation ? (
            <p className="emptyNote">Loading…</p>
          ) : expectation.length ? (
            (() => {
              const exp = expectation.reduce((t, r) => t + Number(r.expected_losses), 0),
                act = expectation.reduce((t, r) => t + Number(r.losses), 0),
                games = expectation.reduce((t, r) => t + r.games, 0),
                diff = act - exp
              const one = (x: number) =>
                x.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
              return (
                <div className="duelCard">
                  <p className="duelVerdict">
                    {Math.abs(diff) < 0.5
                      ? 'Right where Elo expects you.'
                      : diff < 0
                        ? `You've lost ${one(-diff)} fewer games than Elo expected.`
                        : `You've lost ${one(diff)} more games than Elo expected.`}
                  </p>
                  <div className="duelScore">
                    <div>
                      <b>{one(act)}</b>
                      <small>Actual losses</small>
                    </div>
                    <span aria-hidden="true">vs</span>
                    <div>
                      <b>{one(exp)}</b>
                      <small>Expected by Elo</small>
                    </div>
                  </div>
                  <ul className="expectRows">
                    {expectation.map(r => {
                      const d = Number(r.losses) - Number(r.expected_losses)
                      return (
                        <li key={r.player_count}>
                          <span>
                            {r.player_count} players{' '}
                            <small>
                              · {r.games} {r.games === 1 ? 'game' : 'games'}
                            </small>
                          </span>
                          <span>
                            {one(Number(r.losses))} vs {one(Number(r.expected_losses))}
                          </span>
                          <strong className={Math.abs(d) < 0.05 ? '' : d < 0 ? 'gainDelta' : 'lossDelta'}>
                            {d >= 0.05 ? '+' : d <= -0.05 ? '−' : '±'}
                            {one(Math.abs(d))}
                          </strong>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="fieldHint">
                    Over {games} rated Natural Durak {games === 1 ? 'game' : 'games'}. Expected losses add up
                    each game's chance of you being the Durak, from everyone's Elo when the round started (the
                    same estimate shown at the table). A shared loss is split between the players who shared
                    it. Fewer losses than expected means you're playing better than your rating says; more
                    means your rating is ahead of your results.
                  </p>
                </div>
              )
            })()
          ) : (
            <p className="emptyNote">
              Finish a rated Natural Durak game to compare your losses with what Elo expected.
            </p>
          )}
          <h3 className="subTitle">Durak by number of players</h3>
          <ul className="modeRows">
            {[3, 4, 5, 6, 7, 8].map(n => {
              const r = bySize?.find(x => x.player_count === n),
                g = r?.games || 0,
                elo = Number(r?.elo_change || 0)
              return (
                <li key={n} className="modeRow">
                  <span className="sizeBadge" aria-hidden="true">
                    {n}
                  </span>
                  <span className="modeText">
                    <b>{n} players</b>
                    <small>
                      {!bySize
                        ? 'Loading…'
                        : g
                          ? `${g} ${g === 1 ? 'game' : 'games'} · lost ${r!.losses} (${Math.round((100 * r!.losses) / g)}%, fair share ${Math.round(100 / n)}%)`
                          : 'No games yet'}
                    </small>
                  </span>
                  <strong className={`modeRowRating ${g ? (elo < 0 ? 'lossDelta' : 'gainDelta') : ''}`}>
                    {g ? `${elo >= 0 ? '+' : '−'}${Math.abs(elo).toFixed(1)}` : '—'}
                  </strong>
                </li>
              )
            })}
          </ul>
          <p className="fieldHint">
            Rated Natural Durak games only. Fair share is how often you'd lose if everyone played equally well
            (1 in 3 at a 3-player table, 1 in 4 at 4, and so on); the number on the right is your net Elo
            change at that table size.
          </p>
          <h3 className="subTitle">Who's at the table</h3>
          {!mates ? (
            <p className="emptyNote">Loading…</p>
          ) : mates.length ? (
            <>
              {mates.length > 1 && (
                <dl className="statsGrid">
                  <div>
                    <dt>Toughest to play with</dt>
                    <dd>{mates[0].username}</dd>
                  </div>
                  <div>
                    <dt>Easiest to play with</dt>
                    <dd>{mates[mates.length - 1].username}</dd>
                  </div>
                </dl>
              )}
              <ul className="modeRows">
                {mates.map(m => {
                  const e = Math.round(tableEffect(m))
                  return (
                    <li key={m.user_id} className="modeRow">
                      <span className="modeText">
                        <b>
                          <PlayerName id={m.user_id} name={m.username} />
                        </b>
                        <small>
                          {m.games} games together · you lost {m.losses} (
                          {Math.round((100 * m.losses) / m.games)}%, fair share{' '}
                          {Math.round((100 * Number(m.expected_losses)) / m.games)}%)
                        </small>
                      </span>
                      <strong className={`modeRowRating ${e > 0 ? 'lossDelta' : e < 0 ? 'gainDelta' : ''}`}>
                        {e > 0 ? '+' : e < 0 ? '−' : '±'}
                        {Math.abs(e)}%
                      </strong>
                    </li>
                  )
                })}
              </ul>
              <p className="fieldHint">
                Rated Natural Durak games with at least {MIN_TABLE_GAMES} games together. The number on the
                right is how much more (+) or less (−) often you lose with them at the table than your fair
                share, in percentage points.
              </p>
            </>
          ) : (
            <p className="emptyNote">
              Play {MIN_TABLE_GAMES} Natural Durak games with someone to see how you do when they're at the
              table.
            </p>
          )}
          <h3 className="subTitle">Rating over time</h3>
          {chartMode && <ModeChips mode={chartMode} setMode={setChartMode} />}
          <div className="chartCard">
            <h3>{modeInfo(chartMode || 'natural').name}</h3>
            {chartError ? (
              <p className="emptyNote" role="alert">
                {chartError}
              </p>
            ) : !chart || chart.mode !== chartMode ? (
              <p className="emptyNote">Loading…</p>
            ) : chart.games.length ? (
              <RatingChart games={chart.games} modeName={modeInfo(chart.mode).name} />
            ) : (
              <p className="emptyNote">
                No rated {modeInfo(chart.mode).name} games yet. Your chart starts at 1,200 with your first
                result.
              </p>
            )}
          </div>
          <h3 className="subTitle">Recent rating changes</h3>
          <ul className="modeRows">
            {ledger.slice(0, 8).map(entry => (
              <li key={entry.game_id} className="modeRow">
                <span className="modeText">
                  <b>{modeInfo(entry.mode).name}</b>
                  <small>{date(entry.recorded_at)}</small>
                </span>
                <strong className={`modeRowRating ${entry.delta < 0 ? 'lossDelta' : 'gainDelta'}`}>
                  {entry.delta >= 0 ? '+' : '−'}
                  {Math.abs(entry.delta).toFixed(1)}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="unlock" aria-labelledby="stats-title">
          <h2 id="stats-title" className="sectionTitle">
            Statistics
          </h2>
          <div className="unlockCards" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={i < total ? 'on' : ''} />
            ))}
          </div>
          <p>
            Statistics unlock after 10 games with a confirmed result. {Math.max(0, 10 - total)} more to go.
          </p>
        </section>
      )}
      <section aria-labelledby="look-title">
        <h2 id="look-title" className="sectionTitle">
          Appearance
        </h2>
        <div className="themePicker" role="group" aria-label="Theme">
          {THEMES.map(t => (
            <button
              key={t.id}
              aria-pressed={theme === t.id}
              className={`themeOption ${t.id} ${theme === t.id ? 'on' : ''}`}
              onClick={() => setTheme(t.id)}
            >
              <span className="themeSwatch" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="rowText">
                <b>{t.name}</b>
                <small>{t.description}</small>
              </span>
            </button>
          ))}
        </div>
        <label className="toggleRow">
          <span className="rowText">
            <b>Show losing chances</b>
            <small>At the table, each player's estimated chance of being the Durak, from Elo.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={showChances}
            onChange={e => setShowChances(e.target.checked)}
          />
        </label>
        <p className="fieldHint">Saved on this device.</p>
      </section>
      <section className="card accountCard" aria-labelledby="account-title">
        <h2 id="account-title">Account</h2>
        <form
          onSubmit={e => {
            e.preventDefault()
            saveName()
          }}
        >
          <label className="field">
            Display username
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={22}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <Button type="submit" kind="outline">
            Save username
          </Button>
        </form>
        <form
          onSubmit={e => {
            e.preventDefault()
            saveEmail()
          }}
        >
          <label className="field">
            Email address
            <input
              type="email"
              autoComplete="email"
              value={accountEmail}
              onChange={e => setAccountEmail(e.target.value)}
            />
          </label>
          <p className="fieldHint">
            Keep Secure email change enabled in Supabase. Email changes may require confirmation of the old
            and new addresses.
          </p>
          <Button type="submit" kind="outline">
            Update email
          </Button>
        </form>
        <form
          onSubmit={e => {
            e.preventDefault()
            savePassword()
          }}
        >
          <label className="field">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
            />
          </label>
          <label className="field">
            New password
            <input
              type="password"
              minLength={10}
              autoComplete="new-password"
              aria-describedby="new-password-hint"
              value={nextPassword}
              onChange={e => setNextPassword(e.target.value)}
            />
          </label>
          <p id="new-password-hint" className="fieldHint">
            At least 10 characters
          </p>
          <Button type="submit" kind="outline">
            Change password
          </Button>
        </form>
        {accountNotice && (
          <p className="accountNotice" role="status">
            {accountNotice}
          </p>
        )}
        <Button kind="danger" onClick={() => void supabase.auth.signOut()}>
          Sign out <LogOut size={17} />
        </Button>
      </section>
    </div>
  )
}
