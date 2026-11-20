import type { Session } from '@supabase/supabase-js'
import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { authLinkError, configured, errorMessage, recoveryLink, rpc, supabase } from './lib'
import type { Profile } from './lib'
import { readShowChances, saveShowChances } from './lossChance'
import { AuthScreen, NewPasswordScreen } from './screens/AuthScreen'
import { FriendStats, FriendsScreen } from './screens/FriendsScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { HomeScreen } from './screens/HomeScreen'
import { LeaderboardScreen } from './screens/LeaderboardScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { TableScreen } from './screens/TableScreen'
import { applyTheme, readTheme, saveTheme } from './theme'
import type { Theme } from './theme'
import { APP_NAME, Brand, Button, FriendCtx, NavTabs, Sheet, ThemeContext, tint } from './ui'
import type { Action, Page, Rel } from './ui'

const getJoinCode = () => new URLSearchParams(location.search).get('join')?.trim().toUpperCase() || ''

export default function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [profile, setProfile] = useState<Profile | null>(null)
  const [page, setPage] = useState<Page>('home'),
    [tableId, setTableId] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const [joinCode, setJoinCode] = useState(getJoinCode())
  const [friendRows, setFriendRows] = useState<
      { other: string; status: 'pending' | 'accepted'; mine: boolean }[]
    >([]),
    [person, setPerson] = useState<{ id: string; name: string } | null>(null)
  const [theme, setThemeState] = useState<Theme>(readTheme)
  // True from opening a password-reset link until the new password is saved.
  const [recovering, setRecovering] = useState(recoveryLink)
  const [showChances, setShowChancesState] = useState(readShowChances)
  const setShowChances = (show: boolean) => {
    setShowChancesState(show)
    saveShowChances(show)
  }
  const themeValue = useMemo(
    () => ({
      theme,
      setTheme: (t: Theme) => {
        setThemeState(t)
        saveTheme(t)
        applyTheme(t)
      },
    }),
    [theme],
  )
  const user = session?.user
  const reloadProfile = useCallback(async () => {
    if (!user) return
    const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    if (error) throw error
    setProfile(data as Profile)
  }, [user?.id])
  useEffect(() => {
    let valid = true
    void supabase.auth.getSession().then(({ data }) => {
      if (valid) {
        setSession(data.session)
        setLoading(false)
      }
    })
    const { subscription } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      setSession(s)
      setLoading(false)
    }).data
    return () => {
      valid = false
      subscription.unsubscribe()
    }
  }, [])
  useEffect(() => {
    if (user) {
      void reloadProfile().catch(e => setMessage(errorMessage(e)))
    } else setProfile(null)
  }, [user?.id, reloadProfile])
  useEffect(() => {
    if (!joinCode || !user) return
    const c = joinCode
    setJoinCode('')
    void (async () => {
      try {
        setBusy(true)
        const id = await rpc<string>('join_table', { p_code: c })
        setTableId(id)
        history.replaceState(null, '', location.pathname)
      } catch (e) {
        setMessage(errorMessage(e))
      } finally {
        setBusy(false)
      }
    })()
  }, [user?.id, joinCode])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [page, tableId])
  // The client leaves a failed link's #error=… in the address bar; the sign-in screen has already read it.
  useEffect(() => {
    if (authLinkError) history.replaceState(null, '', location.pathname + location.search)
  }, [])
  const loadFriends = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.from('friendships').select('*')
    setFriendRows(
      (data || []).map(f => ({
        other: f.user_a === user.id ? f.user_b : f.user_a,
        status: f.status,
        mine: f.requested_by === user.id,
      })),
    )
  }, [user?.id])
  useEffect(() => {
    void loadFriends().catch(console.error)
  }, [loadFriends])
  const friendCtx = useMemo(
    () => ({
      me: user?.id || '',
      rel: (id: string): Rel => {
        const r = friendRows.find(x => x.other === id)
        return !r ? 'none' : r.status === 'accepted' ? 'friend' : r.mine ? 'sent' : 'incoming'
      },
      pick: (id: string, name: string) => {
        setPerson({ id, name })
        void loadFriends().catch(console.error)
      },
    }),
    [user?.id, friendRows, loadFriends],
  )
  const action: Action = async fn => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await fn()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  // Screen transitions: opening a table moves forward, leaving it moves back, switching tabs crossfades (CSS decides how each theme animates).
  const screenKey = tableId ? `table-${tableId}` : page,
    depth = tableId ? 2 : 1
  const nav = useRef({ key: screenKey, depth, dir: 'fade' })
  if (nav.current.key !== screenKey)
    nav.current = {
      key: screenKey,
      depth,
      dir: depth > nav.current.depth ? 'forward' : depth < nav.current.depth ? 'back' : 'fade',
    }
  const themed = (content: React.ReactNode) => (
    <ThemeContext.Provider value={themeValue}>
      <FriendCtx.Provider value={friendCtx}>{content}</FriendCtx.Provider>
    </ThemeContext.Provider>
  )
  if (!configured)
    return themed(
      <div className="setup">
        <Brand />
        <h1>Connect your backend</h1>
        <p>
          Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to a{' '}
          <code>.env</code> file, then restart Vite.
        </p>
        <p className="muted">See README.md for the complete Supabase setup.</p>
      </div>,
    )
  if (loading)
    return themed(
      <div className="loading" role="status">
        <Brand />
        <p>Loading {APP_NAME}…</p>
      </div>,
    )
  if (!session) return themed(<AuthScreen joinCode={joinCode} />)
  if (recovering)
    return themed(
      <NewPasswordScreen
        onDone={() => {
          setRecovering(false)
          setMessage("Password changed. You're signed in.")
        }}
      />,
    )
  const initials = (profile?.username || 'U').slice(0, 2).toUpperCase()
  const go = (p: Page) => {
    setTableId(null)
    setPage(p)
  }
  return themed(
    <div className="appShell">
      <header className="topbar">
        <div className="topbarInner">
          <button className="brandButton" aria-label={`${APP_NAME}, home`} onClick={() => go('home')}>
            <Brand />
          </button>
          <NavTabs className="headerNav" page={tableId ? 'home' : page} go={go} />
          <button
            className="avatar"
            aria-label="Your profile"
            title="Your profile"
            onClick={() => go('profile')}
          >
            <span style={theme === 'blue' ? { background: tint(user!.id, user!.id) } : undefined}>
              {initials}
            </span>
          </button>
        </div>
      </header>
      <main className="main withNav">
        <div key={screenKey} className={`screen enter-${nav.current.dir}`}>
          {tableId ? (
            <TableScreen
              key={tableId}
              tableId={tableId}
              me={user!.id}
              action={action}
              busy={busy}
              showChances={showChances}
              openTable={setTableId}
              openHistory={() => go('history')}
              onLeave={() => {
                setTableId(null)
                setPage('home')
              }}
            />
          ) : page === 'history' ? (
            <HistoryScreen me={user!.id} />
          ) : page === 'home' ? (
            <HomeScreen
              me={user!.id}
              profile={profile}
              openTable={setTableId}
              openRankings={() => setPage('leaderboard')}
              action={action}
              busy={busy}
            />
          ) : page === 'leaderboard' ? (
            <LeaderboardScreen me={user!.id} />
          ) : page === 'friends' ? (
            <FriendsScreen me={user!.id} action={action} busy={busy} />
          ) : (
            <ProfileScreen
              me={user!.id}
              profile={profile}
              action={action}
              reload={reloadProfile}
              showChances={showChances}
              setShowChances={setShowChances}
            />
          )}
        </div>
      </main>
      <NavTabs className="bottomNav" page={tableId ? 'home' : page} go={go} />
      <Sheet open={Boolean(person)} title={person?.name || 'Player'} onClose={() => setPerson(null)}>
        {person &&
          (() => {
            const rel = friendCtx.rel(person.id),
              act = (fn: () => Promise<unknown>) =>
                void action(async () => {
                  await fn()
                  await loadFriends()
                })
            return (
              <div className="stack sm">
                {rel === 'friend' && <FriendStats key={person.id} id={person.id} name={person.name} />}
                {rel === 'sent' && <p>You asked {person.name} to be friends. Waiting for them to accept.</p>}
                {rel === 'incoming' && (
                  <>
                    <p>{person.name} wants to be your friend.</p>
                    <Button
                      className="wide"
                      disabled={busy}
                      onClick={() =>
                        act(() => rpc('respond_friend_request', { p_user: person.id, p_accept: true }))
                      }
                    >
                      Accept
                    </Button>
                  </>
                )}
                {rel === 'none' && (
                  <Button
                    className="wide"
                    disabled={busy}
                    onClick={() => act(() => rpc('send_friend_request', { p_username: person.name }))}
                  >
                    Add {person.name} as a friend
                  </Button>
                )}
              </div>
            )
          })()}
      </Sheet>
      {message && (
        <div className="toast" role="alert">
          {message}
          <button aria-label="Dismiss message" onClick={() => setMessage(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>,
  )
}
