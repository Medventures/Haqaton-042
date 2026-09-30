import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  createMedHubClient,
  normalizeFields,
  type AudioJob,
  type Workspace,
} from './api'

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    revision: 4,
    expires_at: '2026-09-30T15:00:00Z',
    records: [],
    jobs: [],
    focus: '',
    fields: normalizeFields({}),
    evidence: [],
    field_sources: [],
    previous_recommendations: [],
    generated: false,
    context_stale: false,
    confirmed_revision: null,
    engine: 'local_rules',
    measurements: [],
    calculation: null,
    applied_calculation_text: null,
    automatic_calculation: {},
    document_fields: {}, document_sources: {}, review_notes: [],
    manually_edited_fields: [],
    ...overrides,
  }
}

const job: AudioJob = {
  id: 'job-1',
  cache_hit: false,
  status: 'transcribing',
  title: 'Текущий приём',
  record_id: null,
  error: null,
}

function setup(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  for (const response of responses) fetcher.mockResolvedValueOnce(response)
  return { client: createMedHubClient('/api/', { fetcher }), fetcher }
}

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => vi.useRealTimers())

describe('workspace contract', () => {
  it('creates a real backend workspace without a fabricated patient or clinical data', async () => {
    const { client, fetcher } = setup(response(workspace(), 201))
    await expect(client.create()).resolves.toEqual(workspace())
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/workspaces')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
    expect(init?.cache).toBe('no-store')
  })

  it('sends all six normalized fields and the last known revision', async () => {
    const { client, fetcher } = setup(response(workspace({ revision: 5 })))
    const fields = { complaints: '  Слабость  ', allergies: '  ' }
    await client.saveForm(workspace(), fields)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/workspaces/workspace-1/form')
    expect(init?.method).toBe('PATCH')
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json',
    )
    expect(JSON.parse(init?.body as string)).toEqual({
      expected_revision: 4,
      fields: {
        complaints: 'Слабость',
        anamnesis: null,
        allergies: null,
        diagnosis: null,
        prescriptions: null,
        recommendations: null,
      },
    })
    expect(fields).toEqual({ complaints: '  Слабость  ', allergies: '  ' })
  })

  it('preserves record roles and segment identities when correcting a transcript', async () => {
    const { client, fetcher } = setup(response(workspace({ revision: 5 })))
    const input = {
      title: 'История',
      kind: 'history' as const,
      visit_date: '2026-09-01',
      segments: [
        {
          id: 'segment-1',
          role: 'doctor' as const,
          start: 1,
          end: 3,
          text: 'Уточнённая реплика',
        },
      ],
    }
    await client.editRecord(workspace(), 'record/1', input)
    expect(fetcher.mock.calls[0][0]).toBe(
      '/api/workspaces/workspace-1/records/record%2F1',
    )
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({
      ...input,
      expected_revision: 4,
    })
  })

  it('uploads raw audio with encoded metadata and a revision, not multipart or JSON', async () => {
    const { client, fetcher } = setup(response(job, 202))
    const file = new Blob(['audio'], { type: 'audio/webm' })
    await client.uploadAudio(workspace(), file, {
      title: 'Приём & проверка',
      kind: 'current',
      visit_date: '2026-09-30',
    })
    const [url, init] = fetcher.mock.calls[0]
    const query = new URL(String(url), 'http://localhost').searchParams
    expect(query.get('title')).toBe('Приём & проверка')
    expect(query.get('kind')).toBe('current')
    expect(query.get('visit_date')).toBe('2026-09-30')
    expect(query.get('expected_revision')).toBe('4')
    expect(query.get('language')).toBe('ru')
    expect(init?.body).toBe(file)
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/octet-stream',
    )
  })

  it('defaults to local processing without cloud consent', async () => {
    const { client, fetcher } = setup(response(workspace()))
    await client.analyze(workspace(), { focus: 'анемия' })
    expect(fetcher.mock.calls[0][0]).toBe('/api/workspaces/workspace-1/analyze')
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({
      focus: 'анемия',
      engine: 'local_rules',
      allow_cloud_processing: false,
      expected_revision: 4,
    })
  })

  it('passes explicit cloud review authorization only when the caller supplies it', async () => {
    const { client, fetcher } = setup(response(workspace()))
    await client.analyze(workspace(), {
      engine: 'openai',
      allow_cloud_processing: true,
    })
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({
      engine: 'openai',
      allow_cloud_processing: true,
    })
  })

  it('confirms then exports using the server revision and reports a local download', async () => {
    const confirmed = workspace({ confirmed_revision: 4 })
    const document = {
      mode: 'local_download',
      workspace_id: confirmed.id,
      revision: 4,
      fields: confirmed.fields,
      field_sources: [],
      calculation: null,
    }
    const { client, fetcher } = setup(response(confirmed), response(document))
    const saved = await client.confirm(workspace())
    await expect(client.export(saved)).resolves.toEqual(document)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspaces/workspace-1/confirm',
      '/api/workspaces/workspace-1/export',
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(JSON.parse(init?.body as string)).toEqual({ expected_revision: 4 })
    }
  })

  it('handles deleting a session with an empty 204 response', async () => {
    const { client, fetcher } = setup(new Response(null, { status: 204 }))
    await expect(client.remove('workspace-1')).resolves.toBeUndefined()
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE')
  })
})

