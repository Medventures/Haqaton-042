import { useCallback, useEffect, useRef, useState } from 'react'

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'recorded'

const MAX_DURATION_MS = 30 * 60 * 1000

type Session = {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  elapsedMs: number
  activeSince: number | null
  interval: ReturnType<typeof setInterval> | null
  deadline: ReturnType<typeof setTimeout> | null
  stopping: boolean
}

function clearTimers(session: Session) {
  if (session.interval !== null) clearInterval(session.interval)
  if (session.deadline !== null) clearTimeout(session.deadline)
  session.interval = null
  session.deadline = null
}

function elapsed(session: Session) {
  return Math.min(
    MAX_DURATION_MS,
    session.elapsedMs +
      (session.activeSince === null
        ? 0
        : performance.now() - session.activeSince),
  )
}

function freezeTime(session: Session) {
  session.elapsedMs = elapsed(session)
  session.activeSince = null
  clearTimers(session)
}

function release(session: Session) {
  clearTimers(session)
  session.recorder.ondataavailable = null
  session.recorder.onstop = null
  session.recorder.onerror = null
  try {
    if (session.recorder.state !== 'inactive') session.recorder.stop()
  } catch {
    // Releasing the microphone must still happen if the recorder has failed.
  } finally {
    session.stream.getTracks().forEach((track) => track.stop())
  }
}

/** Captures audio in browser memory. No upload, persistence, or automatic access. */
export function useRecorder() {
  const [status, setStatus] = useState<RecordingStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const [audioUrl, setAudioUrl] = useState('')
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const generation = useRef(0)
  const pendingRef = useRef(false)
  const sessionRef = useRef<Session | null>(null)
  const urlRef = useRef('')

  const discard = useCallback(() => {
    generation.current += 1
    pendingRef.current = false
    const session = sessionRef.current
    sessionRef.current = null
    if (session) release(session)
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = ''
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      discard()
    }
  }, [discard])

  const fail = useCallback((session: Session, message: string) => {
    if (!mounted.current || sessionRef.current !== session) return
    sessionRef.current = null
    release(session)
    setStatus('idle')
    setError(message)
  }, [])

  const finish = useCallback((session: Session) => {
    if (!mounted.current || sessionRef.current !== session) return
    freezeTime(session)
    release(session)
    sessionRef.current = null
    setSeconds(Math.floor(session.elapsedMs / 1000))
    try {
      const blob = new Blob(session.chunks, {
        type:
          session.recorder.mimeType || session.chunks[0]?.type || 'audio/webm',
      })
      if (!blob.size) throw new Error('empty-recording')
      const url = URL.createObjectURL(blob)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = url
      setAudioUrl(url)
      setAudioBlob(blob)
      setStatus('recorded')
    } catch {
      setStatus('idle')
      setError('Аудио не записалось. Проверьте микрофон и попробуйте ещё раз.')
    }
  }, [])

  const stop = useCallback(() => {
    const session = sessionRef.current
    if (!mounted.current || !session || session.stopping) return
    session.stopping = true
    freezeTime(session)
    setSeconds(Math.floor(session.elapsedMs / 1000))
    try {
      // The final dataavailable event precedes onstop, where we build the audio.
      if (session.recorder.state !== 'inactive') session.recorder.stop()
      session.stream.getTracks().forEach((track) => track.stop())
      setStatus('recorded')
    } catch {
      fail(
        session,
        'Не удалось завершить запись. Попробуйте записать её ещё раз.',
      )
    }
  }, [fail])

  const runClock = useCallback(
    (session: Session) => {
      clearTimers(session)
      session.activeSince = performance.now()
      session.interval = setInterval(() => {
        if (!mounted.current || sessionRef.current !== session) return
        const duration = elapsed(session)
        setSeconds(Math.floor(duration / 1000))
        if (duration >= MAX_DURATION_MS) stop()
      }, 250)
      session.deadline = setTimeout(
        () => {
          if (mounted.current && sessionRef.current === session) stop()
        },
        Math.max(0, MAX_DURATION_MS - session.elapsedMs),
      )
    },
    [stop],
  )

  const start = useCallback(async (): Promise<boolean> => {
    if (!mounted.current || pendingRef.current || sessionRef.current)
      return false
    const request = ++generation.current
    pendingRef.current = true
    setPending(true)
    setError('')
    let stream: MediaStream | null = null
    let session: Session | null = null
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error(
          'Запись недоступна. Откройте приложение по HTTPS или на localhost в браузере с поддержкой микрофона.',
        )
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current || generation.current !== request) {
        stream.getTracks().forEach((track) => track.stop())
        return false
      }
      const recorder = new MediaRecorder(stream)
      const next: Session = {
        recorder,
        stream,
        chunks: [],
        elapsedMs: 0,
        activeSince: null,
        interval: null,
        deadline: null,
        stopping: false,
      }
      session = next
      sessionRef.current = next
      recorder.ondataavailable = (event) => {
        if (mounted.current && sessionRef.current === next && event.data.size) {
          next.chunks.push(event.data)
        }
      }
      recorder.onstop = () => finish(next)
      recorder.onerror = () => {
        fail(
          next,
          'Запись прервалась. Проверьте подключение микрофона и начните снова.',
        )
      }
      recorder.start(1000)
      // Keep existing audio if access was denied or a new recorder failed to start.
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = ''
      setAudioUrl('')
      setAudioBlob(null)
      setSeconds(0)
      setStatus('recording')
      runClock(next)
      return true
    } catch (cause) {
      if (session) {
        if (sessionRef.current === session) sessionRef.current = null
        release(session)
      } else {
        stream?.getTracks().forEach((track) => track.stop())
      }
      if (mounted.current && generation.current === request) {
        setError(
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Нет доступа к микрофону. Разрешите его в настройках браузера и попробуйте снова.'
            : cause instanceof DOMException && cause.name === 'NotFoundError'
              ? 'Микрофон не найден. Подключите микрофон и попробуйте снова.'
              : cause instanceof DOMException &&
                  cause.name === 'NotReadableError'
                ? 'Микрофон занят или недоступен. Проверьте подключение и другие приложения.'
                : cause instanceof Error
                  ? cause.message
                  : 'Не удалось включить микрофон.',
        )
      }
      return false
    } finally {
      if (mounted.current && generation.current === request) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }, [fail, finish, runClock])

  const pauseResume = useCallback(() => {
    const session = sessionRef.current
    if (!mounted.current || !session || session.stopping) return
    if (elapsed(session) >= MAX_DURATION_MS) {
      stop()
      return
    }
    try {
      if (session.recorder.state === 'recording') {
        session.recorder.pause()
        freezeTime(session)
        setSeconds(Math.floor(session.elapsedMs / 1000))
        setStatus('paused')
      } else if (session.recorder.state === 'paused') {
        session.recorder.resume()
        runClock(session)
        setStatus('recording')
      }
    } catch {
      fail(
        session,
        'Не удалось продолжить запись. Проверьте микрофон и начните снова.',
      )
    }
  }, [fail, runClock, stop])

  const reset = useCallback(() => {
    discard()
    if (!mounted.current) return
    setStatus('idle')
    setSeconds(0)
    setAudioUrl('')
    setAudioBlob(null)
    setPending(false)
    setError('')
  }, [discard])

  const clearError = useCallback(() => setError(''), [])

  return {
    status,
    seconds,
    audioUrl,
    audioBlob,
    pending,
    error,
    start,
    pauseResume,
    stop,
    reset,
    clearError,
  }
}
