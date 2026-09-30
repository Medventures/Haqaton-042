import { describe, expect, it } from 'vitest'
import {
  ANEMIA_QUESTIONS,
  DEMO_SEGMENTS,
  FIELD_IDS,
  deriveTemplate,
  emptyTemplate,
  emptyVitals,
  formatTemplate,
  type TranscriptSegment,
} from './visitTemplate'

function utterance(
  text: string,
  role: TranscriptSegment['role'] = 'doctor',
  id = 's1',
  final = true,
): TranscriptSegment {
  return { id, text, role, start: 0, end: 4, final }
}

describe('consultation template without clinical defaults', () => {
  it('starts with every field and vital empty', () => {
    const result = deriveTemplate([])
    expect(result.values).toEqual(emptyTemplate())
    expect(result.vitals).toEqual(emptyVitals())
    expect(FIELD_IDS).toHaveLength(13)
    expect(Object.values(result.values).every((value) => value === '')).toBe(
      true,
    )
    expect(result.sources.allergies).toEqual([])
  })

  it('does not copy diseases, normal findings or medication from the supplied template', () => {
    const result = deriveTemplate([utterance('Беспокоит слабость.', 'patient')])
    expect(result.values.complaints).toBe('Беспокоит слабость.')
    expect(result.values.diagnosis).toBe('')
    expect(result.values.objective_status).toBe('')
    expect(result.values.allergies).toBe('')
    expect(result.values.treatment).toBe('')
  })

  it('ignores provisional streaming tokens until an utterance is finalized', () => {
    const result = deriveTemplate([
      utterance('Аллергии нет.', 'patient', 'partial', false),
    ])
    expect(result.values).toEqual(emptyTemplate())
    expect(result.unassigned).toEqual([])
  })

  it('leaves unknown speakers unassigned, including objective findings and prescriptions', () => {
    const result = deriveTemplate([
      utterance('Диагноз: анемия. Лечение: сорбифер 100 мг.', 'unknown'),
    ])
    expect(result.values).toEqual(emptyTemplate())
    expect(result.unassigned).toEqual(['s1'])
  })
})

describe('questions and their answers', () => {
  it('never treats a doctor question as a patient finding', () => {
    const result = deriveTemplate([
      utterance('Есть ли аллергия на пенициллин?', 'doctor', 'q1'),
      utterance('Были ли операции?', 'doctor', 'q2'),
      utterance('Была ли анемия раньше?', 'doctor', 'q3'),
      utterance('Как давно беспокоит слабость?', 'doctor', 'q4'),
    ])
    expect(result.values).toEqual(emptyTemplate())
    expect(result.unassigned).toEqual([])
  })

  it('records a negative allergy history only when the patient explicitly answers', () => {
    const result = deriveTemplate([
      utterance('Есть ли аллергия на лекарства?', 'doctor', 'q1'),
      utterance('Нет.', 'patient', 'a1'),
    ])
    expect(result.values.allergies).toBe('Нет.')
    expect(result.sources.allergies).toEqual(['a1'])
    expect(result.values.life_history).toBe('')
  })

  it('routes the duration answer to illness history without turning a question into a source', () => {
    const result = deriveTemplate([
      utterance('Как давно появились жалобы?', 'doctor', 'q'),
      utterance('Около двух месяцев.', 'patient', 'a'),
    ])
    expect(result.values.illness_history).toBe('Около двух месяцев.')
    expect(result.sources.illness_history).toEqual(['a'])
  })

  it('routes menstrual answers to their own history section', () => {
    const result = deriveTemplate([
      utterance('Сколько дней продолжаются месячные?', 'doctor', 'q'),
      utterance('Обычно пять дней.', 'patient', 'a'),
    ])
    expect(result.values.gynecological_history).toBe('Обычно пять дней.')
  })

  it('does not infer the answer to an unrelated or unrecognized question', () => {
    const result = deriveTemplate([
      utterance('Есть ли аллергии?', 'doctor', 'q'),
      utterance('Вы меня слышите?', 'doctor', 'other'),
      utterance('Да.', 'patient', 'a'),
    ])
    expect(result.values.allergies).toBe('')
    expect(result.unassigned).toContain('a')
  })

  it('does not interpret patient questions as complaints or treatment', () => {
    const result = deriveTemplate([
      utterance('Можно принимать железо при аллергии?', 'patient'),
    ])
    expect(result.values).toEqual(emptyTemplate())
  })
})

