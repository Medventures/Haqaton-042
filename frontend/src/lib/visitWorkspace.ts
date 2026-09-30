import type { RecordItem, Workspace } from './api'
import {
  deriveTemplate,
  FIELD_IDS,
  type DerivedTemplate,
  type FieldId,
  type TranscriptSegment,
} from './visitTemplate'
export type HistoryRecord = {
  id: string
  title: string
  date: string | null
  segments: TranscriptSegment[]
  synthetic?: boolean
}

/** Compatibility for the existing API, which requires roles. Ambiguity stays unknown. */
export function annotateConversation(
  segments: readonly TranscriptSegment[],
): TranscriptSegment[] {
  let patientAnswer = false
  return segments.map((segment) => {
    if (segment.role !== 'unknown') {
      patientAnswer = segment.role === 'doctor' && /\?/.test(segment.text)
      return segment
    }
    const text = segment.text.trim()
    let role: TranscriptSegment['role'] = 'unknown'
    if (
      /^(?:у меня|меня беспокоит|беспокоят|я принимаю|я пью|мне назначали|мне поставили|я болею)/i.test(
        text,
      )
    )
      role = 'patient'
    else if (
      /^(?:жалобы\s*[:—]|анамнез|объективн|status praesens|при осмотре|диагноз\s*[:—]|предварительный диагноз|план обследования|лечение\s*[:—]|назначаю|рекомендую|рекомендации\s*[:—]|рост\s*\d|ад\s*\d|чсс\s*\d|температура\s*\d)/i.test(
        text,
      )
    )
      role = 'doctor'
    else if (
      /\?/.test(text) &&
      /жалуетесь|беспокоит|как давно|принимаете|была ли|есть ли у вас|когда нача/i.test(
        text,
      )
    )
      role = 'doctor'
    else if (patientAnswer && !/\?/.test(text)) role = 'patient'
    patientAnswer = role === 'doctor' && /\?/.test(text)
    return { ...segment, role }
  })
}
const COARSE: Record<string, FieldId> = {
  complaints: 'complaints',
  anamnesis: 'illness_history',
  allergies: 'allergies',
  diagnosis: 'diagnosis',
  prescriptions: 'treatment',
  recommendations: 'recommendations',
}
const GROUPS: Record<string, FieldId[]> = {
  complaints: ['complaints'],
  anamnesis: [
    'illness_history',
    'life_history',
    'gynecological_history',
    'anemia_history',
    'epidemiological_history',
    'objective_status',
    'laboratory_results',
  ],
  allergies: ['allergies'],
  diagnosis: ['diagnosis'],
  prescriptions: ['examination_plan', 'treatment'],
  recommendations: ['examination_plan', 'recommendations'],
}
/** Expand source-backed six-field API output into the DOCX layout without dropping sub-sections. */
export function mapWorkspace(
  workspace: Workspace | null,
  segments: TranscriptSegment[],
): DerivedTemplate {
  const base = deriveTemplate(annotateConversation(segments))
  if (!workspace || workspace.engine !== 'openai') return base
  if (workspace.document_fields && Object.keys(workspace.document_fields).length) {
    for (const id of FIELD_IDS) {
      base.values[id] = workspace.document_fields[id] || ''
      base.sources[id] = workspace.document_sources?.[id] || []
    }
    return base
  }
  const current = workspace.records.find((r) => r.kind === 'current')
  if (!current) return base
  const byId = new Map(segments.map((s) => [s.id, s]))
  const additions: Partial<Record<FieldId, string[]>> = {}
  for (const source of workspace.field_sources) {
    if (source.record_id !== current.id || !byId.has(source.segment_id))
      continue
    const segment = byId.get(source.segment_id)!
    if (source.quote !== segment.text) continue
    const specific = (GROUPS[source.field] || []).filter((id) =>
      base.sources[id].includes(segment.id),
    )
    const target = specific.length ? specific : [COARSE[source.field]]
    for (const field of target) {
      if (!field || base.sources[field].includes(segment.id)) continue
      ;(additions[field] ??= []).push(source.quote)
      base.sources[field].push(segment.id)
    }
  }
  for (const field of FIELD_IDS)
    if (additions[field])
      base.values[field] = [base.values[field], ...additions[field]!]
        .filter(Boolean)
        .join('\n')
  return base
}
export function historyFromApi(record: RecordItem): HistoryRecord {
  return {
    id: record.id,
    title: record.title,
    date: record.visit_date ?? null,
    synthetic: record.origin === 'example',
    segments: record.segments.map((s) => ({ ...s, final: true })),
  }
}
export function relatedHistory(
  history: HistoryRecord[],
  segments: TranscriptSegment[],
  workspace: Workspace | null,
) {
  const fromAi = new Set(workspace?.evidence.map((s) => s.segment_id) ?? [])
  const text = segments.map((s) => s.text.toLowerCase()).join(' ')
  const anemia = /анеми|ферритин|желез|гемоглобин|қаназдық/.test(text)
  const terms = text.match(/[а-яёa-zәіңғүұқөһ]{5,}/gi) ?? []
  return history.filter((record) =>
    record.segments.some(
      (s) =>
        fromAi.has(s.id) ||
        (anemia && /анеми|желез|ферритин|гемоглобин/i.test(s.text)) ||
        terms.some((term) => s.text.toLowerCase().includes(term)),
    ),
  )
}
export function previousRecommendations(record: HistoryRecord) {
  return record.segments.filter(
    (s) =>
      s.role === 'doctor' &&
      /рекоменд|назнач|контрол|сдать|принимать/i.test(s.text),
  )
}
export const DEMO_HISTORY: HistoryRecord[] = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    title: 'Консультация терапевта',
    date: '2026-08-12',
    synthetic: true,
    segments: [
      {
        id: '00000000-0000-4000-8000-000000000111',
        role: 'patient',
        start: 0,
        end: 5,
        final: true,
        text: 'Ранее была анемия. После курса лечения самочувствие улучшилось.',
      },
      {
        id: '00000000-0000-4000-8000-000000000112',
        role: 'doctor',
        start: 5,
        end: 10,
        final: true,
        text: 'Рекомендован контроль общего анализа крови и ферритина после курса лечения.',
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    title: 'Результаты обследования',
    date: '2026-08-10',
    synthetic: true,
    segments: [
      {
        id: '00000000-0000-4000-8000-000000000113',
        role: 'doctor',
        start: 0,
        end: 4,
        final: true,
        text: 'Общий анализ крови: гемоглобин 108 г/л. Ферритин 12 нг/мл.',
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    title: 'Консультация при ОРВИ',
    date: '2026-03-04',
    synthetic: true,
    segments: [
      {
        id: '00000000-0000-4000-8000-000000000114',
        role: 'patient',
        start: 0,
        end: 4,
        final: true,
        text: 'Насморк и боль в горле в течение двух дней.',
      },
    ],
  },
]
