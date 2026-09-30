import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  FIELD_DEFINITIONS,
  VITAL_DEFINITIONS,
  type PatientMetadata,
  type TemplateValues,
  type TemplateVitals,
} from './visitTemplate'

export type ConsultationDocument = {
  values: TemplateValues
  vitals: TemplateVitals
  metadata: PatientMetadata
}
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
function xmlText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">')
}
/** Fill the retained Word template in-browser; no consultation leaves the browser for export. */
export function createConsultationDocx(
  template: Uint8Array,
  form: ConsultationDocument,
): Uint8Array {
  const entries = unzipSync(template)
  const document = entries['word/document.xml']
  if (!document) throw new Error('Не удалось прочитать шаблон Word.')
  const slots: Record<string, string> = { ...form.metadata, ...form.values }
  const measurements = VITAL_DEFINITIONS.filter((v) =>
    form.vitals[v.id]?.trim(),
  )
    .map((v) => `${v.label}: ${form.vitals[v.id]} ${v.unit}`)
    .join('; ')
  slots.objective_status = [measurements, form.values.objective_status]
    .filter(Boolean)
    .join('\n')
  if (/^\d{4}-\d{2}-\d{2}$/.test(slots.date))
    slots.date = slots.date.split('-').reverse().join('.')
  let xml = strFromU8(document)
  for (const key of [
    ...FIELD_DEFINITIONS.map((f) => f.id),
    'name',
    'iin',
    'date',
    'doctor',
  ]) {
    const token = `{{${key}}}`
    if (!xml.includes(token) && ['name','iin'].includes(key)) continue
    if (!xml.includes(token))
      throw new Error(`В шаблоне отсутствует поле ${key}.`)
    xml = xml.replaceAll(token, () =>
      xmlText(slots[key]?.trim() || 'Не указано'),
    )
  }
  entries['word/document.xml'] = strToU8(xml)
  return zipSync(entries)
}
export async function downloadConsultation(form: ConsultationDocument) {
  const response = await fetch('/templates/therapist.docx')
  if (!response.ok)
    throw new Error('Шаблон Word недоступен. Бланк сохранён на экране.')
  const bytes = createConsultationDocx(
    new Uint8Array(await response.arrayBuffer()),
    form,
  )
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: DOCX_MIME }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = `Консультация-${form.metadata.date || 'приём'}.docx`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
