import type { Fields, Workspace } from './api'
import { normalizeFields } from './api'

export const FIELD_LABELS = {
  complaints: 'Жалобы',
  anamnesis: 'Анамнез',
  allergies: 'Аллергии',
  diagnosis: 'Диагноз',
  prescriptions: 'Назначения',
  recommendations: 'Рекомендации',
} as const
export type FieldKey = keyof typeof FIELD_LABELS
export const FIELD_KEYS = Object.keys(FIELD_LABELS) as FieldKey[]
export const EMPTY_FIELDS: Fields = {
  complaints: null,
  anamnesis: null,
  allergies: null,
  diagnosis: null,
  prescriptions: null,
  recommendations: null,
}
export function fieldsEqual(left: Fields, right: Fields): boolean {
  const a = normalizeFields(left),
    b = normalizeFields(right)
  return FIELD_KEYS.every((key) => a[key] === b[key])
}
export function documentText(fields: Fields): string {
  return (
    'ЛИСТ КОНСУЛЬТАЦИИ\n\n' +
    FIELD_KEYS.map(
      (key) => `${FIELD_LABELS[key]}\n${fields[key]?.trim() || 'Не указано'}`,
    ).join('\n\n')
  )
}
export function isConfirmed(
  workspace: Workspace | null,
  fields: Fields,
): boolean {
  return (
    !!workspace &&
    workspace.confirmed_revision === workspace.revision &&
    !workspace.context_stale &&
    fieldsEqual(fields, workspace.fields)
  )
}
export function downloadFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