describe('clinical assertion attribution', () => {
  it('keeps patient medication intake in history, with the exact dose', () => {
    const result = deriveTemplate([
      utterance('Принимаю сорбифер по 1 таблетке утром.', 'patient'),
    ])
    expect(result.values.life_history).toBe(
      'Принимаю сорбифер по 1 таблетке утром.',
    )
    expect(result.values.treatment).toBe('')
  })

  it('does not turn a patient treatment heading into a new prescription', () => {
    const result = deriveTemplate([
      utterance('Лечение: принимаю препарат X 5 мг.', 'patient'),
    ])
    expect(result.values.life_history).toBe('принимаю препарат X 5 мг.')
    expect(result.values.treatment).toBe('')
  })

  it('keeps a doctor prescription unchanged and does not invent additional instructions', () => {
    const words = 'Назначаю витамин B12 по 1 ампуле 1 раз в день.'
    const result = deriveTemplate([utterance(words)])
    expect(result.values.treatment).toBe(words)
    expect(result.values.examination_plan).toBe('')
    expect(result.sources.treatment).toEqual(['s1'])
  })

  it('requires a doctor for diagnosis, objective findings, labs and vital values', () => {
    const result = deriveTemplate([
      utterance('Диагноз: анемия.', 'patient', '1'),
      utterance('Объективно: кожа бледная.', 'patient', '2'),
      utterance('Результаты обследования: гемоглобин 110 г/л.', 'patient', '3'),
      utterance('Рост 167 см, вес 66 кг.', 'patient', '4'),
    ])
    expect(result.values.diagnosis).toBe('')
    expect(result.values.objective_status).toBe('')
    expect(result.values.laboratory_results).toBe('')
    expect(result.vitals).toEqual(emptyVitals())
  })

  it('retains provisional diagnosis uncertainty rather than asserting a confirmed diagnosis', () => {
    const text = 'Предварительный диагноз: D64.9 — анемия неуточнённая. ЖДА?'
    const result = deriveTemplate([utterance(text)])
    expect(result.values.diagnosis).toBe(text)
  })

  it('routes a multi-section dictated utterance into the matching fields with the same source ID', () => {
    const result = deriveTemplate([
      utterance(
        'Жалобы: слабость. Анамнез заболевания: два месяца. Объективно: кожные покровы бледные. Предварительный диагноз: анемия неуточнённая. План обследования: ферритин. Рекомендации: режим труда и отдыха.',
      ),
    ])
    expect(result.values.complaints).toBe('слабость.')
    expect(result.values.illness_history).toBe('два месяца.')
    expect(result.values.objective_status).toBe('кожные покровы бледные.')
    expect(result.values.diagnosis).toBe(
      'Предварительный диагноз: анемия неуточнённая.',
    )
    expect(result.values.examination_plan).toBe('ферритин.')
    expect(result.values.recommendations).toBe('режим труда и отдыха.')
    expect(result.sources.diagnosis).toEqual(['s1'])
    expect(result.sources.complaints).toEqual(['s1'])
  })

  it('keeps multiline treatment doses intact instead of splitting on numbers and abbreviations', () => {
    const result = deriveTemplate([
      utterance(
        'Лечение:\nПрепарат X 2,5 мг.\nПо 1 табл. утром. Рекомендации: повторный приём.',
      ),
    ])
    expect(result.values.treatment).toBe(
      'Препарат X 2,5 мг.\nПо 1 табл. утром.',
    )
    expect(result.values.recommendations).toBe('повторный приём.')
  })

  it('keeps earlier anemia separate from the current diagnosis', () => {
    const result = deriveTemplate([
      utterance(
        'Ранее была анемия, прошла лечение, контрольные анализы не сдавала.',
        'patient',
      ),
    ])
    expect(result.values.anemia_history).toContain('Ранее была анемия')
    expect(result.values.diagnosis).toBe('')
  })

  it('deduplicates identical finalized text but preserves every supporting utterance ID', () => {
    const result = deriveTemplate([
      utterance('Жалобы: слабость.', 'doctor', '1'),
      utterance('Жалобы: слабость.', 'doctor', '2'),
    ])
    expect(result.values.complaints).toBe('слабость.')
    expect(result.sources.complaints).toEqual(['1', '2'])
  })
})

