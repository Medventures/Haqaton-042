/**
 * Consultation layout transcribed from the two supplied DOCX documents.
 * Their sample findings and prescriptions are never template defaults.
 * The deterministic mapper is a conservative local preview, not a diagnosis
 * engine. It retains spoken wording and references the finalized utterances.
 */
export const FIELD_DEFINITIONS = [
  { id: 'complaints', label: 'Жалобы', hint: 'Что беспокоит пациента' },
  {
    id: 'illness_history',
    label: 'Анамнез заболевания',
    hint: 'Начало, длительность и динамика жалоб',
  },
  {
    id: 'life_history',
    label: 'Анамнез жизни',
    hint: 'Заболевания, операции, препараты, привычки и наследственность',
  },
  {
    id: 'gynecological_history',
    label: 'Гинекологический анамнез',
    hint: 'Менструации, беременности, роды — если обсуждалось',
  },
  {
    id: 'allergies',
    label: 'Аллергологический анамнез',
    hint: 'Аллергии и лекарственная непереносимость',
  },
  {
    id: 'anemia_history',
    label: 'Анамнез при подозрении на анемию',
    hint: 'Предыдущая анемия, лечение, кровопотери и питание',
  },
  {
    id: 'epidemiological_history',
    label: 'Эпидемиологический анамнез',
    hint: 'Контакты, поездки и другие сведения со слов пациента',
  },
  {
    id: 'objective_status',
    label: 'Объективный статус',
    hint: 'Только озвученные врачом результаты осмотра',
  },
  {
    id: 'laboratory_results',
    label: 'Результаты обследования',
    hint: 'Результаты анализов и даты, если озвучены',
  },
  {
    id: 'diagnosis',
    label: 'Диагноз',
    hint: 'Формулировка и степень определённости со слов врача',
  },
  {
    id: 'examination_plan',
    label: 'План обследования',
    hint: 'Исследования и сроки контроля со слов врача',
  },
  {
    id: 'treatment',
    label: 'Лечение',
    hint: 'Только назначения, которые озвучил врач',
  },
  {
    id: 'recommendations',
    label: 'Рекомендации',
    hint: 'Озвученные врачом рекомендации',
  },
] as const

export type FieldId = (typeof FIELD_DEFINITIONS)[number]['id']
export const FIELD_IDS: FieldId[] = FIELD_DEFINITIONS.map(({ id }) => id)
export type TemplateValues = Record<FieldId, string>

export const VITAL_DEFINITIONS = [
  { id: 'height_cm', label: 'Рост', unit: 'см' },
  { id: 'weight_kg', label: 'Вес', unit: 'кг' },
  { id: 'bmi', label: 'ИМТ', unit: 'кг/м²' },
  { id: 'temperature', label: 'Температура', unit: '°C' },
  { id: 'bp', label: 'АД', unit: 'мм рт. ст.' },
  { id: 'pulse', label: 'ЧСС', unit: 'в мин' },
  { id: 'respiratory_rate', label: 'ЧДД', unit: 'в мин' },
  { id: 'spo2', label: 'Сатурация', unit: '%' },
] as const

export type VitalId = (typeof VITAL_DEFINITIONS)[number]['id']
export type TemplateVitals = Record<VitalId, string>
export type PatientMetadata = {
  date: string
  name: string
  iin: string
  doctor: string
}
export type TranscriptSegment = {
  id: string
  text: string
  role: 'doctor' | 'patient' | 'unknown'
  start: number
  end: number
  final: boolean
}
export type DerivedTemplate = {
  values: TemplateValues
  vitals: TemplateVitals
  sources: Record<FieldId, string[]>
  vitalSources: Record<VitalId, string[]>
  /** IDs of finalized assertions which could not be assigned conservatively. */
  unassigned: string[]
}

export function emptyTemplate(): TemplateValues {
  return Object.fromEntries(FIELD_IDS.map((id) => [id, ''])) as TemplateValues
}

