import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth'
import { supabase } from '../../lib/supabase'
import { toE164India } from '../../lib/helpers'
import { firebaseEnabled, getFirebaseAuth } from '../../lib/firebase'
import Credit from '../../components/Credit'

// PROD PATH — when VITE_FIREBASE_API_KEY is set, real SMS goes through Firebase
// Phone Auth: sendCode triggers the SMS (invisible reCAPTCHA + signInWithPhone-
// Number), verifyCode confirms the 6-digit code to get a Firebase ID token, then
// the `firebase-otp-login` Edge Function trades that token for a real Supabase
// session (see lib/firebase.js). The DEV/native path below is the fallback used
// only while Firebase is unconfigured.
//
// TESTING ONLY — no SMS provider is wired yet. Set VITE_DEV_OTP in .env to the
// fixed code you registered under Supabase Auth → Phone → "Test OTP" for your
// test number(s). When set, the login screen shows that code on-screen so you
// can sign in without an SMS. Verification still goes through Supabase, so this
// yields a REAL session (RLS-protected data loads). To go live with real SMS:
// remove VITE_DEV_OTP and the Test OTP entries — no code change needed.
const DEV_OTP = import.meta.env.VITE_DEV_OTP || ''
// Dev mock only: with no SMS provider wired, Supabase's OTP send/verify can't
// run. When DEV_OTP is set we skip it entirely and mint a REAL session via a
// password grant (needs no SMS provider) using this shared dev password, which
// must be set on the auth user. Clear both vars for production.
const DEV_PASSWORD = import.meta.env.VITE_DEV_PASSWORD || ''

// SPEC §4.3/§4.4 — buyers sign in with their MOBILE NUMBER + a one-time SMS code
// (phone OTP). Email is an optional contact field, never the login handle.
// Sign-in only: new parties are created by the shop (owner), never self-signup.
// Two steps: (1) send code to the phone, (2) verify the 6-digit code.
export default function Login() {
  const [step, setStep] = useState('phone')   // 'phone' → 'otp'
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [e164, setE164] = useState('')        // normalised phone the OTP was sent to
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const navigate = useNavigate()
  const confirmationRef = useRef(null)   // Firebase confirmationResult (send → verify)
  const recaptchaRef = useRef(null)      // reused invisible reCAPTCHA verifier

  // Lazily build one invisible reCAPTCHA verifier and reuse it across retries.
  function getRecaptcha() {
    if (!recaptchaRef.current) {
      recaptchaRef.current = new RecaptchaVerifier(
        getFirebaseAuth(),
        'recaptcha-container',
        { size: 'invisible' },
      )
    }
    return recaptchaRef.current
  }

  async function sendCode(e) {
    e.preventDefault()
    setError(''); setNotice('')
    const phoneE164 = toE164India(phone)
    if (!phoneE164) { setError('Enter a valid 10-digit mobile number.'); return }
    setBusy(true)
    try {
      if (firebaseEnabled) {
        // PROD: real SMS via Firebase. Sends the code; nothing is created on the
        // Supabase side until the verified token is exchanged at verify time.
        confirmationRef.current = await signInWithPhoneNumber(
          getFirebaseAuth(), phoneE164, getRecaptcha(),
        )
      } else if (!DEV_OTP) {
        // DEV/native fallback: Supabase's own OTP (needs an SMS provider wired).
        const { error } = await supabase.auth.signInWithOtp({
          phone: phoneE164,
          // Sign-in must never silently create an account for a wrong number.
          // Accounts are provisioned by the shop, not at the login screen.
          options: { shouldCreateUser: false },
        })
        if (error) throw error
      }
      // else DEV MOCK: no SMS at all — just reveal the fixed on-screen code.
      setE164(phoneE164)
      setStep('otp')
      setNotice((!firebaseEnabled && DEV_OTP)
        ? `Testing mode — SMS not connected. Use code ${DEV_OTP}.`
        : `We sent a 6-digit code to ${phoneE164}.`)
    } catch (err) {
      setError(humanError(err?.message))
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e) {
    e.preventDefault()
    setError(''); setNotice('')
    if (!/^\d{4,8}$/.test(code.trim())) { setError('Enter the code from the SMS.'); return }
    setBusy(true)
    try {
      if (firebaseEnabled) {
        // PROD: confirm the code with Firebase → get a signed ID token proving
        // phone ownership, then trade it for a real Supabase session via the
        // Edge Function. verifyOtp sets the session; AuthContext loads the profile.
        if (!confirmationRef.current) throw new Error('Request a new code.')
        const cred = await confirmationRef.current.confirm(code.trim())
        const idToken = await cred.user.getIdToken()
        const { data, error: fnErr } = await supabase.functions.invoke(
          'firebase-otp-login', { body: { idToken } },
        )
        if (fnErr) throw new Error(await readFnError(fnErr))
        if (!data?.token_hash) throw new Error(data?.error || 'Login failed. Please try again.')
        const { error } = await supabase.auth.verifyOtp({
          token_hash: data.token_hash,
          type: 'email',
        })
        if (error) throw error
      } else if (DEV_OTP) {
        // DEV MOCK: accept the fixed on-screen code, then get a REAL RLS
        // session via a password grant. Phone logins are disabled when no SMS
        // provider is wired, so we sign in by a deterministic EMAIL derived
        // from the number (<digits>@dev.local) — set on the auth user, with
        // the same dev password. Email password login needs no SMS provider.
        if (code.trim() !== DEV_OTP) throw new Error('invalid otp code')
        const devEmail = `${e164.replace(/\D/g, '')}@dev.local`
        const { error } = await supabase.auth.signInWithPassword({
          email: devEmail,
          password: DEV_PASSWORD,
        })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.verifyOtp({
          phone: e164,
          token: code.trim(),
          type: 'sms',
        })
        if (error) throw error
      }
      navigate('/', { replace: true })
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
                onClick={() => { setStep('phone'); setCode(''); setError(''); setNotice(''); confirmationRef.current = null }}
                className="w-full text-sm text-muted hover:text-ink"
              >
                ← Change number
              </button>
            </form>
          )}

          <div className="mt-8 text-center">
            <Credit />
          </div>

          {/* Firebase invisible reCAPTCHA mounts here; empty otherwise. */}
          <div id="recaptcha-container" />
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
  if (/invalid login credentials|email not confirmed/i.test(msg)) return 'That code is wrong, or dev login isn’t set up for this number yet.'
  if (/invalid-verification-code|invalid.*code|token has expired|expired|invalid.*(otp|token)/i.test(msg)) return 'That code is wrong or expired. Request a new one.'
  if (/no account|signups? not allowed|user not found/i.test(msg)) return 'No account for this number yet. Ask the shop to add you.'
  if (/too-many-requests|rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.'
  if (/captcha|recaptcha|app-not-authorized|invalid-app-credential/i.test(msg)) return 'Sign-in check failed. Refresh the page and try again.'
  if (/sms|phone provider|not configured|unsupported phone/i.test(msg)) return 'SMS login isn’t available right now. Please try again later.'
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.'
  return msg
}