describe('section context across doctor audio chunks', () => {
  it('carries a standalone examination heading into subsequent doctor chunks', () => {
    const result = deriveTemplate([
      utterance('План обследования:', 'doctor', 'heading'),
      utterance('Ферритин, витамин B12 и фолиевая кислота.', 'doctor', 'list'),
      utterance('Контроль через месяц.', 'doctor', 'timing'),
    ])
    expect(result.values.examination_plan).toBe(
      'Ферритин, витамин B12 и фолиевая кислота.\nКонтроль через месяц.',
    )
    expect(result.sources.examination_plan).toEqual(['list', 'timing'])
    expect(result.values.laboratory_results).toBe('')
    expect(result.unassigned).toEqual([])
  })

  it('does not mistake the 12 in vitamin B12 for a ferritin result', () => {
    const result = deriveTemplate([
      utterance('Ферритин, витамин B12 и фолиевая кислота.'),
    ])
    expect(result.values.laboratory_results).toBe('')
    expect(result.unassigned).toEqual(['s1'])
    expect(
      deriveTemplate([utterance('Ферритин: 12 нг/мл.')]).values
        .laboratory_results,
    ).toBe('Ферритин: 12 нг/мл.')
  })

  it('attributes treatment continuation only to an explicitly opened doctor section', () => {
    const result = deriveTemplate([
      utterance('Лечение:', 'doctor', 'heading'),
      utterance('Препарат железа X 2,5 мг.', 'doctor', 'drug'),
      utterance('По 1 таблетке утром.', 'doctor', 'dose'),
    ])
    expect(result.values.treatment).toBe(
      'Препарат железа X 2,5 мг.\nПо 1 таблетке утром.',
    )
    expect(result.sources.treatment).toEqual(['drug', 'dose'])
    expect(result.values.life_history).toBe('')
    expect(
      deriveTemplate([utterance('По 1 таблетке утром.')]).values.treatment,
    ).toBe('')
  })

  it('switches sections when a new explicit heading arrives', () => {
    const result = deriveTemplate([
      utterance('План обследования:', 'doctor', '1'),
      utterance('Ферритин.', 'doctor', '2'),
      utterance('Рекомендации:', 'doctor', '3'),
      utterance('Повторный приём через неделю.', 'doctor', '4'),
    ])
    expect(result.values.examination_plan).toBe('Ферритин.')
    expect(result.values.recommendations).toBe('Повторный приём через неделю.')
    expect(result.sources.recommendations).toEqual(['4'])
  })

  it('breaks section context on a clearly different inferred field', () => {
    const result = deriveTemplate([
      utterance('Лечение:', 'doctor', '1'),
      utterance('При осмотре кожа бледная.', 'doctor', '2'),
      utterance('По 1 таблетке утром.', 'doctor', '3'),
    ])
    expect(result.values.objective_status).toBe('При осмотре кожа бледная.')
    expect(result.values.treatment).toBe('')
    expect(result.unassigned).toContain('3')
  })

  it('breaks on unknown speakers without carrying treatment context over them', () => {
    const result = deriveTemplate([
      utterance('Лечение:', 'doctor', '1'),
      utterance('Продолжайте.', 'unknown', '2'),
      utterance('По 1 таблетке утром.', 'doctor', '3'),
    ])
    expect(result.values.treatment).toBe('')
    expect(result.unassigned).toEqual(['2', '3'])
  })

  it('breaks on a patient reply and never promotes patient medication intake to orders', () => {
    const result = deriveTemplate([
      utterance('Лечение:', 'doctor', '1'),
      utterance('Принимаю препарат X 5 мг.', 'patient', '2'),
      utterance('По 1 таблетке утром.', 'doctor', '3'),
    ])
    expect(result.values.treatment).toBe('')
    expect(result.values.life_history).toBe('Принимаю препарат X 5 мг.')
    expect(result.unassigned).toContain('3')
  })

  it('breaks on a question and keeps its answer in the relevant history section', () => {
    const result = deriveTemplate([
      utterance('Лечение:', 'doctor', '1'),
      utterance('Есть ли аллергии?', 'doctor', '2'),
      utterance('Нет.', 'patient', '3'),
      utterance('По 1 таблетке утром.', 'doctor', '4'),
    ])
    expect(result.values.treatment).toBe('')
    expect(result.values.allergies).toBe('Нет.')
    expect(result.sources.allergies).toEqual(['3'])
  })

  it('does not populate a diagnosis from its heading without a spoken diagnosis', () => {
    const result = deriveTemplate([utterance('Предварительный диагноз:')])
    expect(result.values.diagnosis).toBe('')
    expect(result.sources.diagnosis).toEqual([])
    expect(result.unassigned).toEqual([])
  })

  it('retains a provisional diagnosis qualifier spoken in the preceding chunk', () => {
    const result = deriveTemplate([
      utterance('Предварительный диагноз:', 'doctor', 'heading'),
      utterance('D64.9 — анемия неуточнённая.', 'doctor', 'value'),
    ])
    expect(result.values.diagnosis).toBe(
      'Предварительный диагноз: D64.9 — анемия неуточнённая.',
    )
    expect(result.sources.diagnosis).toEqual(['heading', 'value'])
  })

  it('does not copy newly measured vitals into an earlier treatment section', () => {
    const result = deriveTemplate([
      utterance('Лечение:', 'doctor', '1'),
      utterance('Температура 36,6.', 'doctor', '2'),
      utterance('По 1 таблетке утром.', 'doctor', '3'),
    ])
    expect(result.values.treatment).toBe('')
    expect(result.vitals.temperature).toBe('36,6')
    expect(result.unassigned).toContain('3')
  })
})