export function emptyVitals(): TemplateVitals {
  return Object.fromEntries(
    VITAL_DEFINITIONS.map(({ id }) => [id, '']),
  ) as TemplateVitals
}

const headings: { field: FieldId; pattern: RegExp }[] = [
  { field: 'complaints', pattern: /^(?:жалобы)(?:\s+на)?\s*[:—-]?\s*/i },
  {
    field: 'illness_history',
    pattern: /^(?:анамнез заболевания|[аa]namnesis morbi)\s*[:—-]?\s*/i,
  },
  {
    field: 'life_history',
    pattern: /^(?:анамнез жизни|anamnesis vitae)\s*[:—-]?\s*/i,
  },
  {
    field: 'gynecological_history',
    pattern: /^гинекологический анамнез\s*[:—-]?\s*/i,
  },
  {
    field: 'allergies',
    pattern: /^(?:аллергологический анамнез|аллергии)\s*[:—-]?\s*/i,
  },
  {
    field: 'anemia_history',
    pattern: /^анамнез (?:при подозрении на анемию|анемии)\s*[:—-]?\s*/i,
  },
  {
    field: 'epidemiological_history',
    pattern: /^эпидемиологический анамнез\s*[:—-]?\s*/i,
  },
  {
    field: 'objective_status',
    pattern:
      /^(?:объективный статус|объективно|status praesens(?: objectivus)?)\s*[:—-]?\s*/i,
  },
  {
    field: 'laboratory_results',
    pattern:
      /^(?:результаты обследования|лабораторная диагностика|результаты анализов)\s*[:—-]?\s*/i,
  },
  {
    field: 'diagnosis',
    pattern:
      /^(?:(?:предварительный|основной|заключительный|сопутствующий)\s+)?диагноз\s*[:—-]?\s*/i,
  },
  { field: 'examination_plan', pattern: /^план обследования\s*[:—-]?\s*/i },
  { field: 'treatment', pattern: /^(?:лечение|назначения)\s*[:—-]?\s*/i },
  { field: 'recommendations', pattern: /^рекомендаци[ия]\s*[:—-]?\s*/i },
]

const clinicianOnly = new Set<FieldId>([
  'objective_status',
  'laboratory_results',
  'diagnosis',
  'examination_plan',
  'treatment',
  'recommendations',
])

function questionField(text: string): FieldId | null {
  if (/аллерг|непереносим/i.test(text)) return 'allergies'
  if (
    /месячн|менстру|мензис|беремен|родов|роды|рожали|грудью|лактац/i.test(text)
  )
    return 'gynecological_history'
  if (
    /контакт.*(?:инфекц|больн)|выезд|поездк|страны|территори|эпидемиол|лесу/i.test(
      text,
    )
  )
    return 'epidemiological_history'
  if (
    /анеми|желез|донор|кровотеч|кровоточ|кровь в кале|черн[а-яё]* (?:стул|моч)|диет/i.test(
      text,
    )
  )
    return 'anemia_history'
  if (
    /как давно|сколько (?:дней|недель|месяцев|лет)|когда.*(?:нач|появ)|длительн|динамик|течени/i.test(
      text,
    )
  )
    return 'illness_history'
  if (
    /препарат|лекарств|принимаете|принимали|операци|травм|болели|заболевани|наследств|курите|алкогол|работаете/i.test(
      text,
    )
  )
    return 'life_history'
  if (/беспокоит|жалоб|жалует|болит|самочувств/i.test(text)) return 'complaints'
  return null
}

function isQuestion(text: string): boolean {
  // A provisional diagnosis can contain a question mark as clinical uncertainty.
  if (
    /^(?:предварительный|основной|заключительный|сопутствующий)?\s*диагноз\s*[:—-]/i.test(
      text,
    )
  )
    return false
  return (
    /\?/.test(text) ||
    /^(?:а\s+)?(?:есть ли|был[аио]? ли|бывают ли|были ли|какие|какой|какая|какое|сколько|когда|как давно|на что|что вас|что принимаете|чем лечил|расскажите|скажите|уточните|принимаете ли|принимали ли|не являетесь ли|не было ли|соблюдаете ли|замечали ли)/i.test(
      text,
    )
  )
}

