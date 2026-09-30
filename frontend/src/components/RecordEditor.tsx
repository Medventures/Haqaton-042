import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { RecordInput, RecordItem, UtteranceInput } from '../lib/api'
import './RecordEditor.css'

interface RecordEditorProps {
  record: RecordItem | null
  kind: 'history' | 'current'
  highlightSegmentId?: string
  busy: boolean
  onSave: (input: RecordInput) => void
  onDelete?: () => void
  onClose: () => void
}

type Role = UtteranceInput['role']
const roles: { value: Role; label: string }[] = [
  { value: 'doctor', label: 'Врач' },
  { value: 'patient', label: 'Пациент' },
  { value: 'unknown', label: 'Роль не определена' },
]

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function blankSegment(): UtteranceInput {
  return { id: crypto.randomUUID(), role: 'doctor', text: '', start: 0, end: 0 }
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

export default function RecordEditor({
  record,
  kind,
  highlightSegmentId,
  busy,
  onSave,
  onDelete,
  onClose,
}: RecordEditorProps) {
  const [title, setTitle] = useState(
    record?.title ||
      (kind === 'current' ? 'Текущий приём' : 'Предыдущий приём'),
  )
  const [date, setDate] = useState(
    record?.visit_date || (kind === 'current' ? today() : ''),
  )
  const [segments, setSegments] = useState<UtteranceInput[]>(
    () =>
      record?.segments.map((segment) => ({ ...segment })) || [blankSegment()],
  )
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const segmentRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const recordId = record?.id

  useEffect(() => {
    if (!highlightSegmentId) return
    const element = segmentRefs.current.get(highlightSegmentId)
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element?.focus({ preventScroll: true })
  }, [highlightSegmentId, recordId])

  function updateSegment(index: number, patch: Partial<UtteranceInput>) {
    setError('')
    setSegments((current) =>
      current.map((segment, i) =>
        i === index ? { ...segment, ...patch } : segment,
      ),
    )
  }

  function save() {
    if (busy) return
    if (!title.trim()) return setError('Укажите название записи.')
    const emptyIndex = segments.findIndex((segment) => !segment.text.trim())
    if (emptyIndex !== -1) {
      setError(`Заполните реплику ${emptyIndex + 1} или удалите её.`)
      const id = segments[emptyIndex].id
      if (id) segmentRefs.current.get(id)?.focus()
      return
    }
    if (
      segments.reduce((sum, segment) => sum + segment.text.trim().length, 0) >
      100_000
    ) {
      return setError('Слишком длинная запись: максимум 100 000 символов.')
    }
    setError('')
    onSave({
      title: title.trim(),
      visit_date: date || null,
      kind: record?.kind || kind,
      segments: segments.map((segment) => ({
        ...segment,
        text: segment.text.trim(),
      })),
    })
  }

  const speakerIds = [
    ...new Set(
      segments
        .map((segment) => segment.speaker_id)
        .filter((speaker): speaker is string => Boolean(speaker)),
    ),
  ]
  const hasUnknown = segments.some((segment) => segment.role === 'unknown')

  return (
    <form
      className="record-editor stack"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      }}
    >
      <fieldset disabled={busy} className="record-editor-fields stack">
        <div className="record-metadata">
          <label className="form-label">
            Название записи
            <input
              className="field-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
            />
          </label>
          <label className="form-label">
            Дата приёма
            <input
              className="field-input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        </div>

        <p className="muted record-editor-help">
          Проверьте слова и укажите, кто их произнёс. Реплики без роли не
          используются при заполнении листа.
        </p>

        {speakerIds.length > 0 && (
          <div className="record-speakers">
            <p className="form-label">
              Назначить роль всем репликам говорящего
            </p>
            {speakerIds.map((speaker, speakerIndex) => {
              const own = segments.filter(
                (segment) => segment.speaker_id === speaker,
              )
              const sameRole = own.every(
                (segment) => segment.role === own[0].role,
              )
              return (
                <label className="record-speaker-row" key={speaker}>
                  <span>
                    Голос {speakerIndex + 1}{' '}
                    <small className="muted">· {own.length} реплик</small>
                  </span>
                  <select
                    className="field-input"
                    value={sameRole ? own[0].role : ''}
                    onChange={(event) =>
                      setSegments((current) =>
                        current.map((segment) =>
                          segment.speaker_id === speaker
                            ? { ...segment, role: event.target.value as Role }
                            : segment,
                        ),
                      )
                    }
                  >
                    <option value="" disabled>
                      Разные роли
                    </option>
                    {roles.map((role) => (
                      <option value={role.value} key={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
        )}

        <div className="record-segments">
          {segments.map((segment, index) => (
            <div
              className={`record-segment${segment.id === highlightSegmentId ? ' record-segment-highlight' : ''}`}
              key={segment.id || index}
            >
              <div className="record-segment-toolbar">
                <select
                  className="field-input record-role"
                  aria-label={`Кто говорит в реплике ${index + 1}`}
                  value={segment.role}
                  onChange={(event) =>
                    updateSegment(index, { role: event.target.value as Role })
                  }
                >
                  {roles.map((role) => (
                    <option value={role.value} key={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
                <span className="muted record-segment-number">
                  {segment.end > 0
                    ? `${clock(segment.start)}–${clock(segment.end)}`
                    : `Реплика ${index + 1}`}
                </span>
                <button
                  type="button"
                  className="button ghost record-remove"
                  title="Удалить реплику"
                  aria-label={`Удалить реплику ${index + 1}`}
                  disabled={segments.length === 1}
                  onClick={() =>
                    setSegments((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <textarea
                className="field-input record-segment-text"
                ref={(element) => {
                  if (!segment.id) return
                  if (element) segmentRefs.current.set(segment.id, element)
                  else segmentRefs.current.delete(segment.id)
                }}
                aria-label={`Текст реплики ${index + 1}`}
                maxLength={10_000}
                rows={Math.max(
                  2,
                  Math.min(8, Math.ceil(segment.text.length / 75)),
                )}
                value={segment.text}
                placeholder={
                  segment.role === 'doctor'
                    ? 'Осмотр, заключение, назначения или рекомендации врача…'
                    : 'Жалобы и ответы пациента…'
                }
                onChange={(event) =>
                  updateSegment(index, { text: event.target.value })
                }
              />
            </div>
          ))}
        </div>

        <button
          type="button"
          className="button secondary record-add"
          disabled={segments.length >= 1500}
          onClick={() => setSegments((current) => [...current, blankSegment()])}
        >
          <Plus size={17} /> Добавить реплику
        </button>
      </fieldset>

      {hasUnknown && (
        <div className="notice">
          Есть реплики без роли. Их можно сохранить и уточнить позже.
        </div>
      )}
      {error && (
        <p className="record-validation" role="alert">
          {error}
        </p>
      )}

      {confirmDelete && onDelete ? (
        <div className="record-delete-confirm">
          <p>
            Удалить эту запись? Если лист уже собран, после удаления его
            потребуется собрать заново.
          </p>
          <div className="row">
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={onDelete}
            >
              Удалить запись
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Оставить
            </button>
          </div>
        </div>
      ) : (
        <div className="record-editor-actions">
          {onDelete && (
            <button
              type="button"
              className="button ghost record-delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} /> Удалить запись
            </button>
          )}
          <div className="record-editor-save">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              Отмена
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить запись'}
            </button>
          </div>
        </div>
      )}
    </form>
  )
}
