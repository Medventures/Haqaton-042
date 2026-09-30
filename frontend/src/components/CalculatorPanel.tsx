import { useEffect, useId, useState } from 'react'
import { Calculator, ChevronDown, Check } from 'lucide-react'
import type { CalculationInput, Workspace } from '../lib/api'
import './CalculatorPanel.css'

type Props = {
  workspace: Workspace
  busy: boolean
  onCalculate: (input: CalculationInput) => Promise<void> | void
  onApply: () => Promise<void> | void
}

type Mode = 'bmi' | 'iron_deficit'
type ValueKey =
  'height_cm' | 'weight_kg' | 'hb_g_l' | 'target_hb_g_l' | 'iron_store_mg'
type Values = Record<ValueKey, string>
const blank: Values = {
  height_cm: '',
  weight_kg: '',
  hb_g_l: '',
  target_hb_g_l: '',
  iron_store_mg: '',
}
const inputs: { key: ValueKey; label: string; hint: string }[] = [
  { key: 'height_cm', label: 'Рост, см', hint: '30–300 см' },
  { key: 'weight_kg', label: 'Масса тела, кг', hint: '1–1000 кг' },
  {
    key: 'hb_g_l',
    label: 'Гемоглобин, г/л',
    hint: 'Актуальное значение, до 250 г/л',
  },
  {
    key: 'target_hb_g_l',
    label: 'Целевой гемоглобин, г/л',
    hint: 'Задаёт врач, до 250 г/л',
  },
  {
    key: 'iron_store_mg',
    label: 'Запас железа, мг',
    hint: 'Задаёт врач, 0–3000 мг',
  },
]

function number(value: string): number {
  const normalized = value.trim().replace(',', '.')
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN
}

function currentValues(measurements: Workspace['measurements']): Values {
  const next = { ...blank }
  for (const key of Object.keys(next) as ValueKey[]) {
    const candidates = measurements
      .filter((item) => item.kind === key && item.record_kind === 'current')
      .map((item) => number(String(item.value)))
      .filter(Number.isFinite)
    const unique = [...new Set(candidates)]
    if (unique.length === 1) next[key] = String(unique[0])
  }
  return next
}

