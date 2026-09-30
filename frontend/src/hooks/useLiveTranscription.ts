import { useCallback, useEffect, useRef, useState } from 'react'
import {
  encodeWav,
  LIVE_MAX_SECONDS,
  placeLiveSegments,
  resampleMono,
  transcribeLiveChunk,
} from '../lib/liveAudio'
import type { LiveLanguage, LiveSegment } from '../lib/liveAudio'

export type { LiveSegment, LiveLanguage } from '../lib/liveAudio'
export type LiveTranscriptionStatus =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'paused'
  | 'finishing'
  | 'finished'
  | 'error'

interface Options {
  language: LiveLanguage
  onSegments: (segments: LiveSegment[]) => void
  onError?: (message: string) => void
}
interface Chunk {
  id: string
  offset: number
  duration: number
  blob: Blob
}
interface Session {
  id: string
  language: LiveLanguage
  role: 'doctor' | 'unknown'
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  mute: GainNode
  queue: Chunk[]
  sequence: number
  seconds: number
  paused: boolean
  ending: boolean
  closed: boolean
  failed: boolean
  incomplete: boolean
  failureMessage: string
  worker: Promise<boolean> | null
  stopTask: Promise<boolean> | null
  pauseTask: Promise<void> | null
  request: AbortController | null
  drainTimer: ReturnType<typeof setTimeout> | null
  acknowledgements: Map<
    number,
    {
      resolve: () => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
  controlSequence: number
}

const env = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env
const apiBase = env?.VITE_API_URL || env?.VITE_API_BASE_URL || '/api'

function closeCapture(session: Session) {
  if (session.closed) return
  session.closed = true
  session.stream.getTracks().forEach((track) => {
    track.onended = null
    track.stop()
  })
  session.node.port.onmessage = null
  session.node.onprocessorerror = null
  session.source.disconnect()
  session.node.disconnect()
  session.mute.disconnect()
  void session.context.close().catch(() => {})
  for (const entry of session.acknowledgements.values()) {
    clearTimeout(entry.timer)
    entry.reject(new Error('Запись завершена.'))
  }
  session.acknowledgements.clear()
}

function control(
  session: Session,
  type: 'pause' | 'resume' | 'stop',
): Promise<void> {
  if (session.closed) return Promise.resolve()
  const id = ++session.controlSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.acknowledgements.delete(id)
      reject(
        new Error(
          'Микрофон не ответил. Последний фрагмент мог не сохраниться.',
        ),
      )
    }, 2_000)
    session.acknowledgements.set(id, { resolve, reject, timer })
    session.node.port.postMessage({ type, id })
  })
}