function splitSections(text: string): string[] {
  // Split at named sections, not decimal points or abbreviations in medication doses.
  const pattern =
    /(?:Жалобы|Анамнез заболевания|Анамнез жизни|Гинекологический анамнез|Аллергологический анамнез|Аллергии|Анамнез при подозрении на анемию|Анамнез анемии|Эпидемиологический анамнез|Объективный статус|Объективно|Результаты обследования|Результаты анализов|Лабораторная диагностика|(?:(?:Предварительный|Основной|Заключительный|Сопутствующий)\s+)?Диагноз|План обследования|Лечение|Назначения|Рекомендации)\s*:/gi
  const positions = [...text.matchAll(pattern)].map((match) => match.index)
  const starts = [...new Set([0, ...positions])]
  return starts
    .map((start, index) => text.slice(start, starts[index + 1]).trim())
    .filter(Boolean)
}

function inferField(
  text: string,
  role: 'doctor' | 'patient',
  context: FieldId | null,
): FieldId | null {
  if (/аллерг|непереносим/i.test(text)) return 'allergies'
  if (
    /месячн|менстру|мензис|беремен|родов|роды|рожала|грудью|лактац/i.test(text)
  )
    return 'gynecological_history'
  if (
    /контакт.*(?:инфекц|больн)|эпидемиол|выезжал|выезжала|пребывал.*лес/i.test(
      text,
    )
  )
    return 'epidemiological_history'

  if (role === 'doctor') {
    if (
      /^(?:предварительный\s+|основной\s+)?диагноз|^(?:ставлю|выставлен|установлен|устанавливаю) диагноз/i.test(
        text,
      )
    )
      return 'diagnosis'
    if (
      /(?:сдать|сдайте|назначаю|назначить|рекомендую|проверим|контроль|направляю).*(?:анализ|ферритин|оак|обследован|гематолог)|(?:оак|анализ).*(?:контроль|через)/i.test(
        text,
      )
    )
      return 'examination_plan'
    if (
      /^(?:назначаю|назначить|принимайте|начните принимать|продолжить приём|продолжить прием|рекомендую принимать|рекомендую начать приём|рекомендую начать прием|лечение)(?:\s|:)/i.test(
        text,
      )
    )
      return 'treatment'
    if (
      /^(?:рекомендую|рекомендаци|сбалансированное|соблюдайте|режим труда|прогулки)/i.test(
        text,
      )
    )
      return 'recommendations'
    if (
      /(?:гемоглобин|ферритин|эритроцит[а-яё]*|\bhb\b|\bmcv\b|\bmch\b|\brdw\b)\s*(?:[:—=-]|составляет|равен)?\s*\d|(?:результаты анализов|анализ.*показал)/i.test(
        text,
      )
    )
      return 'laboratory_results'
    if (
      /при осмотре|кожн[а-яё]* покров|кожа.*(?:бледн|сух)|бледн.*кож|сознание (?:ясное|наруш)|(?:общее )?состояние (?:удовлетвор|тяж|средней)|дыхание (?:везикул|жестк|жёстк)|тоны сердца|живот (?:мягк|безболез|болез)|лимфатические узлы/i.test(
        text,
      )
    )
      return 'objective_status'
  }

  if (
    /(?:раньше|ранее|была|был|лечил|проходил|проводилось)[^.!?]*(?:анеми|желез)|(?:анеми|желез)[^.!?]*(?:раньше|ранее|лечил|проходил|проводилось)|кровотеч|кровоточ|донор/i.test(
      text,
    )
  )
    return 'anemia_history'
  const reportsMedicationIntake =
    /принимаю|принимает|принимал[аи]?|(?:^|\s)пью(?:\s|$)|(?:^|\s)пила(?:\s|$)/i.test(
      text,
    )
  const mentionsMedication = /таблетк|ампул|лекарств|препарат/i.test(text)
  if (
    reportsMedicationIntake ||
    (role === 'patient' && mentionsMedication) ||
    /операци|травм|наследствен|гепатит|туберкул|болезнь боткина|венерическ|курю|не курит|алкогол/i.test(
      text,
    )
  )
    return 'life_history'
  if (
    /начал[а-яё]*\s+(?:\d|недел|месяц|давно)|(?:жалоб[а-яё]*|беспоко[а-яё]*|болею|болит)[^.!?]*(?:в течение|в течении|\sуже\s|длительн)|(?:появил[а-яё]*|начал[а-яё]*).*назад/i.test(
      text,
    )
  )
    return 'illness_history'
  if (role === 'patient' && context) return context
  if (
    /слабост|утомля|головокруж|болит|жалоб|беспоко|одыш|сердцеби|выпадение волос|выпадают волосы|ломкость ногтей|сонлив|аппетит|раздражит/i.test(
      text,
    )
  )
    return 'complaints'
  return null
}

