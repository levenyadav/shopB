import { useEffect, useRef, useState } from 'react'
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
// One flow, no "sign in vs register" choice up front:
//   phone → `send` texts a code to a known, active number.
//         → unknown number (`not_found`) → ask for a name → `register` texts a
//           code, and `verify` creates an ACTIVE retail customer (SPEC §4.3).
//           Dealers stay owner-made.
//   code  → `verify` returns a one-time `token_hash` we redeem for a real
//           Supabase session. The /login route (App.jsx) then sends the user on
//           — to ?next= (e.g. back to the cart) for buyers, else their home.
const RESEND_SECONDS = 30

export default function Login() {
  const { shop } = useShop()
  const [step, setStep] = useState('phone')   // 'phone' | 'name' | 'otp'
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(null)      // { phone: e164, payload } the code went out with
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wait, setWait] = useState(0)          // seconds until "Resend" is allowed

  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(t)
  }, [wait])

  // Ask the Edge Function to text a code. Returns an error code the caller can
  // route on ('not_found' / 'exists'), or null when the SMS went out.
  async function requestCode(payload) {
    const { data, error: fnErr } = await supabase.functions.invoke('phone-otp', { body: payload })
    if (fnErr) {
      const { message, code: errCode } = await readFnError(fnErr)
      if (errCode === 'not_found' || errCode === 'exists') return errCode
      throw new Error(message)
    }
    if (!data?.ok) throw new Error(data?.error || 'Could not send the code. Please try again.')
    setSent({ phone: payload.phone, payload })
    setCode('')
    setStep('otp')
    setWait(RESEND_SECONDS)
    return null
  }

  async function submitPhone(e) {
    e.preventDefault()
    setError('')
    const e164 = toE164India(phone)
    if (!e164) { setError('Enter a valid 10-digit mobile number.'); return }
    setBusy(true)
    try {
      const res = await requestCode({ action: 'send', phone: e164 })
      if (res === 'not_found') setStep('name')
    } catch (err) {
      setError(humanError(err?.message))
    } finally {
      setBusy(false)
    }
  }

  async function submitName(e) {
    e.preventDefault()
    setError('')
    const fullName = name.trim()
    if (!fullName) { setError('Enter your name.'); return }
    setBusy(true)
    try {
      const e164 = toE164India(phone)
      const res = await requestCode({ action: 'register', phone: e164, full_name: fullName })
      // Registered in the meantime (another tab) — just sign in.
      if (res === 'exists') await requestCode({ action: 'send', phone: e164 })
    } catch (err) {
      setError(humanError(err?.message))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    if (!sent || wait > 0) return
    setError(''); setBusy(true)
    try { await requestCode(sent.payload) } catch (err) { setError(humanError(err?.message)) } finally { setBusy(false) }
  }

  async function verify(value = code) {
    setError('')
    if (!/^\d{6}$/.test(value)) { setError('Enter the 6-digit code from the SMS.'); return }
    setBusy(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        'phone-otp', { body: { action: 'verify', phone: sent.phone, code: value } },
      )
      if (fnErr) throw new Error((await readFnError(fnErr)).message)
      if (!data?.token_hash) throw new Error(data?.error || 'Login failed. Please try again.')
      // Redeem the one-time token for a real Supabase session (RLS-protected
      // data loads); AuthContext then loads the profile and App redirects.
      const { error } = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: 'email' })
      if (error) throw error
    } catch (err) {
      setError(humanError(err?.message))
      setBusy(false)
    }
  }

  function changeNumber() {
    setStep('phone'); setCode(''); setError(''); setSent(null)
  }

  const shopName = shop?.name || 'our shop'

  return (
    <div className="storefront flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-md items-center px-4 pt-3">
        <Link to="/" className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted hover:text-ink">
          <IconArrowLeft size={18} aria-hidden /> Back to shop
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-10">
        <div className="rounded-2xl bg-card p-6 ring-1 ring-line sm:p-8">
          {/* The logo only when there is an image — a text logo would just
              repeat the shop name in the heading below. */}
          {shop?.logo_url && (
            <div className="mb-6 flex justify-center">
              <Brand shop={shop} maxWords={3} logoClassName="h-12" />
            </div>
          )}

          <h1 className="text-center font-[var(--font-display)] text-2xl font-bold text-ink">
            {step === 'otp' ? 'Enter the code' : step === 'name' ? 'Create your account' : `Sign in to ${shopName}`}
          </h1>
          <p className="mt-1 text-center text-sm text-muted">
            {step === 'otp' ? (
              <>Sent by SMS to <span className="fig text-ink">{prettyPhone(sent?.phone)}</span></>
            ) : step === 'name' ? (
              <>New number — tell us your name and we’ll text you a code.</>
            ) : (
              <>We’ll text you a code. No password needed.</>
            )}
          </p>

          <div className="mt-6">
            {step === 'phone' && (
              <form onSubmit={submitPhone} className="space-y-4" noValidate>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink">Mobile number</span>
                  <span className="flex h-12 items-center rounded-lg border border-line bg-card transition-colors duration-150 focus-within:border-peacock focus-within:ring-1 focus-within:ring-peacock">
                    <span className="fig pl-3 pr-2 text-muted">+91</span>
                    <input
                      value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus
                      type="tel" autoComplete="tel-national" inputMode="numeric" placeholder="98765 43210"
                      aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined}
                      className="fig h-full min-w-0 flex-1 bg-transparent pr-3 text-base text-ink outline-none"
                    />
                  </span>
                </label>
                <ErrorLine error={error} />
                <SubmitButton busy={busy} busyLabel="Sending code…">Get code</SubmitButton>
              </form>
            )}

            {step === 'name' && (
              <form onSubmit={submitName} className="space-y-4" noValidate>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink">Your name</span>
                  <input
                    value={name} onChange={(e) => setName(e.target.value)} autoFocus
                    type="text" autoComplete="name" placeholder="Full name"
                    aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined}
                    className="h-12 w-full rounded-lg border border-line bg-card px-3 text-base text-ink outline-none transition-colors duration-150 focus:border-peacock focus:ring-1 focus:ring-peacock"
                  />
                </label>
                <ErrorLine error={error} />
                <SubmitButton busy={busy} busyLabel="Sending code…">Get code</SubmitButton>
                <TextButton onClick={changeNumber}>Use a different number</TextButton>
              </form>
            )}

            {step === 'otp' && (
              <form onSubmit={(e) => { e.preventDefault(); verify() }} className="space-y-4" noValidate>
                <label className="block">
                  <span className="sr-only">6-digit code</span>
                  <input
                    value={code} autoFocus
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                      setCode(v)
                      if (v.length === 6 && !busy) verify(v) // SMS autofill → straight in
                    }}
                    type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="••••••"
                    aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined}
                    className="fig h-14 w-full rounded-lg border border-line bg-card text-center text-2xl tracking-[0.5em] text-ink outline-none transition-colors duration-150 placeholder:text-line focus:border-peacock focus:ring-1 focus:ring-peacock"
                  />
                </label>
                <ErrorLine error={error} />
                <SubmitButton busy={busy} busyLabel="Verifying…">Continue</SubmitButton>
                <div className="flex items-center justify-between text-sm">
                  <TextButton onClick={changeNumber}>Change number</TextButton>
                  {wait > 0 ? (
                    <span className="text-muted">Resend in <span className="fig">0:{String(wait).padStart(2, '0')}</span></span>
                  ) : (
                    <TextButton onClick={resend} disabled={busy}>Resend code</TextButton>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      </main>

      <footer className="pb-6 text-center">
        <Credit />
      </footer>
    </div>
  )
}

