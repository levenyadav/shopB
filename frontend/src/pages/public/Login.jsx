import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Credit from '../../components/Credit'

const TABS = { in: 'Sign in', up: 'Create account' }

export default function Login() {
  const [tab, setTab] = useState('in')
  const [form, setForm] = useState({
    fullName: '', phone: '', email: '', password: '', buyerType: 'customer',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const navigate = useNavigate()

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function onSubmit(e) {
    e.preventDefault()
    setError(''); setNotice(''); setBusy(true)
    try {
      if (tab === 'in') {
        const { error } = await supabase.auth.signInWithPassword({
          email: form.email.trim(),
          password: form.password,
        })
        if (error) throw error
        navigate('/', { replace: true })
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: form.email.trim(),
          password: form.password,
          options: {
            data: {
              full_name: form.fullName.trim(),
              phone: form.phone.trim(),
              // handle_new_user only honours 'customer'/'dealer' here (SPEC §9 —
              // owner/staff are promoted manually, never self-assigned at signup).
              role: form.buyerType,
            },
          },
        })
        if (error) throw error
        if (data.session) navigate('/', { replace: true })
        else setNotice('Account created. Check your email to confirm, then sign in.')
      }
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

      {/* Right — sign in / register */}
      <main className="flex items-center justify-center p-6 sm:p-12 bg-paper">
        <div className="w-full max-w-sm">
          {/* mobile brand */}
          <div className="md:hidden mb-8">
            <span className="shop-stamp text-xs font-bold">Khattri Card Pratham</span>
          </div>

          <div className="inline-flex rounded-lg border border-line bg-card p-1 mb-7">
            {Object.entries(TABS).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTab(key); setError(''); setNotice('') }}
                className={`px-4 py-1.5 text-sm rounded-md transition ${
                  tab === key ? 'bg-peacock text-white' : 'text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <h2 className="font-[var(--font-display)] text-2xl font-bold mb-1">
            {tab === 'in' ? 'Welcome back' : 'Open your account'}
          </h2>
          <p className="text-muted text-sm mb-6">
            {tab === 'in'
              ? 'Sign in to your shop register.'
              : 'Register to browse the shop and place orders.'}
          </p>

          <form onSubmit={onSubmit} className="space-y-4">
            {tab === 'up' && (
              <>
                <Field label="Full name" value={form.fullName} onChange={set('fullName')}
                       autoComplete="name" required />
                <Field label="Phone" value={form.phone} onChange={set('phone')}
                       type="tel" autoComplete="tel" />
                <div>
                  <span className="block text-sm font-medium text-ink mb-1.5">I am a</span>
                  <div className="inline-flex w-full rounded-lg border border-line bg-card p-1">
                    {[
                      ['customer', 'Customer'],
                      ['dealer', 'Dealer'],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, buyerType: key }))}
                        className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                          form.buyerType === key ? 'bg-peacock text-white' : 'text-muted hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="mt-1 block text-xs text-muted">
                    Dealers see wholesale (dealer) rates after the shop confirms the account.
                  </span>
                </div>
              </>
            )}
            <Field label="Email" value={form.email} onChange={set('email')}
                   type="email" autoComplete="email" required />
            <Field label="Password" value={form.password} onChange={set('password')}
                   type="password" autoComplete={tab === 'in' ? 'current-password' : 'new-password'}
                   required />

            {error && (
              <p className="text-sm text-dues bg-dues/10 border border-dues/30 rounded-md px-3 py-2">
                {error}
              </p>
            )}
            {notice && (
              <p className="text-sm text-peacock bg-peacock/10 border border-peacock/30 rounded-md px-3 py-2">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-peacock hover:bg-peacock-700 disabled:opacity-60
                         text-white font-semibold py-2.5 transition"
            >
              {busy ? 'Please wait…' : tab === 'in' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="mt-8 text-center">
            <Credit />
          </div>
        </div>
      </main>
    </div>
  )
}

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

function humanError(msg) {
  if (!msg) return 'Something went wrong. Please try again.'
  if (/invalid login credentials/i.test(msg)) return 'Email or password is incorrect.'
  if (/already registered/i.test(msg)) return 'This email already has an account. Try signing in.'
  if (/password should be at least/i.test(msg)) return 'Use a password of at least 6 characters.'
  return msg
}
