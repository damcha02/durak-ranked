import { createContext, useContext, useEffect, useRef } from 'react'
import { MODES } from './lib'
import type { Mode, TableRow } from './lib'
import { formatChance } from './lossChance'
import type { Chance } from './lossChance'
import type { Theme } from './theme'

export type Page = 'home' | 'history' | 'leaderboard' | 'friends' | 'profile'

// Players appear in the rankings only after this many games in the mode.
export const MIN_RANKED_GAMES = 5

export const MIN_FRIEND_GAMES = 2 // friends standings also show players still short of the ranking minimum

export type Action = (fn: () => Promise<unknown>) => Promise<void>

export const formatRating = (rating: number) => Math.round(rating).toLocaleString()

export const dateTime = (s: string) => {
  const d = new Date(s)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const APP_NAME = 'Durak Ranked'

// Every game mode is a card with a corner index (abbreviation + suit). \uFE0E keeps iOS from drawing the suits as emoji.
export const MODE_CARD: Record<Mode, { abbr: string; suit: string; red: boolean }> = {
  natural: { abbr: 'D', suit: '\u2660\uFE0E', red: false },
  double_single: { abbr: 'DS', suit: '\u2663\uFE0E', red: false },
  single_double: { abbr: 'SD', suit: '\u2665\uFE0E', red: true },
  double_double: { abbr: 'DD', suit: '\u2666\uFE0E', red: true },
}

export const CornerIndex = ({ mode, flip = false }: { mode: Mode; flip?: boolean }) => (
  <span
    className={`cornerIndex ${MODE_CARD[mode].red ? 'red' : ''} ${flip ? 'flip' : ''}`}
    aria-hidden="true"
  >
    {MODE_CARD[mode].abbr}
    <br />
    {MODE_CARD[mode].suit}
  </span>
)

export const MiniModeCard = ({ mode }: { mode: Mode }) => (
  <span className={`miniCard ${MODE_CARD[mode].red ? 'red' : ''}`} aria-hidden="true">
    <span className="miniIndex">{MODE_CARD[mode].abbr}</span>
    {MODE_CARD[mode].suit}
  </span>
)

export const Brand = () => (
  <span className="brand">
    <span className="brandMark" aria-hidden="true">
      {'\u2660\uFE0E'}
    </span>
    <span>{APP_NAME}</span>
  </span>
)

const NAV: { id: Page; label: string; suit: string; red: boolean }[] = [
  { id: 'home', label: 'Home', suit: '\u2660\uFE0E', red: false },
  { id: 'history', label: 'History', suit: '\u21BA\uFE0E', red: false },
  { id: 'leaderboard', label: 'Rankings', suit: '\u2663\uFE0E', red: false },
  { id: 'friends', label: 'Friends', suit: '\u2665\uFE0E', red: true },
  { id: 'profile', label: 'Profile', suit: '\u2666\uFE0E', red: true },
]

// A closed table keeps status 'lobby' on the server; closed_at is what marks it.
export type TableStatus = TableRow['status'] | 'closed'

export const statusOf = (t: TableRow): TableStatus => (t.closed_at ? 'closed' : t.status)

export const STATUS_TEXT: Record<TableStatus, string> = {
  lobby: 'Waiting for players',
  playing: 'Game in progress',
  results: 'Recording results',
  closed: 'Closed due to inactivity',
}

export function Button({
  children,
  onClick,
  kind = 'primary',
  disabled = false,
  className = '',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  kind?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button type={type} className={`button ${kind} ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

// Two looks share every screen: "cards" (card stock, corner indices) and "blue" (the light-blue prototype).
// Where the layouts differ, components branch on useBlue(); data loading and actions are shared.
// Friend relations, so any name in the app can offer "Add friend" (see PlayerName).
export type Rel = 'none' | 'friend' | 'sent' | 'incoming'

export const FriendCtx = createContext<{
  me: string
  rel: (id: string) => Rel
  pick: (id: string, name: string) => void
}>({ me: '', rel: () => 'none', pick: () => {} })

/** A player's name; tapping another player's name opens the add-friend sheet. */
export function PlayerName({ id, name }: { id: string; name: string }) {
  const f = useContext(FriendCtx)
  if (!id || id === f.me) return <>{name}</>
  return (
    <button
      type="button"
      className="nameLink"
      onClick={e => {
        e.stopPropagation()
        f.pick(id, name)
      }}
    >
      {name}
    </button>
  )
}

export const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'blue',
  setTheme: () => {},
})

export const useBlue = () => useContext(ThemeContext).theme === 'blue'

// Soft avatar tints for the blue theme, picked from the user id so each player keeps one colour; you are always the action tint.
const TINTS = ['#F1DCCF', '#D9E8DC', '#ECE3C8', '#E2DDEE', '#F3E1E8']

export const tint = (id: string, me?: string) =>
  id === me ? '#D6E6F2' : TINTS[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % TINTS.length]

export const Avatar = ({
  id,
  name,
  me,
  size = '',
}: {
  id: string
  name: string
  me?: string
  size?: string
}) => (
  <span className={`tintAvatar ${size}`} style={{ background: tint(id, me) }} aria-hidden="true">
    {name.slice(0, 2).toUpperCase()}
  </span>
)

export const listNames = (names: string[]) =>
  names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

// Tiny italic line under a player's name: Elo in the table's mode and the estimated chance of being the Durak, with a bar.
export const ChanceLine = ({ chance }: { chance: Chance }) => (
  <span className="lossChance" title="Estimated from Elo, not a prediction">
    <span className="chanceBar" aria-hidden="true">
      <span style={{ width: `${100 * chance.p}%` }} />
    </span>
    <span>{formatChance(chance.p)} to lose</span>
    <span>· {formatRating(chance.rating)} Elo</span>
  </span>
)

export const SuitBox = ({ mode }: { mode: Mode }) => (
  <span className={`suitBox ${MODE_CARD[mode].red ? 'red' : ''}`} aria-hidden="true">
    {MODE_CARD[mode].suit}
  </span>
)

// Bottom sheet (blue theme): pickers and the invite open over the page so you keep your place.
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null),
    close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const back = document.activeElement as HTMLElement | null
    const focusable = () =>
      [...(panel.current?.querySelectorAll<HTMLElement>('button,a[href],input,select') || [])].filter(
        el => !el.hasAttribute('disabled'),
      )
    ;(panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]') || focusable()[0])?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0],
        last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      back?.focus()
    }
  }, [open])
  return (
    <>
      <div className={`scrim ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`sheet ${open ? 'open' : ''}`}
        inert={!open}
      >
        <span className="sheetGrip" aria-hidden="true" />
        <div className="sheetHead">
          <h2>{title}</h2>
          <button className="linkButton plain" onClick={onClose}>
            Done
          </button>
        </div>
        {children}
      </div>
    </>
  )
}

// Suits double as tab icons in the cards theme; the blue theme shows labels on a sliding pill.
// Rendered twice (bottom bar on phones, header on desktop); CSS shows one.
export function NavTabs({
  page,
  go,
  className,
}: {
  page: Page | null
  go: (p: Page) => void
  className: string
}) {
  const index = NAV.findIndex(n => n.id === page)
  return (
    <nav className={className} aria-label="Main">
      {index >= 0 && (
        <span className="navPill" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }} />
      )}
      {NAV.map(n => (
        <button
          key={n.id}
          className={`${page === n.id ? 'on' : ''} ${n.red ? 'red' : ''}`}
          aria-current={page === n.id ? 'page' : undefined}
          onClick={() => go(n.id)}
        >
          <span className="navSuit" aria-hidden="true">
            {n.suit}
          </span>
          <span>{n.label}</span>
        </button>
      ))}
    </nav>
  )
}

// Game-mode switch shared by Rankings and Groups: one chip per mode, with its suit.
export function ModeChips({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="modeChips" role="group" aria-label="Game mode">
      {MODES.map(m => (
        <button
          key={m.id}
          aria-pressed={mode === m.id}
          className={`${mode === m.id ? 'on' : ''} ${MODE_CARD[m.id].red ? 'red' : ''}`}
          onClick={() => setMode(m.id)}
        >
          <span className="chipSuit" aria-hidden="true">
            {MODE_CARD[m.id].suit}
          </span>
          {m.name}
        </button>
      ))}
    </div>
  )
}
