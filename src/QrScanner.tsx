import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'

/** The table code inside a scanned QR: an invite link (?join=CODE) or the bare 8-character code. */
function codeFromScan(text: string) {
  try {
    const c = new URL(text).searchParams.get('join')
    if (c && /^[A-Za-z0-9]{8}$/.test(c)) return c.toUpperCase()
  } catch {
    /* not a URL */
  }
  const t = text.trim()
  return /^[A-Za-z0-9]{8}$/.test(t) ? t.toUpperCase() : null
}

/** Opens the back camera and reports the first table code it sees. Mount it only while scanning: unmounting stops the camera. */
export function QrScanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null),
    cb = useRef(onCode),
    [err, setErr] = useState('')
  cb.current = onCode
  useEffect(() => {
    let stop = false,
      stream: MediaStream | null = null,
      raf = 0
    const canvas = document.createElement('canvas'),
      ctx = canvas.getContext('2d', { willReadFrequently: true })
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !ctx) throw new Error('unsupported')
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        })
        if (stop) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        const v = video.current
        if (!v) return
        v.srcObject = stream
        await v.play()
        const tick = () => {
          if (stop) return
          if (v.readyState >= 2 && v.videoWidth) {
            const k = Math.min(1, 640 / v.videoWidth)
            canvas.width = Math.round(v.videoWidth * k)
            canvas.height = Math.round(v.videoHeight * k)
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height),
              hit = jsQR(img.data, img.width, img.height),
              code = hit && codeFromScan(hit.data)
            if (code) {
              stop = true
              cb.current(code)
              return
            }
          }
          raf = requestAnimationFrame(tick)
        }
        tick()
      } catch (e) {
        setErr(
          e instanceof Error && e.message === 'unsupported'
            ? 'This browser cannot open the camera here. Type the code instead.'
            : 'Camera access was blocked. Allow the camera for this site, or type the code instead.',
        )
      }
    })()
    return () => {
      stop = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [])
  return err ? (
    <p className="emptyNote" role="alert">
      {err}
    </p>
  ) : (
    <div className="scanner">
      <video ref={video} muted playsInline aria-label="Camera view" />
      <p className="fieldHint">Point the camera at the QR code on the host's screen.</p>
    </div>
  )
}
