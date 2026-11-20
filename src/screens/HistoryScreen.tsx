import { useCallback, useEffect, useState } from 'react'
import { errorMessage, modeInfo, rpc } from '../lib'
import type { Game, GameDetails, HistoryGame } from '../lib'
import { streakLabel } from '../lossStreak'
import { Button, MODE_CARD, PlayerName, dateTime, deltaClass, listNames, signed } from '../ui'

// Personal game history: every result the player took part in, from the server's ledger (nothing is re-rated here).
const HISTORY_PAGE = 20

const elo = (r: number) => r.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const resultText = (state: Game['state'], losers: string[]) =>
  state === 'confirmed'
    ? `${capitalize(losers[0] || 'someone')} lost`
    : state === 'tied'
      ? `Shared loss: ${listNames(losers)}`
      : state === 'void'
        ? 'Reversed after a correction vote'
        : state === 'unresolved'
          ? 'No result'
          : 'Waiting for a result'

const STATE_TEXT: Partial<Record<Game['state'], string>> = {
  confirmed: 'Confirmed result.',
  tied: 'Shared loss, accepted by everyone tied.',
  void: 'Reversed after a correction vote: this game no longer counts for ratings.',
  unresolved: 'No result: the vote ended without a clear loser, so ratings did not change.',
}

const CORRECTION_TEXT: Record<string, string> = {
  open: 'A correction vote is open.',
  rejected: 'A correction was requested and rejected.',
  expired: 'A correction request expired.',
}

export function HistoryScreen({ me }: { me: string }) {
  const [games, setGames] = useState<HistoryGame[]>([]),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false),
    [open, setOpen] = useState<string | null>(null),
    [error, setError] = useState('')
  const fetchPage = useCallback(async (before: string | null) => {
    setLoading(true)
    setError('')
    try {
      const rows = await rpc<HistoryGame[]>('my_game_history', { p_before: before, p_limit: HISTORY_PAGE })
      setGames(g => (before ? [...g, ...rows] : rows))
      setMore(rows.length === HISTORY_PAGE)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void fetchPage(null)
  }, [fetchPage, me])
  return (
    <div className="stack page pageEntry">
      <header className="pageHead">
        <h1>History</h1>
        <p>Your games in every mode, newest first. Tap a game to see everyone's rating change.</p>
      </header>
      {error && (
        <p className="emptyNote" role="alert">
          {error}
        </p>
      )}
      {games.length ? (
        <ol className="gameLog">
          {games.map(g => (
            <HistoryItem
              key={g.game_id}
              game={g}
              me={me}
              open={open === g.game_id}
              toggle={() => setOpen(o => (o === g.game_id ? null : g.game_id))}
            />
          ))}
        </ol>
      ) : loading ? (
        <p className="emptyNote">Loading…</p>
      ) : (
        !error && <p className="emptyNote">No games yet. A game shows up here once its vote is final.</p>
      )}
      {more && (
        <Button
          kind="outline"
          className="wide"
          disabled={loading}
          onClick={() => void fetchPage(games[games.length - 1].game_id)}
        >
          {loading ? 'Loading…' : 'Show older games'}
        </Button>
      )}
    </div>
  )
}

function HistoryItem({
  game: g,
  me,
  open,
  toggle,
}: {
  game: HistoryGame
  me: string
  open: boolean
  toggle: () => void
}) {
  const [details, setDetails] = useState<GameDetails | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    if (!open || details) return
    let live = true
    rpc<GameDetails>('game_details', { p_game: g.game_id })
      .then(d => {
        if (live) setDetails(d)
      })
      .catch(e => {
        if (live) setError(errorMessage(e))
      })
    return () => {
      live = false
    }
  }, [open, details, g.game_id])
  const card = MODE_CARD[g.mode],
    panel = `game-${g.game_id}`,
    delta = Number(g.delta),
    extra = Number(g.streak_extra ?? 0)
  const losers = g.loser_ids.map((id, i) => (id === me ? 'you' : g.loser_names[i]))
  return (
    <li className={`logItem ${g.state}`}>
      <button className="logSummary" aria-expanded={open} aria-controls={panel} onClick={toggle}>
        <span className={`logSuit ${card.red ? 'red' : ''}`} aria-hidden="true">
          {card.suit}
        </span>
        <span className="logMain">
          <b>
            {modeInfo(g.mode).name}
            {g.games_in_round > 1 && (
              <span className="logGame">
                {' '}
                · Game {g.slot} of {g.games_in_round}
              </span>
            )}
          </b>
          <small>
            {dateTime(g.played_at)} · <span className="nowrap">{g.player_count} players</span>
          </small>
          <small className="logResult">{resultText(g.state, losers)}</small>
          <small className="logElo">
            Elo {elo(Number(g.rating_before))} → {elo(Number(g.rating_after))}
          </small>
          {g.streak_penalty && (
            <small className="logStreak">
              <span className="streakTag">
                {extra < 0
                  ? streakLabel(g.loss_streak)
                  : extra > 0
                    ? 'Streak penalty share'
                    : 'Losing-streak penalty'}
              </span>
              {extra !== 0 && <span className="streakAmount">{signed(extra)}</span>}
            </small>
          )}
        </span>
        <span className="logRating">
          <strong className={deltaClass(delta)} aria-label={`Rating change ${signed(delta)}`}>
            {signed(delta)}
          </strong>
        </span>
      </button>
      {open && (
        <div className="logDetails" id={panel}>
          {error ? (
            <p className="fieldError" role="alert">
              {error}
            </p>
          ) : !details ? (
            <p className="logMeta">Loading…</p>
          ) : (
            <>
              <p className="logStatus">
                {STATE_TEXT[details.state] || resultText(details.state, [])}
                {details.correction && CORRECTION_TEXT[details.correction]
                  ? ` ${CORRECTION_TEXT[details.correction]}`
                  : ''}
              </p>
              {details.streak_penalty && (
                <p className="logMeta">
                  Losing-streak penalty: from the 4th loss in a row in a mode, a loss costs 25% more, and the
                  extra goes to the winners in proportion to their gains.
                </p>
              )}
              <p className="logMeta">
                Played {dateTime(details.played_at)}
                {details.finalized_at && ` · result recorded ${dateTime(details.finalized_at)}`}
              </p>
              <ul className="logPlayers" aria-label="Players">
                {details.players.map(p => (
                  <li key={p.user_id}>
                    <span className="logName">
                      <b>
                        <PlayerName id={p.user_id} name={p.username} />
                        {p.user_id === me && ' (you)'}
                      </b>
                      {p.lost && (
                        <span className="lostTag">
                          {details.state === 'tied'
                            ? 'shared loss'
                            : details.state === 'void'
                              ? 'voted loser'
                              : 'lost'}
                        </span>
                      )}
                      {Number(p.streak_extra ?? 0) < 0 && (
                        <span className="streakTag">{streakLabel(p.loss_streak)}</span>
                      )}
                    </span>
                    <span className="logRating">
                      <strong className={deltaClass(Number(p.delta))}>
                        {p.delta == null ? '–' : signed(Number(p.delta))}
                      </strong>
                      {p.rating_before != null && p.rating_after != null && (
                        <small>
                          {elo(Number(p.rating_before))} → {elo(Number(p.rating_after))}
                        </small>
                      )}
                      {Number(p.streak_extra ?? 0) !== 0 && (
                        <small>incl. {signed(Number(p.streak_extra))} streak</small>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {g.games_in_round > 1 && (
                <p className="logMeta">
                  Both games of a round are rated from everyone's rating at the start of the round. Before and
                  after show the running total.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}