function SubmitButton({ busy, busyLabel, children }) {
  return (
    <button
      type="submit" disabled={busy}
      className="h-12 w-full rounded-lg bg-peacock text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-peacock-700 disabled:opacity-60"
    >
      {busy ? busyLabel : children}
    </button>
  )
}

function TextButton({ children, ...props }) {
  return (
    <button type="button" {...props} className="inline-flex min-h-11 items-center font-medium text-muted hover:text-ink disabled:opacity-50">
      {children}
    </button>
  )
}

function ErrorLine({ error }) {
  if (!error) return null
  return <p id="login-error" role="alert" className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{error}</p>
}

// +919876543210 → +91 98765 43210
function prettyPhone(e164) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164 || '')
  return m ? `+91 ${m[1]} ${m[2]}` : e164 || ''
}

// The Edge Function returns { error, code? } with a non-2xx status; supabase-js
// wraps that in a FunctionsHttpError whose real body is on the Response. Return
// both the human message and the machine `code` (e.g. 'exists'/'not_found') so
// the caller can route the buyer to the right step.
async function readFnError(fnErr) {
  try {
    const body = await fnErr?.context?.json?.()
    if (body?.error) return { message: body.error, code: body.code }
  } catch { /* fall through */ }
  return { message: fnErr?.message || 'Login failed. Please try again.', code: undefined }
}

function humanError(msg) {
  if (!msg) return 'Something went wrong. Please try again.'
  if (/token has expired|expired|invalid.*(otp|token|code)|wrong code/i.test(msg)) return 'That code is wrong or has expired. Check the SMS or tap Resend code.'
  if (/disabled/i.test(msg)) return 'This account is disabled. Please contact the shop.'
  if (/too-many-requests|rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.'
  if (/could not send|sms|not configured/i.test(msg)) return 'We couldn’t send the SMS right now. Please try again in a minute.'
  return msg
}