const vitalPatterns: { id: VitalId; pattern: RegExp }[] = [
  {
    id: 'height_cm',
    pattern: /(?:^|[^а-яё])рост\s*[:—-]?\s*(\d{2,3}(?:[.,]\d+)?)/iu,
  },
  {
    id: 'weight_kg',
    pattern: /(?:вес|масса тела)\s*[:—-]?\s*(\d{1,3}(?:[.,]\d+)?)/iu,
  },
  {
    id: 'bmi',
    pattern: /(?:имт|индекс массы тела)\s*[:—-]?\s*(\d{1,2}(?:[.,]\d+)?)/iu,
  },
  {
    id: 'temperature',
    pattern: /температура\s*[:—-]?\s*(\d{2}(?:[.,]\d+)?)/iu,
  },
  {
    id: 'bp',
    pattern:
      /(?:ад|артериальное давление|давление)\s*[:—-]?\s*(\d{2,3}\s*(?:\/|на)\s*\d{2,3})/iu,
  },
  { id: 'pulse', pattern: /(?:чсс|пульс)\s*[:—-]?\s*(\d{1,3})/iu },
  {
    id: 'respiratory_rate',
    pattern: /(?:чдд|частота дыхани[яй])\s*[:—-]?\s*(\d{1,2})/iu,
  },
  {
    id: 'spo2',
    pattern: /(?:сатурация|spo2|spo₂)\s*[:—-]?\s*(\d{2,3}(?:[.,]\d+)?)/iu,
  },
]