export function CalculatorPanel({
  workspace,
  busy,
  onCalculate,
  onApply,
}: Props) {
  const id = useId()
  const [mode, setMode] = useState<Mode>('bmi')
  const [values, setValues] = useState<Values>(() =>
    currentValues(workspace.measurements),
  )
  const [reviewed, setReviewed] = useState(false)
  const measurements = JSON.stringify(workspace.measurements)
  useEffect(() => {
    setValues(
      currentValues(JSON.parse(measurements) as Workspace['measurements']),
    )
    setReviewed(false)
  }, [workspace.id, measurements])

  const n = (key: ValueKey) => number(values[key])
  const decimalPlaces = (key: ValueKey) =>
    (values[key].trim().replace(',', '.').split('.')[1] || '').length
  const validBmi =
    n('height_cm') >= 30 &&
    n('height_cm') <= 300 &&
    decimalPlaces('height_cm') <= 2 &&
    n('weight_kg') >= 1 &&
    n('weight_kg') <= 1000 &&
    decimalPlaces('weight_kg') <= 3
  const validIron =
    validBmi &&
    n('hb_g_l') > 0 &&
    n('hb_g_l') <= 250 &&
    n('target_hb_g_l') > n('hb_g_l') &&
    n('target_hb_g_l') <= 250 &&
    n('iron_store_mg') >= 0 &&
    n('iron_store_mg') <= 3000
  const valid = mode === 'bmi' ? validBmi : validIron
  const visibleInputs = inputs.filter(
    (input) =>
      mode === 'iron_deficit' ||
      input.key === 'height_cm' ||
      input.key === 'weight_kg',
  )
  const result = workspace.calculation
  const matchesResult = Boolean(
    result &&
    result.mode === mode &&
    visibleInputs.every(({ key }) => {
      const resultValue = result[key]
      return (
        resultValue !== null &&
        resultValue !== undefined &&
        n(key) === number(resultValue)
      )
    }),
  )
  const alreadyApplied = Boolean(
    result &&
    workspace.applied_calculation_text === result.text &&
    workspace.fields.recommendations?.includes(result.text),
  )
  const canApply = Boolean(
    result?.reviewed &&
    !result.exceeds_maximum &&
    !(result.dose_mg !== null && result.maximum_mg === null) &&
    matchesResult &&
    reviewed &&
    valid &&
    !alreadyApplied,
  )

  const calculate = () => {
    if (!valid || !reviewed || busy) return
    void onCalculate({
      mode,
      height_cm: values.height_cm.trim().replace(',', '.'),
      weight_kg: values.weight_kg.trim().replace(',', '.'),
      medication: '',
      basis: 'per_dose',
      rule_source: '',
      reviewed: true,
      ...(mode === 'iron_deficit'
        ? {
            hb_g_l: values.hb_g_l.trim().replace(',', '.'),
            target_hb_g_l: values.target_hb_g_l.trim().replace(',', '.'),
            iron_store_mg: values.iron_store_mg.trim().replace(',', '.'),
          }
        : {}),
    })
  }

  return (
    <details className="calc-panel">
      <summary className="calc-summary">
        <Calculator size={20} aria-hidden="true" />
        <span>
          <strong>Калькуляторы</strong>
          <small>ИМТ и дефицит железа · при необходимости</small>
        </span>
        <ChevronDown size={18} className="calc-chevron" aria-hidden="true" />
      </summary>
      <div className="calc-content">
        <p className="calc-intro">
          Значения из текущего разговора подставляются, если они однозначны.
          Проверьте их перед расчётом.
        </p>
        <label className="calc-field" htmlFor={`${id}-mode`}>
          <span>Что рассчитать</span>
          <select
            id={`${id}-mode`}
            value={mode}
            disabled={busy}
            onChange={(event) => {
              setMode(event.target.value as Mode)
              setReviewed(false)
            }}
          >
            <option value="bmi">Индекс массы тела (ИМТ)</option>
            <option value="iron_deficit">Общий дефицит железа (Ганзони)</option>
          </select>
        </label>
        <div className="calc-input-grid">
          {visibleInputs.map(({ key, label, hint }) => (
            <label className="calc-field" key={key} htmlFor={`${id}-${key}`}>
              <span>{label}</span>
              <input
                id={`${id}-${key}`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={values[key]}
                disabled={busy}
                placeholder="Уточните значение"
                aria-describedby={`${id}-${key}-hint`}
                onChange={(event) => {
                  setValues((previous) => ({
                    ...previous,
                    [key]: event.target.value,
                  }))
                  setReviewed(false)
                }}
              />
              <small id={`${id}-${key}-hint`}>{hint}</small>
            </label>
          ))}
        </div>
        {mode === 'iron_deficit' && (
          <p className="calc-note">
            Формула: масса × (целевой Hb − текущий Hb) × 0,24 + запас железа.
            Результат — общая потребность в элементарном железе; дозу и схему
            введения определяет врач.
          </p>
        )}
        {mode === 'iron_deficit' &&
          Number.isFinite(n('hb_g_l')) &&
          Number.isFinite(n('target_hb_g_l')) &&
          n('target_hb_g_l') <= n('hb_g_l') && (
            <p className="calc-warning" role="status">
              Целевой гемоглобин должен быть выше текущего. Проверьте значения и
              применимость расчёта.
            </p>
          )}
        <label className="calc-review">
          <input
            type="checkbox"
            checked={reviewed}
            disabled={busy || !valid}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          <span>
            Я проверил(а) значения, их актуальность и применимость формулы
          </span>
        </label>
        <button
          type="button"
          className="calc-button"
          disabled={busy || !valid || !reviewed}
          onClick={calculate}
        >
          Рассчитать
        </button>
        {result && (
          <section
            className="calc-result"
            aria-label="Результат расчёта"
            aria-live="polite"
          >
            <div className="calc-result-values">
              <div>
                <small>Индекс массы тела</small>
                <strong>
                  {result.bmi} <span>кг/м²</span>
                </strong>
              </div>
              {result.mode === 'iron_deficit' &&
                result.iron_deficit_mg != null && (
                  <div>
                    <small>Общий дефицит железа</small>
                    <strong>
                      {result.iron_deficit_mg} <span>мг</span>
                    </strong>
                  </div>
                )}
            </div>
            <details className="calc-formula">
              <summary>Показать расчёт</summary>
              <p>{result.text}</p>
            </details>
            {!matchesResult && (
              <p className="calc-warning">
                Выше показан предыдущий расчёт. Проверьте новые параметры и
                нажмите «Рассчитать».
              </p>
            )}
            {!result.reviewed && (
              <p className="calc-warning">
                Подтвердите проверку исходных данных и выполните расчёт заново.
              </p>
            )}
            {result.exceeds_maximum && (
              <p className="calc-warning">
                Расчёт превышает указанный максимум. Добавление в лист
                недоступно.
              </p>
            )}
            {result.dose_mg !== null && result.maximum_mg === null && (
              <p className="calc-warning">
                В сохранённом расчёте не указан проверенный максимум дозы.
                Добавление в лист недоступно.
              </p>
            )}
            <button
              type="button"
              className="calc-button calc-apply"
              disabled={busy || !canApply}
              onClick={() => void onApply()}
            >
              {alreadyApplied ? (
                <>
                  <Check size={17} aria-hidden="true" /> Добавлено в
                  рекомендации
                </>
              ) : (
                'Добавить в рекомендации'
              )}
            </button>
          </section>
        )}
      </div>
    </details>
  )
}