describe('source questionnaire', () => {
  it('preserves the clinically distinct source prompts without generating patient facts', () => {
    const prompts = ANEMIA_QUESTIONS.join('\n')
    expect(prompts).toContain('ночное недержание мочи')
    expect(prompts).toContain('Каким по счёту ребёнком')
    expect(prompts).toContain('старшими братьями или сёстрами')
    expect(prompts).toContain('кофейной гущей')
    expect(prompts).toContain('кровохарканье')
    expect(prompts).toContain('землю, глину, песок, уголь, мел')
    expect(prompts).toContain('менять их ночью, есть ли сгустки')
    expect(
      deriveTemplate(
        ANEMIA_QUESTIONS.map((text, index) =>
          utterance(text, 'doctor', String(index)),
        ),
      ).values,
    ).toEqual(emptyTemplate())
  })
})

describe('measurements', () => {
  it('extracts only spoken values and leaves unspoken BMI empty', () => {
    const result = deriveTemplate([
      utterance(
        'Рост 167 см, вес 66 кг, температура 36,6. АД 120/80, ЧСС 64, ЧДД 18, сатурация 98%.',
      ),
    ])
    expect(result.vitals).toEqual({
      height_cm: '167',
      weight_kg: '66',
      bmi: '',
      temperature: '36,6',
      bp: '120/80',
      pulse: '64',
      respiratory_rate: '18',
      spo2: '98',
    })
    expect(result.vitalSources.height_cm).toEqual(['s1'])
    expect(result.unassigned).toEqual([])
  })

  it('does not extract a target or hypothetical pressure as a measured vital', () => {
    const result = deriveTemplate([
      utterance('Целевое давление 120/80.'),
      utterance('Если температура 38,5, позвоните.', 'doctor', '2'),
    ])
    expect(result.vitals).toEqual(emptyVitals())
  })

  it('does not silently overwrite conflicting measurements', () => {
    const result = deriveTemplate([
      utterance('Вес 66 кг.', 'doctor', '1'),
      utterance('Вес 68 кг.', 'doctor', '2'),
    ])
    expect(result.vitals.weight_kg).toBe('66 / 68')
    expect(result.vitalSources.weight_kg).toEqual(['1', '2'])
  })
})

describe('example and export', () => {
  it('fills the synthetic demo incrementally without adding allergies, family history or a drug regimen', () => {
    const first = deriveTemplate(DEMO_SEGMENTS.slice(0, 2))
    expect(first.values.complaints).toContain('слабость')
    expect(first.values.diagnosis).toBe('')
    const result = deriveTemplate(DEMO_SEGMENTS)
    expect(result.values.diagnosis).toContain('D64.9')
    expect(result.vitals.height_cm).toBe('167')
    expect(result.values.allergies).toBe('')
    expect(result.values.life_history).toBe('')
    expect(result.values.treatment).toBe('')
  })

  it('exports all sections and manually supplied patient metadata without invented negatives', () => {
    const values = emptyTemplate()
    values.complaints = 'Слабость.'
    const text = formatTemplate({
      values,
      vitals: emptyVitals(),
      metadata: {
        name: 'Учебный пример',
        iin: '',
        date: '2026-09-30',
        doctor: '',
      },
    })
    expect(text).toContain('ФИО: Учебный пример')
    expect(text).toContain('ИИН: Не указано')
    expect(text).toContain('Аллергологический анамнез\nНе указано')
    expect(text).toContain('Лечение\nНе указано')
    expect(text).not.toMatch(/отрицает|без особенностей|отсутствуют/)
  })

  it('is pure so callers can preserve manually edited fields separately', () => {
    const segments = [utterance('Жалобы: слабость.')]
    const original = JSON.stringify(segments)
    const result = deriveTemplate(segments)
    result.values.complaints = 'Ручная правка'
    expect(deriveTemplate(segments).values.complaints).toBe('слабость.')
    expect(JSON.stringify(segments)).toBe(original)
  })
})
