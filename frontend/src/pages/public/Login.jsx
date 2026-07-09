import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toE164India } from '../../lib/helpers'
import Credit from '../../components/Credit'

// SPEC §4.3/§4.4 — buyers sign in with their MOBILE NUMBER + a one-time SMS code
// (phone OTP). Email is an optional contact field, never the login handle.
// Sign-in only: new parties are created by the shop (owner), never self-signup.
//
// The `phone-otp` Edge Function owns the whole OTP lifecycle: `send` texts a
// 6-digit code via Fast2SMS (only to a known, active profile); `verify` checks
// it and returns a one-time `token_hash` we redeem for a real Supabase session.
// Two steps: (1) send code to the phone, (2) verify the 6-digit code.
export default function Login() {
  const [step, setStep] = useState('phone')   // 'phone' → 'otp'
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [e164, setE164] = useState('')        // normalised phone the OTP was sent to
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function sendCode(e) {
    e.preventDefault()
    setError(''); setNotice('')
    const phoneE164 = toE164India(phone)
    if (!phoneE164) { setError('Enter a valid 10-digit mobile number.'); return }
    setBusy(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        'phone-otp', { body: { action: 'send', phone: phoneE164 } },
      )
      if (fnErr) throw new Error(await readFnError(fnErr))
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
      if (fnErr) throw new Error(await readFnError(fnErr))
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
          <span className="shop-stamp text-sm font-bold">Khattri Card Pratham</span>
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
          {/* mobile brand */}
          <div className="md:hidden mb-8">
            <span className="shop-stamp text-xs font-bold">Khattri Card Pratham</span>
          </div>

          <h2 className="font-[var(--font-display)] text-2xl font-bold mb-1">
            Welcome back
          </h2>
          <p className="text-muted text-sm mb-6">
            {step === 'otp'
              ? 'Enter the code we sent to your phone.'
              : 'Sign in with your mobile number.'}
          </p>

          {step === 'phone' ? (
            <form onSubmit={sendCode} className="space-y-4">
              <Field label="Mobile number" value={phone}
                     onChange={(e) => setPhone(e.target.value)}
                     type="tel" autoComplete="tel" inputMode="numeric"
                     placeholder="98765 43210" required />

              {error && <Alert tone="dues">{error}</Alert>}
              {notice && <Alert tone="peacock">{notice}</Alert>}

              <button type="submit" disabled={busy} className={btnClass}>
                {busy ? 'Sending…' : 'Send code'}
              </button>

              <p className="text-center text-xs text-muted">
                New here? Ask the shop to add your number.
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

// The Edge Function returns { error } with a non-2xx status; supabase-js wraps
// that in a FunctionsHttpError whose real message is on the Response body.
async function readFnError(fnErr) {
  try {
    const body = await fnErr?.context?.json?.()
    if (body?.error) return body.error
  } catch { /* fall through */ }
  return fnErr?.message || 'Login failed. Please try again.'
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
  if (/no account|signups? not allowed|user not found/i.test(msg)) return 'No account for this number yet. Ask the shop to add you.'
  if (/disabled/i.test(msg)) return 'This account is disabled. Contact the shop.'
  if (/too-many-requests|rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.'
  if (/could not send|sms|not configured/i.test(msg)) return 'Could not send the code right now. Please try again.'
  return msg
}
