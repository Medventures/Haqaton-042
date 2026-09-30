import { describe, expect, it } from 'vitest'
import type { Fields, Workspace } from './api'
import {
  documentText,
  EMPTY_FIELDS,
  fieldsEqual,
  isConfirmed,
} from './workflow'

function reviewedWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    revision: 5,
    confirmed_revision: 5,
    expires_at: '2026-09-30T16:00:00Z',
    records: [],
    jobs: [],
    focus: '',
    fields: { ...EMPTY_FIELDS, complaints: 'Слабость в течение трёх дней' },
    evidence: [],
    field_sources: [],
    previous_recommendations: [],
    generated: true,
    context_stale: false,
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

describe('clinical text comparison', () => {
  it('treats omitted, null and whitespace-only fields as unknown without changing the draft', () => {
    const draft: Fields = { complaints: '  Слабость  ', allergies: ' \n ' }
    const saved: Fields = { ...EMPTY_FIELDS, complaints: 'Слабость' }
    const original = { ...draft }

    expect(fieldsEqual(draft, saved)).toBe(true)
    expect(fieldsEqual({}, EMPTY_FIELDS)).toBe(true)
    expect(draft).toEqual(original)
  })

  it('never treats missing information as a clinical negative assertion', () => {
    expect(
      fieldsEqual({ allergies: null }, { allergies: 'Аллергию отрицает' }),
    ).toBe(false)
    expect(
      fieldsEqual({ diagnosis: null }, { diagnosis: 'Патологии нет' }),
    ).toBe(false)
  })

  it('detects meaningful edits even in optional fields and preserves internal formatting', () => {
    expect(
      fieldsEqual(
        { prescriptions: '5 мг\n1 раз в день' },
        { prescriptions: '50 мг\n1 раз в день' },
      ),
    ).toBe(false)
    expect(
      fieldsEqual(
        { recommendations: 'Контроль\nЧерез неделю' },
        { recommendations: 'Контроль Через неделю' },
      ),
    ).toBe(false)
    expect(fieldsEqual({ allergies: 'Пенициллин' }, {})).toBe(false)
  })
})

describe('text copied into the medical record', () => {
  it('labels every absent clinical value as unknown, including omitted allergies', () => {
    const text = documentText({
      complaints: '  Слабость  ',
      recommendations: ' \n ',
    })

    expect(text).toBe(
      [
        'ЛИСТ КОНСУЛЬТАЦИИ',
        'Жалобы\nСлабость',
        'Анамнез\nНе указано',
        'Аллергии\nНе указано',
        'Диагноз\nНе указано',
        'Назначения\nНе указано',
        'Рекомендации\nНе указано',
      ].join('\n\n'),
    )
    expect(text).not.toMatch(
      /отрицает|отсутствуют|без особенностей|не выявлено/i,
    )
  })

  it('preserves the physician wording, punctuation, measurements and line breaks', () => {
    const fields: Fields = {
      complaints: 'Слабость: 3 дня.',
      allergies: 'Со слов пациента: пенициллин; реакцию уточнить.',
      prescriptions: 'Запись врача: 5 мг.\nСхему уточнить по инструкции.',
      recommendations: 'Повторный приём\nчерез 7–10 дней.',
    }
    const original = structuredClone(fields)
    const text = documentText(fields)

    for (const value of Object.values(fields)) expect(text).toContain(value)
    expect(fields).toEqual(original)
  })
})

describe('server-backed physician confirmation', () => {
  it('accepts the saved confirmed revision with optional sections left unspecified', () => {
    const workspace = reviewedWorkspace()
    expect(
      isConfirmed(workspace, {
        complaints: '  Слабость в течение трёх дней  ',
      }),
    ).toBe(true)
    expect(workspace.fields.allergies).toBeNull()
    expect(workspace.fields.diagnosis).toBeNull()
  })

  it('does not infer confirmation for a missing or unconfirmed session', () => {
    expect(isConfirmed(null, { complaints: 'Слабость' })).toBe(false)
    const workspace = reviewedWorkspace({ confirmed_revision: null })
    expect(isConfirmed(workspace, workspace.fields)).toBe(false)
  })

  it('invalidates completion after a backend revision change or stale source context', () => {
    const changed = reviewedWorkspace({ revision: 6 })
    const stale = reviewedWorkspace({ context_stale: true })
    expect(isConfirmed(changed, changed.fields)).toBe(false)
    expect(isConfirmed(stale, stale.fields)).toBe(false)
  })

  it('requires another confirmation after adding, changing or clearing a clinical value', () => {
    const workspace = reviewedWorkspace({
      fields: {
        ...EMPTY_FIELDS,
        complaints: 'Слабость',
        allergies: 'Пенициллин',
      },
    })

    expect(
      isConfirmed(workspace, {
        ...workspace.fields,
        complaints: 'Слабость и головокружение',
      }),
    ).toBe(false)
    expect(
      isConfirmed(workspace, { ...workspace.fields, allergies: null }),
    ).toBe(false)
    expect(
      isConfirmed(workspace, {
        ...workspace.fields,
        recommendations: 'Повторный приём',
      }),
    ).toBe(false)
    expect(isConfirmed(workspace, workspace.fields)).toBe(true)
  })
})
