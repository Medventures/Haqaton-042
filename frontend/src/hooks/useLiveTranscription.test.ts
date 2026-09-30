import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal hook harness keeps the lifecycle test independent of a DOM or real microphone.
const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  cleanup: [] as (() => void)[],
  first: true,
}))
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = harness.index++
    if (harness.first) harness.values[index] = initial
    return [
      harness.values[index],
      (value: unknown) => {
        harness.values[index] = value
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = harness.index++
    if (harness.first) harness.values[index] = { current: initial }
    return harness.values[index]
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => () => void) => {
    if (harness.first)
      harness.effects.push(() => {
        harness.cleanup.push(callback())
      })
  },
}))

import { useLiveTranscription } from './useLiveTranscription'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const settle = async () => {
  for (let index = 0; index < 15; index += 1) await Promise.resolve()
}

let moduleLoad: Promise<void>
let track: {
  enabled: boolean
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}
let nodes: MockNode[]
let contexts: MockContext[]
class MockContext {
  state = 'running'
  sampleRate = 16000
  destination = {}
  audioWorklet = { addModule: () => moduleLoad }
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  resume = vi.fn(async () => {})
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  createGain = () => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  })
  constructor() {
    contexts.push(this)
  }
}
class MockNode {
  partial: Float32Array | null = null
  onprocessorerror: (() => void) | null = null
  port = {
    onmessage: null as ((event: { data: object }) => void) | null,
    postMessage: (message: { type: string; id: number }) => {
      if (
        (message.type === 'pause' || message.type === 'stop') &&
        this.partial
      ) {
        this.emit({ type: 'chunk', samples: this.partial })
        this.partial = null
      }
      this.emit({ type: 'ack', id: message.id })
    },
  }
  emit(data: object) {
    this.port.onmessage?.({ data })
  }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() {
    nodes.push(this)
  }
}

beforeEach(() => {
  harness.values = []
  harness.index = 0
  harness.effects = []
  harness.cleanup = []
  harness.first = true
  moduleLoad = Promise.resolve()
  nodes = []
  contexts = []
  track = { enabled: true, stop: vi.fn(), onended: null }
  vi.stubGlobal('AudioContext', MockContext)
  vi.stubGlobal('AudioWorkletNode', MockNode)
  vi.stubGlobal('window', {
    AudioContext: MockContext,
    AudioWorkletNode: MockNode,
  })
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      }),
    },
  })
})
afterEach(() => {
  for (const cleanup of harness.cleanup) cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const onSegments = vi.fn()
  const render = () => {
    harness.index = 0
    const result = useLiveTranscription({ language: 'ru', onSegments })
    if (harness.first) {
      harness.first = false
      harness.effects.forEach((effect) => effect())
    }
    return result
  }
  return { render, onSegments, initial: render() }
}
const transcript = (text: string) =>
  new Response(
    JSON.stringify({
      language: 'ru',
      segments: [{ id: 'local', start: 0, end: 1, text, role: 'unknown' }],
    }),
  )

describe('microphone lifecycle and reliable live queue', () => {
  it('requests no microphone on mount and releases a permission response arriving after reset', async () => {
    const permission = deferred<MediaStream>()
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
      permission.promise,
    )
    const { initial, render } = mount()
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    const starting = initial.start()
    initial.reset()
    permission.resolve({ getTracks: () => [track] } as unknown as MediaStream)
    expect(await starting).toBe(false)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(render().status).toBe('idle')
    expect(contexts).toHaveLength(0)
  })

  it('releases microphone and audio context while the worklet is still loading', async () => {
    const module = deferred<void>()
    moduleLoad = module.promise
    const { initial, render } = mount()
    const starting = initial.start()
    await settle()
    expect(contexts).toHaveLength(1)
    initial.reset()
    expect(track.stop).toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalled()
    module.resolve()
    expect(await starting).toBe(false)
    expect(render().status).toBe('idle')
  })

  it('sends serially, retains a failed chunk for explicit retry, and delivers the stop fragment exactly once', async () => {
    const first = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Нет связи.' } }), {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(transcript('Второй'))
      .mockResolvedValueOnce(transcript('Последний'))
    vi.stubGlobal('fetch', fetcher)
    const { initial, render, onSegments } = mount()
    expect(await initial.start('doctor')).toBe(true)
    nodes[0].emit({ type: 'chunk', samples: new Float32Array(96000) })
    nodes[0].emit({ type: 'chunk', samples: new Float32Array(96000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    nodes[0].partial = new Float32Array(16000)
    first.resolve(transcript('Первый'))
    await settle()
    expect(render().status).toBe('error')
    expect(track.enabled).toBe(false)
    expect(render().pendingChunks).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await render().stop()).toBe(false)
    expect(track.stop).toHaveBeenCalled()
    expect(await render().retry()).toBe(true)
    expect(render().status).toBe('finished')
    expect(render().seconds).toBe(13)
    expect(render().pendingChunks).toBe(0)
    expect(
      onSegments.mock.calls.flatMap(([segments]) =>
        segments.map((segment: { text: string }) => segment.text),
      ),
    ).toEqual(['Первый', 'Второй', 'Последний'])
    const allSegments = onSegments.mock.calls.flatMap(([segments]) => segments)
    expect(allSegments.map((segment) => segment.start)).toEqual([0, 6, 12])
    expect(allSegments.every((segment) => segment.role === 'doctor')).toBe(true)
    expect(new Set(allSegments.map((segment) => segment.id)).size).toBe(3)
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[2][1].body)
  })
})
