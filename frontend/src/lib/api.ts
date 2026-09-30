import type { components, operations } from '../../../contracts/api'

export type Workspace = components['schemas']['Workspace'] & { document_fields?: Record<string, string>; document_sources?: Record<string, string[]>; review_notes?: string[] }
export type RecordItem = components['schemas']['Record']
export type Utterance = components['schemas']['Utterance-Output']
export type UtteranceInput = components['schemas']['Utterance-Input']
export type Fields = components['schemas']['ConsultationFields']
export type Evidence = components['schemas']['Evidence']
export type FieldSource = components['schemas']['FieldSource']
export type AudioJob = components['schemas']['AudioJob']
export type CalculationResult = components['schemas']['CalculationResult']
export type CalculationInput = Omit<
  components['schemas']['CalculationInput'],
  'expected_revision'
>
export type RecordInput = Omit<
  components['schemas']['AddRecord'],
  'expected_revision'
>
export type AnalyzeInput = Omit<
  components['schemas']['Analyze'],
  'expected_revision'
>
export type AudioMetadata = Omit<
  operations['audio_api_workspaces__workspace_id__audio_post']['parameters']['query'],
  'expected_revision'
>

// These two endpoints return plain dictionaries in the supplied OpenAPI document.
// Their shapes match backend/app/workspace_api.py (medhub-demo).
export interface Capabilities {
  enabled: boolean
  speech: 'configured_unverified' | 'not_configured'
  engine: 'local_rules' | 'openai'
  cloud_llm: boolean
  storage: 'memory'
  ttl_seconds: number
  max_audio_bytes: number
}

export interface ExportDocument {
  mode: 'local_download'
  workspace_id: string
  revision: number
  fields: Fields
  field_sources: FieldSource[]
  calculation: CalculationResult | null
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (isAbortError(error)) return 'Операция отменена.'
  return 'Не удалось выполнить действие. Попробуйте ещё раз.'
}

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface ClientOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
}

export interface PollOptions extends RequestOptions {
  intervalMs?: number
  onUpdate?: (workspace: Workspace, job: AudioJob) => void
}

type WorkspaceRevision = Pick<Workspace, 'id' | 'revision'>

