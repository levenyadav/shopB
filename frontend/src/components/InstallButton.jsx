import { useEffect, useState } from 'react'
import { IconDownload, IconShare2, IconSquarePlus, IconX } from '@tabler/icons-react'

// "Install app" control for the installable PWA. Two paths, one button:
//   * Android/Chromium — the browser fires `beforeinstallprompt`; we stash it and
//     replay it when tapped (the native install sheet).
//   * iOS Safari — there is no prompt event; Apple only supports manual "Add to
//     Home Screen", so we show a short how-to instead.
// Renders nothing on desktop, when already installed (standalone), or when the
// platform can't install — so it's safe to drop into any header.

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true

const isIos = () =>
  /iphone|ipad|ipod/i.test(window.navigator.userAgent) &&
  !/crios|fxios|edgios/i.test(window.navigator.userAgent) // real Safari only

const isMobile = () =>
  window.matchMedia?.('(max-width: 900px)').matches ||
  window.matchMedia?.('(pointer: coarse)').matches

export default function InstallButton({ className = '' }) {
  const [deferred, setDeferred] = useState(null) // stashed beforeinstallprompt
  const [installed, setInstalled] = useState(isStandalone())
  const [iosHelp, setIosHelp] = useState(false)
  const mobile = isMobile()
  const ios = isIos()

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault() // stop Chrome's mini-infobar; we drive our own button
      setDeferred(e)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  async function install() {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice.catch(() => {})
    setDeferred(null) // a prompt can only be used once
  }

  if (installed || !mobile) return null
  // Show only when the browser has offered an install (Android) or on iOS Safari.
  if (!deferred && !ios) return null

  const btn =
    'inline-flex items-center gap-1.5 rounded-lg bg-saffron px-3 py-2 text-sm font-semibold text-white shadow-[inset_0_-2px_0_color-mix(in_srgb,var(--color-saffron)_70%,#000)] hover:brightness-95 active:translate-y-px'

  return (
    <>
      <button
        type="button"
        onClick={() => (ios ? setIosHelp(true) : install())}
        className={`${btn} ${className}`}
        aria-label="Install app"
      >
        <IconDownload size={18} stroke={1.8} />
        <span>Install app</span>
      </button>

      {iosHelp && (
        <div
          className="fixed inset-0 z-50 grid place-items-end bg-ink/40 sm:place-items-center"
          onClick={() => setIosHelp(false)}
        >
          <div
            className="w-full rounded-t-2xl border border-line bg-card p-5 sm:max-w-sm sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-ink">Install this app</h3>
              <button
                onClick={() => setIosHelp(false)}
                className="rounded-lg p-1 text-muted hover:bg-paper-2 hover:text-ink"
                aria-label="Close"
              >
                <IconX size={18} />
              </button>
            </div>
            <p className="mb-4 text-sm text-muted">
              Add it to your Home Screen for a full-screen, app-like experience.
            </p>
            <ol className="space-y-3 text-sm text-ink">
              <li className="flex items-center gap-3">
                <IconShare2 size={22} className="shrink-0 text-peacock" />
                <span>
                  Tap the <b>Share</b> button in Safari's toolbar.
                </span>
              </li>
              <li className="flex items-center gap-3">
                <IconSquarePlus size={22} className="shrink-0 text-peacock" />
                <span>
                  Choose <b>Add to Home Screen</b>, then tap <b>Add</b>.
                </span>
              </li>
            </ol>
          </div>
        </div>
      )}
    </>
  )
}