/** Derives a fresh suggestion each time; manual edits must be merged by the caller. */
export function deriveTemplate(
  segments: readonly TranscriptSegment[],
): DerivedTemplate {
  const values = emptyTemplate()
  const vitals = emptyVitals()
  const sources = Object.fromEntries(
    FIELD_IDS.map((id) => [id, [] as string[]]),
  ) as Record<FieldId, string[]>
  const vitalSources = Object.fromEntries(
    VITAL_DEFINITIONS.map(({ id }) => [id, [] as string[]]),
  ) as Record<VitalId, string[]>
  const unassigned: string[] = []
  let context: FieldId | null = null
  let doctorSection: FieldId | null = null
  let diagnosisQualifier: { text: string; source: string } | null = null
  let previousRole: TranscriptSegment['role'] | null = null

  for (const segment of segments) {
    if (!segment.final || !segment.text.trim()) continue
    if (segment.role !== previousRole) {
      doctorSection = null
      diagnosisQualifier = null
    }
    previousRole = segment.role
    if (segment.role === 'unknown') {
      unassigned.push(segment.id)
      context = null
      doctorSection = null
      diagnosisQualifier = null
      continue
    }

    let assigned = false
    let hasAssertion = false
    for (const text of splitSections(segment.text)) {
      if (isQuestion(text)) {
        doctorSection = null
        diagnosisQualifier = null
        context = segment.role === 'doctor' ? questionField(text) : null
        continue
      }
      const heading = headings.find(({ pattern }) => pattern.test(text))
      const body = heading ? text.replace(heading.pattern, '').trim() : text
      hasAssertion ||= Boolean(body)
      let field = heading?.field ?? inferField(text, segment.role, context)
      if (segment.role === 'doctor') {
        if (heading) {
          doctorSection = heading.field
          const qualifier =
            heading.field === 'diagnosis'
              ? text.match(
                  /^((?:предварительный|основной|заключительный|сопутствующий)\s+диагноз)(?=\s|:|$|—|-)/i,
                )
              : null
          diagnosisQualifier = qualifier
            ? { text: `${qualifier[1]}:`, source: segment.id }
            : null
        } else if (field && field !== doctorSection) doctorSection = null
        else if (
          !field &&
          vitalPatterns.some(({ pattern }) => pattern.test(text)) &&
          doctorSection !== 'objective_status'
        )
          doctorSection = null
        if (!doctorSection) diagnosisQualifier = null
        if (!field) field = doctorSection
      }
      if (field && clinicianOnly.has(field) && segment.role !== 'doctor') {
        field =
          field === 'treatment' && /принимаю|принимал|пью|пила/i.test(text)
            ? 'life_history'
            : null
      }
      if (field) {
        // Retain provisional diagnosis qualifiers and every spoken dose verbatim.
        let content = body && field === 'diagnosis' ? text : body
        const continuesQualifiedDiagnosis =
          content &&
          field === 'diagnosis' &&
          !heading &&
          !values.diagnosis &&
          diagnosisQualifier
        if (continuesQualifiedDiagnosis)
          content = `${continuesQualifiedDiagnosis.text} ${content}`
        if (content && !values[field].split('\n').includes(content)) {
          values[field] = values[field]
            ? `${values[field]}\n${content}`
            : content
        }
        if (content) {
          if (
            continuesQualifiedDiagnosis &&
            !sources[field].includes(continuesQualifiedDiagnosis.source)
          )
            sources[field].push(continuesQualifiedDiagnosis.source)
          if (!sources[field].includes(segment.id))
            sources[field].push(segment.id)
          assigned = true
        }
      }
      if (segment.role === 'doctor') {
        const currentMeasurement =
          !/целев|раньше|ранее|прошл|если|например|нужно измерить|измерим|проверим|предполож/i.test(
            text,
          )
        for (const { id, pattern } of vitalPatterns) {
          if (!currentMeasurement) continue
          const match = text.match(pattern)
          if (!match) continue
          // Conflicting measurements remain visible, rather than silently picking one.
          if (!vitalSources[id].length) vitals[id] = match[1]
          else if (!vitals[id].split(' / ').includes(match[1]))
            vitals[id] += ` / ${match[1]}`
          if (!vitalSources[id].includes(segment.id))
            vitalSources[id].push(segment.id)
          assigned = true
        }
        context = null
      }
    }
    if (!assigned && hasAssertion) unassigned.push(segment.id)
  }
  return { values, vitals, sources, vitalSources, unassigned }
}

export function formatTemplate(form: {
  values: TemplateValues
  vitals: TemplateVitals
  metadata: PatientMetadata
}): string {
  const present = (value: string) => value.trim() || 'Не указано'
  const result = [
    'ОСМОТР ТЕРАПЕВТА / ВОП НА ПРИЁМЕ',
    `Дата: ${present(form.metadata.date)}\nФИО: ${present(form.metadata.name)}\nИИН: ${present(form.metadata.iin)}`,
  ]
  for (const field of FIELD_DEFINITIONS) {
    if (field.id === 'objective_status') {
      result.push(
        'Показатели\n' +
          VITAL_DEFINITIONS.map(
            ({ id, label, unit }) =>
              `${label}: ${form.vitals[id].trim() ? `${form.vitals[id].trim()} ${unit}` : 'Не указано'}`,
          ).join('\n'),
      )
    }
    result.push(`${field.label}\n${present(form.values[field.id])}`)
  }
  result.push(`Врач: ${present(form.metadata.doctor)}`)
  return result.join('\n\n')
}