function abortError() {
  return new DOMException('Операция отменена.', 'AbortError')
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Empty text means unknown; never substitute a clinical assertion for a blank. */
export function normalizeFields(fields: Fields): Fields {
  return {
    complaints: fields.complaints?.trim() || null,
    anamnesis: fields.anamnesis?.trim() || null,
    allergies: fields.allergies?.trim() || null,
    diagnosis: fields.diagnosis?.trim() || null,
    prescriptions: fields.prescriptions?.trim() || null,
    recommendations: fields.recommendations?.trim() || null,
  }
}

/** baseUrl includes /api. Mutations are deliberately never retried automatically. */
export function createMedHubClient(
  baseUrl = '/api',
  options: ClientOptions = {},
) {
  const base = baseUrl.replace(/\/+$/, '')
  const fetcher =
    options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const defaultTimeout = options.timeoutMs ?? 30_000
  const pathFor = (id: string) => `/workspaces/${encodeURIComponent(id)}`
  const revision = (workspace: WorkspaceRevision) => ({
    expected_revision: workspace.revision,
  })

  async function request<T>(
    path: string,
    init: RequestInit = {},
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    if (requestOptions.signal?.aborted) throw abortError()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, requestOptions.timeoutMs ?? defaultTimeout)
    try {
      const headers = new Headers(init.headers)
      if (typeof init.body === 'string')
        headers.set('Content-Type', 'application/json')
      const response = await fetcher(`${base}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
        signal: controller.signal,
      })
      if (response.status === 204 && response.ok) return undefined as T
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const error = (body as components['schemas']['ErrorResponse'] | null)
          ?.error
        throw new ApiError(
          response.status,
          typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
          typeof error?.message === 'string'
            ? error.message
            : `Сервер не выполнил запрос (${response.status}). Попробуйте ещё раз.`,
        )
      }
      if (body === null) {
        throw new ApiError(
          response.status,
          'INVALID_RESPONSE',
          'Сервер вернул неполный ответ. Обновите состояние приёма.',
        )
      }
      return body as T
    } catch (error) {
      if (requestOptions.signal?.aborted) throw abortError()
      if (timedOut) {
        throw new ApiError(
          0,
          'REQUEST_TIMEOUT',
          'Сервер не ответил вовремя. Обновите состояние приёма перед повтором действия.',
        )
      }
      if (error instanceof ApiError || isAbortError(error)) throw error
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Нет связи с сервером. Проверьте подключение и повторите попытку. Ваши правки остаются на экране.',
      )
    } finally {
      clearTimeout(timer)
      requestOptions.signal?.removeEventListener('abort', onAbort)
    }
  }

  const json = <T>(
    path: string,
    method: string,
    body: unknown,
    opts?: RequestOptions,
  ) => request<T>(path, { method, body: JSON.stringify(body) }, opts)
  const get = (id: string, opts?: RequestOptions) =>
    request<Workspace>(pathFor(id), {}, opts)

  return {
    capabilities: (opts?: RequestOptions) =>
      request<Capabilities>('/workspaces/capabilities', {}, opts),
    create: (opts?: RequestOptions) =>
      request<Workspace>('/workspaces', { method: 'POST' }, opts),
    get,
    remove: (id: string, opts?: RequestOptions) =>
      request<void>(pathFor(id), { method: 'DELETE' }, opts),
    example: (workspace: WorkspaceRevision, opts?: RequestOptions) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/example`,
        'POST',
        revision(workspace),
        opts,
      ),
    addRecord: (
      workspace: WorkspaceRevision,
      input: RecordInput,
      opts?: RequestOptions,
    ) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/records`,
        'POST',
        { ...input, ...revision(workspace) },
        opts,
      ),
    editRecord: (
      workspace: WorkspaceRevision,
      recordId: string,
      input: RecordInput,
      opts?: RequestOptions,
    ) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/records/${encodeURIComponent(recordId)}`,
        'PATCH',
        { ...input, ...revision(workspace) },
        opts,
      ),
    deleteRecord: (
      workspace: WorkspaceRevision,
      recordId: string,
      opts?: RequestOptions,
    ) =>
      request<Workspace>(
        `${pathFor(workspace.id)}/records/${encodeURIComponent(recordId)}?expected_revision=${workspace.revision}`,
        { method: 'DELETE' },
        opts,
      ),
    uploadAudio: (
      workspace: WorkspaceRevision,
      file: Blob,
      metadata: AudioMetadata,
      opts?: RequestOptions,
    ) => {
      const query = new URLSearchParams({
        title: metadata.title,
        kind: metadata.kind,
        expected_revision: String(workspace.revision),
        language: metadata.language ?? 'ru',
      })
      if (metadata.visit_date) query.set('visit_date', metadata.visit_date)
      return request<AudioJob>(
        `${pathFor(workspace.id)}/audio?${query}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        },
        { timeoutMs: 120_000, ...opts },
      )
    },
    analyze: (
      workspace: WorkspaceRevision,
      input: Partial<AnalyzeInput> = {},
      opts?: RequestOptions,
    ) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/analyze`,
        'POST',
        {
          focus: '',
          engine: 'local_rules',
          allow_cloud_processing: false,
          ...input,
          ...revision(workspace),
        },
        { timeoutMs: 120_000, ...opts },
      ),
    saveForm: (
      workspace: WorkspaceRevision,
      fields: Fields,
      opts?: RequestOptions,
    ) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/form`,
        'PATCH',
        { ...revision(workspace), fields: normalizeFields(fields) },
        opts,
      ),
    calculate: (
      workspace: WorkspaceRevision,
      input: CalculationInput,
      opts?: RequestOptions,
    ) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/calculate`,
        'POST',
        { ...input, ...revision(workspace) },
        opts,
      ),
    applyCalculation: (workspace: WorkspaceRevision, opts?: RequestOptions) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/calculation/apply`,
        'POST',
        revision(workspace),
        opts,
      ),
    confirm: (workspace: WorkspaceRevision, opts?: RequestOptions) =>
      json<Workspace>(
        `${pathFor(workspace.id)}/confirm`,
        'POST',
        revision(workspace),
        opts,
      ),
    export: (workspace: WorkspaceRevision, opts?: RequestOptions) =>
      json<ExportDocument>(
        `${pathFor(workspace.id)}/export`,
        'POST',
        revision(workspace),
        opts,
      ),
    /** Resume using an existing job ID; this never starts another audio upload. */
    async pollAudioJob(
      workspaceId: string,
      jobId: string,
      opts: PollOptions = {},
    ): Promise<Workspace> {
      const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000)
      const timeoutError = () =>
        new ApiError(
          0,
          'POLL_TIMEOUT',
          'Распознавание ещё не завершено. Можно продолжить ожидание; повторно загружать аудио не нужно.',
        )
      while (true) {
        if (opts.signal?.aborted) throw abortError()
        if (Date.now() >= deadline) throw timeoutError()
        const workspace = await get(workspaceId, {
          signal: opts.signal,
          timeoutMs: Math.min(defaultTimeout, deadline - Date.now()),
        })
        const job = workspace.jobs.find((item) => item.id === jobId)
        if (!job)
          throw new ApiError(
            404,
            'JOB_NOT_FOUND',
            'Задание распознавания не найдено. Обновите состояние приёма.',
          )
        opts.onUpdate?.(workspace, job)
        if (job.status === 'completed') return workspace
        if (job.status === 'failed') {
          throw new ApiError(
            0,
            'TRANSCRIPTION_FAILED',
            job.error ||
              'Не удалось распознать аудио. Проверьте файл и повторите загрузку.',
          )
        }
        if (Date.now() >= deadline) throw timeoutError()
        await pause(
          Math.min(opts.intervalMs ?? 1_500, deadline - Date.now()),
          opts.signal,
        )
      }
    },
  }
}

const env = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env
export const api = createMedHubClient(
  env?.VITE_API_URL || env?.VITE_API_BASE_URL || '/api',
)
