import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IconArrowLeft } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { toE164India } from '../../lib/helpers'
import Credit from '../../components/Credit'
import Brand from '../../components/Brand'
import { useShop } from '../../context/ShopContext'

// SPEC §4.3/§4.4 — buyers sign in with their MOBILE NUMBER + a one-time SMS code
// (phone OTP). Email is an optional contact field, never the login handle.
//
// Two modes share one screen:
//   sign in   — existing buyer; `send` texts a code (known, active profile only).
//   register  — new buyer; `register` texts a code, then `verify` creates an
//               ACTIVE retail customer (SPEC §4.3/§6.3). Dealers stay owner-made.
// Both finish the same way: `verify` checks the code and returns a one-time
// `token_hash` we redeem for a real Supabase session.
export default function Login() {
  const { shop } = useShop()
  const [mode, setMode] = useState('signin')  // 'signin' | 'register'
  const [step, setStep] = useState('phone')    // 'phone' → 'otp'
  const [name, setName] = useState('')         // register only
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [e164, setE164] = useState('')        // normalised phone the OTP was sent to
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const registering = mode === 'register'

  // Flip between sign-in and register, clearing any in-flight step/messages.
  function switchMode(next, msg = '') {
    setMode(next)
    setStep('phone'); setCode(''); setError(''); setNotice(msg)
  }

  async function sendCode(e) {
    e.preventDefault()
    setError(''); setNotice('')
    const trimmedName = name.trim()
    if (registering && !trimmedName) { setError('Enter your name.'); return }
    const phoneE164 = toE164India(phone)
    if (!phoneE164) { setError('Enter a valid 10-digit mobile number.'); return }
    setBusy(true)
    try {
      const payload = registering
        ? { action: 'register', phone: phoneE164, full_name: trimmedName }
        : { action: 'send', phone: phoneE164 }
      const { data, error: fnErr } = await supabase.functions.invoke('phone-otp', { body: payload })
      if (fnErr) {
        const { message, code: errCode } = await readFnError(fnErr)
        // Guide the buyer to the right mode instead of a dead end.
        if (errCode === 'exists') { switchMode('signin', 'You already have an account — sign in below.'); return }
        if (errCode === 'not_found') { switchMode('register', 'No account yet — create one below.'); return }
        throw new Error(message)
      }
      if (!data?.ok) throw new Error(data?.error || 'Could not send the code. Please try again.')
      setE164(phoneE164)
      setStep('otp')
      setNotice(`We sent a 6-digit code to ${phoneE164}.`)
    } catch (err) {
      setError(humanError(err?.message))
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e) {
    e.preventDefault()
    setError(''); setNotice('')
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code from the SMS.'); return }
    setBusy(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        'phone-otp', { body: { action: 'verify', phone: e164, code: code.trim() } },
      )
      if (fnErr) throw new Error((await readFnError(fnErr)).message)
      if (!data?.token_hash) throw new Error(data?.error || 'Login failed. Please try again.')
      // Redeem the one-time token for a real Supabase session (RLS-protected
      // data loads); AuthContext then loads the profile.
      const { error } = await supabase.auth.verifyOtp({
        token_hash: data.token_hash,
        type: 'email',
      })
      if (error) throw error
      // Session is now set; AuthContext loads the profile and the /login route
      // redirects to the right home for this role (owner/staff console or shop).
    } catch (err) {
      setError(humanError(err?.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen grid md:grid-cols-2">
      {/* Left — the khata page */}
      <aside className="relative hidden md:flex flex-col justify-between p-12 khata-page">
        <div className="pl-12">
          <Brand shop={shop} maxWords={3} textClassName="text-sm" logoClassName="h-10" />
        </div>
        <div className="pl-12 max-w-md">
          <h1 className="font-[var(--font-display)] text-4xl leading-tight font-extrabold text-ink">
            Your shop's khata,<br />now on your phone.
          </h1>
          <p className="mt-4 text-muted text-lg">
            Stock, sales, udhaar and supplier dues — kept in one register.
            Simple to run on the counter, strong underneath in the books.
          </p>
        </div>
        <div className="pl-12 text-sm text-muted">
          <span className="fig">₹</span> Every figure has a name. Nothing is hidden, nothing is lost.
        </div>
      </aside>

      {/* Right — sign in */}
      <main className="flex items-center justify-center p-6 sm:p-12 bg-paper">
        <div className="w-full max-w-sm">
          {/* This screen has no header, so this is the only way back to the shop —
              shown at every width, not just mobile (SPEC §3 — no dead ends). A
              buyer who tapped Sign in from the cart can get back to browsing. */}
          <Link
            to="/"
            className="mb-6 -ml-1 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-medium text-muted hover:text-ink"
          >
            <IconArrowLeft size={18} /> Back to shop
          </Link>

          {/* mobile brand */}
          <div className="md:hidden mb-8">
            <Brand shop={shop} maxWords={3} textClassName="text-xs" logoClassName="h-9" />
          </div>

          <h2 className="font-[var(--font-display)] text-2xl font-bold mb-1">
            {registering ? 'Create your account' : 'Welcome back'}
          </h2>
          <p className="text-muted text-sm mb-6">
            {step === 'otp'
              ? 'Enter the code we sent to your phone.'
              : registering
                ? 'Sign up with your name and mobile number to place orders.'
                : 'Sign in with your mobile number.'}
          </p>

          {step === 'phone' ? (
            <form onSubmit={sendCode} className="space-y-4">
              {registering && (
                <Field label="Your name" value={name}
                       onChange={(e) => setName(e.target.value)}
                       type="text" autoComplete="name"
                       placeholder="Full name" required />
              )}
              <Field label="Mobile number" value={phone}
                     onChange={(e) => setPhone(e.target.value)}
                     type="tel" autoComplete="tel" inputMode="numeric"
                     placeholder="98765 43210" required />

              {error && <Alert tone="dues">{error}</Alert>}
              {notice && <Alert tone="peacock">{notice}</Alert>}

              <button type="submit" disabled={busy} className={btnClass}>
                {busy ? 'Sending…' : registering ? 'Create account' : 'Send code'}
              </button>

              <p className="text-center text-xs text-muted">
                {registering ? 'Already have an account? ' : 'New here? '}
                <button
                  type="button"
                  onClick={() => switchMode(registering ? 'signin' : 'register')}
                  className="font-semibold text-peacock hover:underline"
                >
                  {registering ? 'Sign in' : 'Create an account'}
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-4">
              <Field label="6-digit code" value={code}
                     onChange={(e) => setCode(e.target.value)}
                     type="tel" inputMode="numeric" autoComplete="one-time-code"
                     placeholder="••••••" required />

              {error && <Alert tone="dues">{error}</Alert>}
              {notice && <Alert tone="peacock">{notice}</Alert>}

              <button type="submit" disabled={busy} className={btnClass}>
                {busy ? 'Verifying…' : 'Verify & continue'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('phone'); setCode(''); setError(''); setNotice('') }}
                className="w-full text-sm text-muted hover:text-ink"
              >
                ← Change number
              </button>
            </form>
          )}

          <div className="mt-8 text-center">
            <Credit />
          </div>
        </div>
      </main>
    </div>
  )
}

// The Edge Function returns { error, code? } with a non-2xx status; supabase-js
// wraps that in a FunctionsHttpError whose real body is on the Response. Return
// both the human message and the machine `code` (e.g. 'exists'/'not_found') so
// the caller can bounce the buyer to the right mode.
async function readFnError(fnErr) {
  try {
    const body = await fnErr?.context?.json?.()
    if (body?.error) return { message: body.error, code: body.code }
  } catch { /* fall through */ }
  return { message: fnErr?.message || 'Login failed. Please try again.', code: undefined }
}

const btnClass =
  'w-full rounded-lg bg-peacock hover:bg-peacock-700 disabled:opacity-60 ' +
  'text-white font-semibold py-2.5 transition'

function Field({ label, ...props }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-ink mb-1.5">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink
                   outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
      />
    </label>
  )
}

function Alert({ tone, children }) {
  const cls = tone === 'dues'
    ? 'text-dues bg-dues/10 border-dues/30'
    : 'text-peacock bg-peacock/10 border-peacock/30'
  return <p className={`text-sm border rounded-md px-3 py-2 ${cls}`}>{children}</p>
}

function humanError(msg) {
  if (!msg) return 'Something went wrong. Please try again.'
  if (/token has expired|expired|invalid.*(otp|token)/i.test(msg)) return 'That code is wrong or expired. Request a new one.'
  if (/already.*(account|registered)/i.test(msg)) return 'This number already has an account. Please sign in.'
  if (/no account|signups? not allowed|user not found/i.test(msg)) return 'No account for this number yet. Tap “Create an account” to sign up.'
  if (/disabled/i.test(msg)) return 'This account is disabled. Contact the shop.'
  if (/too-many-requests|rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.'
  if (/could not send|sms|not configured/i.test(msg)) return 'Could not send the code right now. Please try again.'
  return msg
}
