/// <reference types="vite/client" />
import workletSource from '../../public/pcm-capture-worklet.js?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeWav,
  placeLiveSegments,
  resampleMono,
  transcribeLiveChunk,
} from './liveAudio'

afterEach(() => vi.unstubAllGlobals())

describe('independently decodable PCM audio', () => {
  it('writes an ordinary mono 16kHz PCM WAV, clips extreme values and silences NaN', async () => {
    const blob = encodeWav(new Float32Array([-2, -0.5, 0, 0.5, 2, NaN]))
    const bytes = await blob.arrayBuffer()
    const view = new DataView(bytes)
    const text = (start: number, length: number) =>
      new TextDecoder().decode(bytes.slice(start, start + length))
    expect(blob.type).toBe('audio/wav')
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(12)
    expect(
      Array.from({ length: 6 }, (_, index) =>
        view.getInt16(44 + index * 2, true),
      ),
    ).toEqual([-32768, -16384, 0, 16384, 32767, 0])
  })

  it.each([44100, 48000])(
    'preserves six-second duration and DC amplitude at input %iHz',
    (rate) => {
      const result = resampleMono(new Float32Array(rate * 6).fill(0.25), rate)
      expect(result.length).toBe(96000)
      expect(result.every((value) => Math.abs(value - 0.25) < 0.00001)).toBe(
        true,
      )
    },
  )

  it('averages samples instead of aliasing a rapidly alternating signal to a constant', () => {
    expect(
      Array.from(resampleMono(new Float32Array([1, -1, 1, -1]), 32000)),
    ).toEqual([0, 0])
    expect(resampleMono(new Float32Array(), 48000).length).toBe(0)
  })
})

describe('live transcript placement', () => {
  it('gives separate chunk identities and preserves provider roles unless doctor dictation was selected', () => {
    const segments = [
      {
        id: 'speaker-local-0',
        start: -1,
        end: 20,
        text: ' Слабость ',
        role: 'patient' as const,
      },
    ]
    const chunk = { id: 'session-2', offset: 12, duration: 6 }
    expect(placeLiveSegments(segments, chunk, 'unknown')).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        start: 12,
        end: 18,
        text: 'Слабость',
        role: 'patient',
      },
    ])
    expect(placeLiveSegments(segments, chunk, 'doctor')[0].role).toBe('doctor')
  })

  it('does not create empty utterances or negative durations', () => {
    const segments = [
      { id: 'a', start: 5, end: 2, text: 'Текст', role: 'unknown' as const },
      { id: 'b', start: 0, end: 1, text: '  ', role: 'unknown' as const },
    ]
    expect(
      placeLiveSegments(
        segments,
        { id: 'c', offset: 0, duration: 6 },
        'unknown',
      ),
    ).toEqual([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), start: 5, end: 5, text: 'Текст', role: 'unknown' }])
  })
})

describe('live request contract', () => {
  it('sends the complete WAV raw, forwards cancellation and accepts silence', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ language: 'ru', segments: [] })),
      )
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const blob = encodeWav(new Float32Array(160))
    expect(
      await transcribeLiveChunk(blob, 'ru', controller.signal, '/api/'),
    ).toEqual({ language: 'ru', segments: [] })
    expect(fetcher).toHaveBeenCalledWith(
      '/api/live/transcribe?language=ru',
      expect.objectContaining({
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'audio/wav' },
        signal: controller.signal,
        cache: 'no-store',
      }),
    )
  })

  it('does not turn an unavailable speech engine or malformed response into successful transcription', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Распознавание не настроено.' } }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ segments: [{ text: 'x' }] })),
      )
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    await expect(transcribeLiveChunk(new Blob(), 'ru', signal)).rejects.toThrow(
      'Распознавание не настроено.',
    )
    await expect(transcribeLiveChunk(new Blob(), 'ru', signal)).rejects.toThrow(
      'неполную расшифровку',
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('capture worklet', () => {
  type Message = { type: string; id?: number; samples?: Float32Array }
  interface Worklet {
    port: { onmessage: (event: { data: { type: string; id: number } }) => void }
    process: (input: Float32Array[][]) => boolean
    maxFrames: number
  }
  function worklet(rate = 16) {
    const messages: Message[] = []
    let Constructor: (new () => Worklet) | undefined
    class Base {
      port = {
        postMessage: (message: Message) => messages.push(message),
        onmessage: () => {},
      }
    }
    new Function(
      'AudioWorkletProcessor',
      'sampleRate',
      'registerProcessor',
      workletSource,
    )(Base, rate, (_name: string, constructor: new () => Worklet) => {
      Constructor = constructor
    })
    return { instance: new Constructor!(), messages }
  }

  it('flushes exactly one final partial chunk before pause acknowledgement, and excludes paused audio', () => {
    const { instance, messages } = worklet()
    instance.process([[new Float32Array([1, 2, 3, 4])]])
    instance.port.onmessage({ data: { type: 'pause', id: 1 } })
    const partial = messages.find((message) => message.type === 'chunk')!
    expect(Array.from(partial.samples!)).toEqual([1, 2, 3, 4])
    expect(messages.indexOf(partial)).toBeLessThan(
      messages.findIndex((message) => message.id === 1),
    )
    instance.process([[new Float32Array([9, 9])]])
    instance.port.onmessage({ data: { type: 'resume', id: 2 } })
    instance.process([[new Float32Array([5, 6])]])
    instance.port.onmessage({ data: { type: 'stop', id: 3 } })
    expect(
      messages
        .filter((message) => message.type === 'chunk')
        .map((message) => Array.from(message.samples!)),
    ).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ])
  })

  it('emits six-second chunks, mixes stereo to mono and enforces the capture limit', () => {
    const { instance, messages } = worklet(2)
    instance.maxFrames = 15
    instance.process([
      [new Float32Array(20).fill(1), new Float32Array(20).fill(-1)],
    ])
    const chunks = messages.filter((message) => message.type === 'chunk')
    expect(chunks.map((message) => message.samples!.length)).toEqual([12, 3])
    expect(
      chunks.every((message) => message.samples!.every((value) => value === 0)),
    ).toBe(true)
    expect(messages.filter((message) => message.type === 'limit')).toHaveLength(
      1,
    )
  })
})
