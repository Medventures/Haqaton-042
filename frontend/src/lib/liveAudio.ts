export const LIVE_SAMPLE_RATE = 16_000
export const LIVE_CHUNK_SECONDS = 6
export const LIVE_MAX_SECONDS = 30 * 60

export type LiveLanguage = 'ru' | 'kk' | 'auto'
export type LiveRole = 'doctor' | 'patient' | 'unknown'
export interface LiveSegment {
  id: string
  start: number
  end: number
  speaker_id?: string | null
  role: LiveRole
  text: string
}
export interface LiveTranscript {
  language: string
  segments: LiveSegment[]
}

/** Area averaging preserves duration and avoids simply dropping input samples. */
export function resampleMono(
  input: Float32Array,
  sourceRate: number,
  targetRate = LIVE_SAMPLE_RATE,
): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || targetRate <= 0)
    throw new Error('Некорректная частота аудио.')
  if (!input.length) return new Float32Array()
  if (sourceRate === targetRate) return input.slice()
  const ratio = sourceRate / targetRate
  const result = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < result.length; index += 1) {
    const start = index * ratio
    const end = Math.min((index + 1) * ratio, input.length)
    let value = 0
    for (let at = Math.floor(start); at < Math.ceil(end); at += 1) {
      const width = Math.min(at + 1, end) - Math.max(at, start)
      value += (input[at] ?? 0) * width
    }
    result[index] = end > start ? value / (end - start) : 0
  }
  return result
}

/** Each fragment is a complete mono PCM16 WAV, including its own RIFF header. */
export function encodeWav(
  samples: Float32Array,
  sampleRate = LIVE_SAMPLE_RATE,
): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1)
      view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index])
      ? Math.max(-1, Math.min(1, samples[index]))
      : 0
    view.setInt16(
      44 + index * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    )
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export function placeLiveSegments(
  segments: LiveSegment[],
  chunk: { id: string; offset: number; duration: number },
  dictatedRole: 'doctor' | 'unknown',
): LiveSegment[] {
  const clamp = (time: number) =>
    Math.min(chunk.duration, Math.max(0, Number.isFinite(time) ? time : 0))
  return segments
    .filter((segment) => segment.text.trim())
    .map((segment) => {
      const start = clamp(segment.start)
      return {
        ...segment,
        id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment.id) ? segment.id : crypto.randomUUID(),
        start: chunk.offset + start,
        end: chunk.offset + Math.max(start, clamp(segment.end)),
        role: dictatedRole === 'doctor' ? 'doctor' : segment.role,
        text: segment.text.trim(),
      }
    })
}

export async function transcribeLiveChunk(
  blob: Blob,
  language: LiveLanguage,
  signal: AbortSignal,
  baseUrl = '/api',
): Promise<LiveTranscript> {
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/live/transcribe?language=${language}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob,
      signal,
      cache: 'no-store',
    },
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `Не удалось распознать фрагмент (${response.status}).`,
    )
  }
  if (
    !body ||
    !Array.isArray(body.segments) ||
    body.segments.some(
      (segment: Partial<LiveSegment>) =>
        !segment ||
        typeof segment.text !== 'string' ||
        typeof segment.start !== 'number' ||
        typeof segment.end !== 'number' ||
        !['doctor', 'patient', 'unknown'].includes(segment.role ?? ''),
    )
  ) {
    throw new Error(
      'Сервер вернул неполную расшифровку. Фрагмент сохранён для повторной попытки.',
    )
  }
  return {
    language: typeof body.language === 'string' ? body.language : language,
    segments: body.segments,
  }
}
