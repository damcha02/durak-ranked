import { useState } from 'react'
import { isEmailIdentifier, isUsername } from '../authValidation'
import { authLinkError, errorMessage, supabase } from '../lib'
import { APP_NAME, Brand, Button, useBlue } from '../ui'
import { signInByUsername } from '../usernameSignIn'

export function AuthScreen({ joinCode }: { joinCode: string }) {
  const [identifier, setIdentifier] = useState(''),
    [email, setEmail] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState('')
  // An expired or already-used reset link lands here with an error, so offer a fresh one straight away.
  const [tab, setTab] = useState<'sign-in' | 'register' | 'reset'>(authLinkError ? 'reset' : 'sign-in'),
    [notice, setNotice] = useState(
      authLinkError ? `${authLinkError.replace(/\.?$/, '.')} Request a new reset link.` : '',
    ),
    [working, setWorking] = useState(false),
    [sentTo, setSentTo] = useState('')
  const blue = useBlue()
  const act = async (fn: () => Promise<void>) => {
    setWorking(true)
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setNotice(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }
  const switchTab = (t: typeof tab) => {
    setTab(t)
    setNotice('')
    setSentTo('')
  }
  const submit = () =>
    void act(async () => {
      if (tab === 'reset') {
        const address = email.trim()
        if (!isEmailIdentifier(address)) throw new Error('Enter the email address of your account.')
        const { error } = await supabase.auth.resetPasswordForEmail(address, {
          redirectTo: `${location.origin}/`,
        })
        if (error) throw error
        setSentTo(address)
      } else if (tab === 'register') {
        const handle = username.trim()
        if (!isUsername(handle))
          throw new Error('Username must contain 3–22 letters, numbers or underscores.')
        if (password.length < 10) throw new Error('Choose a password of at least 10 characters.')
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: handle } },
        })
        if (error) {
          if (/database error saving new user/i.test(error.message))
            throw new Error('Registration failed. This username may already be taken.')
          throw error
        }
        if (!data.session)
          throw new Error(
            'Account created but no session returned. Disable Confirm Email in Supabase Authentication → Email provider, or confirm your email.',
          )
        // The onAuthStateChange listener switches directly to the dashboard.
      } else if (isEmailIdentifier(identifier)) {
        const { error } = await supabase.auth.signInWithPassword({ email: identifier.trim(), password })
        if (error) throw error
      } else {
        if (!isUsername(identifier.trim())) throw new Error('Enter a valid username or email address.')
        await signInByUsername(identifier.trim(), password)
      }
    })
  // Username problems are shown under the username field; everything else above the submit button.
  const usernameError = tab === 'register' && /username/i.test(notice)
  const errorLine = (
    <p id="auth-error" className="fieldError" role="alert">
      <span aria-hidden="true">{'\u2666\uFE0E'}</span>
      {notice}
    </p>
  )
  return (
    <div className="authWrap">
      <main className="authInner">
        {joinCode ? (
          <>
            <h1 className="brandHeading">
              <Brand />
            </h1>
            <div className="authInvite" role="status">
              <span className="inviteCard" aria-hidden="true">
                {joinCode.slice(0, 4)}
                <br />
                {joinCode.slice(4)}
              </span>
              <p>
                You've been invited to table <strong>{joinCode}</strong>. Sign in or create an account and
                you'll join it straight away.
              </p>
            </div>
          </>
        ) : blue ? (
          <header className="authIntro">
            <span className="authMark" aria-hidden="true">
              {'\u2660\uFE0E'}
            </span>
            <h1>{APP_NAME}</h1>
            <p>
              A scorebook for your Durak nights. Play with real cards, vote on who lost, and keep a rating for
              each game mode.
            </p>
          </header>
        ) : (
          <header className="authIntro">
            <div className="brandLarge">
              <span className="brandFan" aria-hidden="true">
                <span className="fanBack" />
                <span className="fanFront">
                  <span className="miniIndex">D</span>
                  {'\u2660\uFE0E'}
                </span>
              </span>
              <h1>
                Durak
                <br />
                Ranked
              </h1>
            </div>
            <p>
              Keep score for the games you play with a real deck. Vote on who's left holding cards, and see
              your rating per mode.
            </p>
          </header>
        )}
        {tab === 'reset' ? (
          <form
            className="authCard"
            aria-labelledby="reset-title"
            onSubmit={e => {
              e.preventDefault()
              submit()
            }}
          >
            <h2 id="reset-title">Reset your password</h2>
            {sentTo ? (
              <p role="status">
                If <strong>{sentTo}</strong> belongs to an account, a reset link is on its way. Open it to
                choose a new password. It can take a few minutes; check your spam folder too.
              </p>
            ) : (
              <>
                <p className="fieldHint">
                  Enter the email address you signed up with and we'll send you a link to choose a new
                  password.
                </p>
                <label className="field">
                  Email address
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                </label>
                {notice && errorLine}
                <Button type="submit" disabled={working} className="wide">
                  {working ? 'Please wait…' : 'Send reset link'}
                </Button>
              </>
            )}
            <button type="button" className="linkButton plain" onClick={() => switchTab('sign-in')}>
              Back to sign in
            </button>
          </form>
        ) : (
          <>
            <div className="authTabs" role="group" aria-label="Account">
              <span className={`authThumb ${tab === 'register' ? 'right' : ''}`} aria-hidden="true" />
              <button
                type="button"
                aria-pressed={tab === 'sign-in'}
                className={tab === 'sign-in' ? 'selected' : ''}
                onClick={() => switchTab('sign-in')}
              >
                Sign in
              </button>
              <button
                type="button"
                aria-pressed={tab === 'register'}
                className={tab === 'register' ? 'selected' : ''}
                onClick={() => switchTab('register')}
              >
                Create account
              </button>
            </div>
            <form
              className="authCard"
              aria-label={tab === 'register' ? 'Create account' : 'Sign in'}
              onSubmit={e => {
                e.preventDefault()
                submit()
              }}
            >
              {tab === 'register' ? (
                <>
                  <div className="fieldGroup">
                    <label className="field">
                      Username
                      <input
                        required
                        type="text"
                        minLength={3}
                        maxLength={22}
                        pattern="[A-Za-z0-9_]{3,22}"
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-invalid={usernameError || undefined}
                        aria-describedby={usernameError ? 'auth-error' : undefined}
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                      />
                    </label>
                    {usernameError && errorLine}
                  </div>
                  <label className="field">
                    Email address
                    <input
                      required
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="field">
                  Username or email
                  <input
                    required
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={identifier}
                    onChange={e => setIdentifier(e.target.value)}
                  />
                </label>
              )}
              <div className="fieldGroup">
                <label className="field">
                  Password
                  <input
                    required
                    minLength={tab === 'register' ? 10 : 1}
                    type="password"
                    autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                    aria-describedby={tab === 'register' ? 'password-hint' : undefined}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </label>
                {tab === 'register' && (
                  <p id="password-hint" className="fieldHint">
                    At least 10 characters
                  </p>
                )}
              </div>
              {notice && !usernameError && errorLine}
              <Button type="submit" disabled={working} className="wide">
                {working ? 'Please wait…' : tab === 'register' ? 'Create account' : 'Sign in'}
              </Button>
              {tab === 'sign-in' && (
                <button type="button" className="linkButton plain" onClick={() => switchTab('reset')}>
                  Forgot your password?
                </button>
              )}
            </form>
            {tab === 'register' && (
              <p className="authNote">
                Use an email address you control: it's how you reset a forgotten password.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}

// Shown after opening a password-reset link: the link signs you in, and you choose a new password before going on.
export function NewPasswordScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [notice, setNotice] = useState(''),
    [working, setWorking] = useState(false)
  const submit = async () => {
    setNotice('')
    if (password.length < 10) {
      setNotice('Choose a password of at least 10 characters.')
      return
    }
    if (password !== repeat) {
      setNotice("The two passwords don't match.")
      return
    }
    setWorking(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      onDone()
    } catch (e) {
      setNotice(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="authWrap">
      <main className="authInner">
        <h1 className="brandHeading">
          <Brand />
        </h1>
        <form
          className="authCard"
          aria-labelledby="new-password-title"
          onSubmit={e => {
            e.preventDefault()
            void submit()
          }}
        >
          <h2 id="new-password-title">Choose a new password</h2>
          <div className="fieldGroup">
            <label className="field">
              New password
              <input
                required
                minLength={10}
                type="password"
                autoComplete="new-password"
                aria-describedby="reset-password-hint"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </label>
            <p id="reset-password-hint" className="fieldHint">
              At least 10 characters
            </p>
          </div>
          <label className="field">
            Repeat new password
            <input
              required
              minLength={10}
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={e => setRepeat(e.target.value)}
            />
          </label>
          {notice && (
            <p className="fieldError" role="alert">
              <span aria-hidden="true">{'♦︎'}</span>
              {notice}
            </p>
          )}
          <Button type="submit" disabled={working} className="wide">
            {working ? 'Please wait…' : 'Save new password'}
          </Button>
        </form>
      </main>
    </div>
  )
}