/** Optional conversation prompts from the template. Never patient findings. */
export const ANEMIA_QUESTIONS = [
  'Была ли анемия раньше?',
  'Проводилось ли лечение препаратами железа?',
  'Был ли эффект от терапии?',
  'Ели или хотели есть в детстве или во время беременности землю, глину, песок, уголь, мел?',
  'Было ли в детстве ночное недержание мочи (у девочки)?',
  'Есть ли анемия у Вашей матери?',
  'Если есть, то какая?',
  'Каким по счёту ребёнком у своей матери Вы родились?',
  'Если не первым, то какая разница в возрасте между Вами и старшими братьями или сёстрами?',
  'Сколько дней продолжаются месячные?',
  'Какова интенсивность месячных: сколько прокладок и тампонов нужно сменить за день, нужно ли менять их ночью, есть ли сгустки?',
  'Какой интервал между месячными?',
  'Сколько было родов?',
  'Какой был интервал между родами?',
  'Было ли грудное вскармливание и как долго?',
  'Есть ли кровоточивость дёсен при откусывании пищи или чистке зубов? Как часто?',
  'Бывают ли носовые кровотечения? Как часто и сколько лет?',
  'Было ли кровохарканье?',
  'Не являетесь ли Вы донором?',
  'Бывала ли рвота кофейной гущей или чёрный стул?',
  'Замечали ли кровь в кале?',
  'Бывает ли кровавая или чёрная моча?',
  'Принимали ли Вы аспирин или другие нестероидные противовоспалительные препараты?',
  'Соблюдаете ли Вы какую-либо диету?',
] as const

/** Synthetic demonstration adapted from the filled example; no treatment is preselected. */
export const DEMO_SEGMENTS: readonly TranscriptSegment[] = [
  {
    id: 'demo-1',
    role: 'doctor',
    text: 'На что жалуетесь?',
    start: 0,
    end: 2,
    final: true,
  },
  {
    id: 'demo-2',
    role: 'patient',
    text: 'Беспокоят слабость, повышенная утомляемость, головокружение и выпадение волос.',
    start: 2,
    end: 8,
    final: true,
  },
  {
    id: 'demo-3',
    role: 'doctor',
    text: 'Как давно появились эти жалобы?',
    start: 8,
    end: 11,
    final: true,
  },
  {
    id: 'demo-4',
    role: 'patient',
    text: 'Эти жалобы беспокоят уже длительное время.',
    start: 11,
    end: 15,
    final: true,
  },
  {
    id: 'demo-5',
    role: 'doctor',
    text: 'Была ли анемия раньше? Проходили ли лечение?',
    start: 15,
    end: 19,
    final: true,
  },
  {
    id: 'demo-6',
    role: 'patient',
    text: 'Ранее была анемия, прошла курс лечения, но контрольные анализы не сдавала.',
    start: 19,
    end: 26,
    final: true,
  },
  {
    id: 'demo-7',
    role: 'doctor',
    text: 'Рост 167 см, вес 66 кг, температура 36,6. АД 120/80, ЧСС 64, ЧДД 18, сатурация 98%.',
    start: 26,
    end: 34,
    final: true,
  },
  {
    id: 'demo-8',
    role: 'doctor',
    text: 'При осмотре кожные покровы бледные.',
    start: 34,
    end: 38,
    final: true,
  },
  {
    id: 'demo-9',
    role: 'doctor',
    text: 'Предварительный диагноз: D64.9 — анемия неуточнённая. ЖДА под вопросом.',
    start: 38,
    end: 45,
    final: true,
  },
  {
    id: 'demo-10',
    role: 'doctor',
    text: 'План обследования: ферритин, фолиевая кислота, витамин B12, ОАК контроль через месяц.',
    start: 45,
    end: 52,
    final: true,
  },
  {
    id: 'demo-11',
    role: 'doctor',
    text: 'Рекомендации: сбалансированное питание, режим труда и отдыха.',
    start: 52,
    end: 57,
    final: true,
  },
]