describe('failures and cancellation', () => {
  it('exposes revision conflicts without retrying a mutation or changing local text', async () => {
    const { client, fetcher } = setup(
      response(
        {
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Сессия изменилась. Обновите данные.',
            details: [],
          },
        },
        409,
      ),
    )
    const local = { complaints: 'Мои несохранённые правки' }
    await expect(client.saveForm(workspace(), local)).rejects.toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
      message: 'Сессия изменилась. Обновите данные.',
    })
    expect(local.complaints).toBe('Мои несохранённые правки')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a connection failure without substituting demo results', async () => {
    const { client, fetcher } = setup()
    fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(client.get('workspace-1')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a non-JSON server error without leaking a proxy response', async () => {
    const { client } = setup(
      new Response('<html>bad gateway</html>', { status: 502 }),
    )
    await expect(client.create()).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_ERROR',
    })
  })

  it('does not accept a successful response containing invalid JSON as a workspace', async () => {
    const { client } = setup(
      new Response('<html>Vite fallback</html>', { status: 200 }),
    )
    await expect(client.create()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('never starts a request when its signal is already cancelled', async () => {
    const { client, fetcher } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.create({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('aborts an in-flight request on timeout and gives an actionable error', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const client = createMedHubClient('/api', { fetcher, timeoutMs: 50 })
    const pending = client.get('workspace-1')
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
})

describe('resumable audio polling', () => {
  it('retrieves the existing job until completion and returns the revised workspace', async () => {
    vi.useFakeTimers()
    const completed = workspace({
      revision: 6,
      jobs: [{ ...job, status: 'completed', record_id: 'record-1' }],
    })
    const { client, fetcher } = setup(
      response(workspace({ jobs: [job] })),
      response(completed),
    )
    const onUpdate = vi.fn()
    const pending = client.pollAudioJob('workspace-1', 'job-1', {
      intervalMs: 10,
      onUpdate,
    })
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toEqual(completed)
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(
      fetcher.mock.calls.every(
        ([url, init]) => url === '/api/workspaces/workspace-1' && !init?.body,
      ),
    ).toBe(true)
  })

  it('surfaces a failed speech job and stops polling', async () => {
    const { client, fetcher } = setup(
      response(
        workspace({
          jobs: [{ ...job, status: 'failed', error: 'WhisperX недоступен.' }],
        }),
      ),
    )
    await expect(
      client.pollAudioJob('workspace-1', 'job-1'),
    ).rejects.toMatchObject({
      code: 'TRANSCRIPTION_FAILED',
      message: 'WhisperX недоступен.',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('allows a timed out poll to resume the same job without uploading again', async () => {
    vi.useFakeTimers()
    const completed = workspace({ jobs: [{ ...job, status: 'completed' }] })
    const { client, fetcher } = setup(
      response(workspace({ jobs: [job] })),
      response(completed),
    )
    const pending = client.pollAudioJob('workspace-1', 'job-1', {
      timeoutMs: 10,
      intervalMs: 50,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'POLL_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    await expect(client.pollAudioJob('workspace-1', 'job-1')).resolves.toEqual(
      completed,
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('cancels waiting between polls without making another request', async () => {
    vi.useFakeTimers()
    const { client, fetcher } = setup(response(workspace({ jobs: [job] })))
    const controller = new AbortController()
    const pending = client.pollAudioJob('workspace-1', 'job-1', {
      signal: controller.signal,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await assertion
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing job rather than waiting indefinitely', async () => {
    const { client } = setup(response(workspace()))
    await expect(
      client.pollAudioJob('workspace-1', 'missing'),
    ).rejects.toBeInstanceOf(ApiError)
    const retry = setup(response(workspace()))
    await expect(
      retry.client.pollAudioJob('workspace-1', 'missing'),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
  })
})