/** Six-second independent WAV requests; recording begins only on explicit start(). */
export function useLiveTranscription(options: Options) {
  const [status, setStatus] = useState<LiveTranscriptionStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [pendingChunks, setPendingChunks] = useState(0)
  const [error, setError] = useState('')
  const callbacks = useRef(options)
  callbacks.current = options
  const mounted = useRef(false)
  const generation = useRef(0)
  const connecting = useRef(false)
  const active = useRef<Session | null>(null)
  const pendingCapture = useRef<{
    stream: MediaStream
    context: AudioContext | null
  } | null>(null)
  const stopRef = useRef<() => Promise<boolean>>(async () => true)
  const pumpRef = useRef<(session: Session) => Promise<boolean>>(
    async () => true,
  )
  const supported =
    typeof window !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!window.AudioContext &&
    !!window.AudioWorkletNode
  const isCurrent = useCallback(
    (session: Session) => mounted.current && active.current === session,
    [],
  )

  const releasePendingCapture = useCallback(() => {
    const pending = pendingCapture.current
    pendingCapture.current = null
    pending?.stream.getTracks().forEach((track) => track.stop())
    if (pending?.context && pending.context.state !== 'closed')
      void pending.context.close().catch(() => {})
  }, [])

  const discard = useCallback(() => {
    generation.current += 1
    connecting.current = false
    releasePendingCapture()
    const session = active.current
    active.current = null
    if (!session) return
    session.request?.abort()
    if (session.drainTimer) clearTimeout(session.drainTimer)
    closeCapture(session)
    session.queue = []
  }, [releasePendingCapture])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      discard()
    }
  }, [discard])

  const reportFailure = useCallback(
    (session: Session, message: string) => {
      if (!isCurrent(session)) return
      session.failed = true
      session.failureMessage = message
      setError(message)
      setStatus('error')
      setLevel(0)
      callbacks.current.onError?.(message)
    },
    [isCurrent],
  )

  const pauseCapture = useCallback(
    (session: Session): Promise<void> => {
      if (session.paused || session.closed)
        return session.pauseTask ?? Promise.resolve()
      session.paused = true
      // Disabling tracks stops further input while the worklet flushes its buffer.
      session.stream.getAudioTracks().forEach((track) => {
        track.enabled = false
      })
      session.pauseTask = control(session, 'pause')
        .catch((cause: unknown) => {
          if (isCurrent(session)) {
            session.incomplete = true
            reportFailure(
              session,
              cause instanceof Error
                ? cause.message
                : 'Не удалось приостановить микрофон.',
            )
            closeCapture(session)
          }
        })
        .finally(() => {
          session.pauseTask = null
        })
      setLevel(0)
      return session.pauseTask
    },
    [isCurrent, reportFailure],
  )

  const pump = useCallback(
    (session: Session): Promise<boolean> => {
      if (session.worker) return session.worker
      if (!isCurrent(session) || session.failed) return Promise.resolve(false)
      const task = async (): Promise<boolean> => {
        while (isCurrent(session) && session.queue.length && !session.failed) {
          const chunk = session.queue[0]
          const request = new AbortController()
          session.request = request
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            request.abort()
          }, 60_000)
          try {
            const result = await transcribeLiveChunk(
              chunk.blob,
              session.language,
              request.signal,
              apiBase,
            )
            if (!isCurrent(session)) return false
            session.queue.shift()
            setPendingChunks(session.queue.length)
            const segments = placeLiveSegments(
              result.segments,
              chunk,
              session.role,
            )
            if (segments.length) callbacks.current.onSegments(segments)
          } catch (cause) {
            if (!isCurrent(session)) return false
            const message = session.failed
              ? session.failureMessage
              : timedOut
                ? 'Распознавание заняло больше минуты. Запись приостановлена; фрагменты сохранены. Повторите попытку.'
                : cause instanceof TypeError
                  ? 'Нет связи с сервером. Запись приостановлена; фрагменты сохранены. Проверьте подключение и повторите попытку.'
                  : cause instanceof Error
                    ? cause.message
                    : 'Не удалось распознать фрагмент. Повторите попытку.'
            reportFailure(session, message)
            void pauseCapture(session)
            return false
          } finally {
            clearTimeout(timer)
            if (session.request === request) session.request = null
          }
        }
        return isCurrent(session) && !session.failed
      }
      session.worker = task().finally(() => {
        session.worker = null
      })
      return session.worker
    },
    [isCurrent, pauseCapture, reportFailure],
  )
  pumpRef.current = pump

  const drain = useCallback(
    async (session: Session): Promise<boolean> => {
      // An explicit finish/retry has a total deadline, even when several fragments wait.
      session.drainTimer = setTimeout(() => {
        if (!isCurrent(session)) return
        reportFailure(
          session,
          'Сервер пока не обработал все фрагменты. Они сохранены в этой вкладке; нажмите «Повторить».',
        )
        session.request?.abort()
      }, 120_000)
      try {
        const complete = await pump(session)
        if (!isCurrent(session)) return false
        if (complete && !session.incomplete && !session.queue.length) {
          setStatus(session.ending ? 'finished' : 'paused')
          setError('')
          return true
        }
        return false
      } finally {
        if (session.drainTimer) clearTimeout(session.drainTimer)
        session.drainTimer = null
      }
    },
    [isCurrent, pump, reportFailure],
  )

  const stop = useCallback(async (): Promise<boolean> => {
    const session = active.current
    if (!session) {
      generation.current += 1
      connecting.current = false
      releasePendingCapture()
      if (mounted.current) setStatus('finished')
      return true
    }
    if (session.stopTask) return session.stopTask
    session.ending = true
    if (!session.failed) setStatus('finishing')
    const task = async () => {
      await pauseCapture(session)
      closeCapture(session)
      if (!isCurrent(session)) return false
      setSeconds(Math.floor(session.seconds))
      setLevel(0)
      if (session.failed) return false
      return drain(session)
    }
    session.stopTask = task().finally(() => {
      session.stopTask = null
    })
    return session.stopTask
  }, [drain, isCurrent, pauseCapture, releasePendingCapture])
  stopRef.current = stop

  const start = useCallback(
    async (role: 'doctor' | 'unknown' = 'unknown'): Promise<boolean> => {
      if (!mounted.current || connecting.current || active.current) return false
      const request = ++generation.current
      connecting.current = true
      setStatus('connecting')
      setError('')
      let stream: MediaStream | null = null
      let context: AudioContext | null = null
      let session: Session | null = null
      try {
        if (!supported)
          throw new Error(
            'Для записи нужен браузер с поддержкой AudioWorklet. Откройте приложение по HTTPS или на localhost в актуальном Chrome, Edge или Safari.',
          )
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
        if (!mounted.current || generation.current !== request) {
          stream.getTracks().forEach((track) => track.stop())
          return false
        }
        context = new AudioContext()
        pendingCapture.current = { stream, context }
        if (!context.audioWorklet)
          throw new Error(
            'Этот браузер не поддерживает запись в реальном времени.',
          )
        await context.audioWorklet.addModule(
          `${env?.BASE_URL || '/'}pcm-capture-worklet.js`,
        )
        if (!mounted.current || generation.current !== request) {
          stream.getTracks().forEach((track) => track.stop())
          await context.close()
          return false
        }
        const source = context.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(context, 'pcm-capture')
        const mute = context.createGain()
        mute.gain.value = 0
        const next: Session = {
          id: crypto.randomUUID(),
          language: callbacks.current.language,
          role,
          stream,
          context,
          source,
          node,
          mute,
          queue: [],
          sequence: 0,
          seconds: 0,
          paused: false,
          ending: false,
          closed: false,
          failed: false,
          incomplete: false,
          failureMessage: '',
          worker: null,
          stopTask: null,
          pauseTask: null,
          request: null,
          drainTimer: null,
          acknowledgements: new Map(),
          controlSequence: 0,
        }
        session = next
        active.current = next
        pendingCapture.current = null
        node.port.onmessage = ({ data }) => {
          if (!isCurrent(next)) return
          if (data.type === 'ack') {
            const entry = next.acknowledgements.get(data.id)
            if (entry) {
              clearTimeout(entry.timer)
              next.acknowledgements.delete(data.id)
              entry.resolve()
            }
          } else if (
            data.type === 'chunk' &&
            data.samples instanceof Float32Array &&
            data.samples.length
          ) {
            const duration = data.samples.length / next.context.sampleRate
            next.queue.push({
              id: `${next.id}-${next.sequence++}`,
              offset: next.seconds,
              duration,
              blob: encodeWav(
                resampleMono(data.samples, next.context.sampleRate),
              ),
            })
            next.seconds += duration
            setSeconds(Math.min(LIVE_MAX_SECONDS, Math.floor(next.seconds)))
            setPendingChunks(next.queue.length)
            if (next.queue.length >= 8 && !next.paused && !next.ending) {
              setStatus('paused')
              setError(
                'Сервер обрабатывает очередь. Запись приостановлена, чтобы сохранить все фрагменты. После обработки продолжите запись.',
              )
              void pauseCapture(next)
            }
            void pumpRef.current(next)
          } else if (data.type === 'level' && !next.paused) {
            setLevel(Math.min(1, Math.max(0, Number(data.level) * 4 || 0)))
            setSeconds(
              Math.min(LIVE_MAX_SECONDS, Math.floor(Number(data.seconds) || 0)),
            )
          } else if (data.type === 'limit') {
            void stopRef.current()
          }
        }
        node.onprocessorerror = () => {
          reportFailure(
            next,
            'Запись прервалась. Уже записанные фрагменты сохранены; последний фрагмент мог не сохраниться.',
          )
          next.incomplete = true
          closeCapture(next)
        }
        stream.getAudioTracks().forEach((track) => {
          track.onended = () => {
            void stopRef.current()
          }
        })
        source.connect(node)
        node.connect(mute)
        mute.connect(context.destination)
        await context.resume()
        if (
          !isCurrent(next) ||
          generation.current !== request ||
          next.ending ||
          next.closed
        ) {
          closeCapture(next)
          return false
        }
        setSeconds(0)
        setPendingChunks(0)
        setLevel(0)
        setStatus('recording')
        return true
      } catch (cause) {
        if (pendingCapture.current?.stream === stream)
          pendingCapture.current = null
        if (session) {
          if (active.current === session) active.current = null
          closeCapture(session)
        } else {
          stream?.getTracks().forEach((track) => track.stop())
          if (context && context.state !== 'closed')
            void context.close().catch(() => {})
        }
        if (
          mounted.current &&
          generation.current === request &&
          !session?.ending
        ) {
          const message =
            cause instanceof DOMException && cause.name === 'NotAllowedError'
              ? 'Разрешите доступ к микрофону в настройках браузера и попробуйте ещё раз.'
              : cause instanceof DOMException && cause.name === 'NotFoundError'
                ? 'Микрофон не найден. Подключите его и попробуйте ещё раз.'
                : cause instanceof DOMException &&
                    cause.name === 'NotReadableError'
                  ? 'Микрофон занят или недоступен. Проверьте его подключение.'
                  : cause instanceof Error
                    ? cause.message
                    : 'Не удалось включить микрофон.'
          setError(message)
          setStatus('error')
          callbacks.current.onError?.(message)
        }
        return false
      } finally {
        if (generation.current === request) connecting.current = false
      }
    },
    [isCurrent, pauseCapture, reportFailure, supported],
  )

  const pause = useCallback(() => {
    const session = active.current
    if (!session || session.ending || session.failed || session.closed) return
    setStatus('paused')
    void pauseCapture(session)
  }, [pauseCapture])

  const resume = useCallback(async () => {
    const session = active.current
    if (
      !session ||
      session.ending ||
      session.failed ||
      session.closed ||
      !session.paused
    )
      return
    if (session.queue.length >= 8) {
      setError('Дождитесь обработки очереди, затем продолжите запись.')
      return
    }
    await session.pauseTask
    if (
      !isCurrent(session) ||
      session.failed ||
      session.closed ||
      session.ending
    )
      return
    try {
      await session.context.resume()
      await control(session, 'resume')
      if (!isCurrent(session) || session.failed || session.ending) return
      session.paused = false
      session.stream.getAudioTracks().forEach((track) => {
        track.enabled = true
      })
      setError('')
      setStatus('recording')
    } catch {
      reportFailure(
        session,
        'Не удалось продолжить запись. Завершите её и попробуйте ещё раз.',
      )
    }
  }, [isCurrent, reportFailure])

  const retry = useCallback(async (): Promise<boolean> => {
    const session = active.current
    if (!session || !session.failed || session.worker || session.stopTask)
      return false
    session.failed = false
    session.failureMessage = ''
    setError(
      session.incomplete
        ? 'Последний фрагмент записи мог не сохраниться. Проверьте расшифровку.'
        : '',
    )
    setStatus(session.ending ? 'finishing' : 'paused')
    const result = await drain(session)
    if (isCurrent(session) && session.incomplete) {
      reportFailure(
        session,
        'Сохранённые фрагменты обработаны. Последний фрагмент мог не сохраниться; проверьте расшифровку перед завершением.',
      )
    }
    return result
  }, [drain, isCurrent, reportFailure])

  const reset = useCallback(() => {
    discard()
    if (!mounted.current) return
    setStatus('idle')
    setSeconds(0)
    setLevel(0)
    setPendingChunks(0)
    setError('')
  }, [discard])

  return {
    status,
    seconds,
    level,
    pendingChunks,
    error,
    supported,
    start,
    pause,
    resume,
    stop,
    retry,
    reset,
  }
}
