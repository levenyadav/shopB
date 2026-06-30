import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { IconX, IconBarcode, IconKeyboard } from '@tabler/icons-react'
import { Button, Field, Spinner } from './ui'

// Live camera barcode/QR scanner (SPEC §6.1 — Purchase Entry scan).
// Opens the back camera, decodes continuously, and calls onDetected(code) with
// the first code it reads. Falls back to manual typing if the camera is blocked
// or unavailable, so the owner is never stuck at a dead end.
export default function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const [status, setStatus] = useState('starting') // starting | scanning | error
  const [errMsg, setErrMsg] = useState('')
  const [manual, setManual] = useState('')

  useEffect(() => {
    let cancelled = false
    const reader = new BrowserMultiFormatReader()

    async function start() {
      try {
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          videoRef.current,
          (result) => {
            if (result && !cancelled) {
              const code = result.getText().trim()
              if (code) {
                controlsRef.current?.stop()
                onDetected(code)
              }
            }
          },
        )
        if (cancelled) { controls.stop(); return }
        controlsRef.current = controls
        setStatus('scanning')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setErrMsg(
          err?.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow camera in your browser, or type the code below.'
            : err?.name === 'NotFoundError'
              ? 'No camera was found on this device. Type the code below instead.'
              : 'Could not start the camera. Type the code below instead.',
        )
      }
    }
    start()

    return () => {
      cancelled = true
      controlsRef.current?.stop()
    }
  }, [onDetected])

  function submitManual(e) {
    e.preventDefault()
    const code = manual.trim()
    if (code) onDetected(code)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-card"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="inline-flex items-center gap-2 font-[var(--font-display)] text-lg font-bold">
            <IconBarcode size={20} /> Scan barcode
          </h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-paper-2">
            <IconX size={20} />
          </button>
        </div>

        <div className="relative aspect-square w-full bg-black">
          {/* keep the video mounted so the ref is ready before decoding starts */}
          <video
            ref={videoRef}
            className={`h-full w-full object-cover ${status === 'scanning' ? '' : 'opacity-0'}`}
            muted
            playsInline
          />
          {status === 'scanning' && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="h-2/3 w-2/3 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
          )}
          {status === 'starting' && (
            <div className="absolute inset-0 grid place-items-center text-white/80">
              <span className="inline-flex items-center gap-2 text-sm"><Spinner /> Starting camera…</span>
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/80">
              {errMsg}
            </div>
          )}
        </div>

        <div className="space-y-3 px-5 py-4">
          {status === 'scanning' && (
            <p className="text-center text-sm text-muted">Point the camera at the barcode or QR code.</p>
          )}
          <form onSubmit={submitManual} className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Or type / paste the code"
                placeholder="e.g. 8901234567890"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
              />
            </div>
            <Button type="submit" variant="ghost" disabled={!manual.trim()}>
              <IconKeyboard size={18} /> Use
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
