import { useEffect, useRef } from 'react'
import blocks from './lib/userTemplate.json'
import { FIELD_DEFINITIONS, VITAL_DEFINITIONS, type FieldId, type TemplateValues, type TemplateVitals, type PatientMetadata } from './lib/visitTemplate'

function InlineField({ value, label, onChange }: { value: string; label: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = `${ref.current.scrollHeight}px` } }, [value])
  return <textarea ref={ref} rows={1} aria-label={label} value={value} onChange={e => onChange(e.target.value)} placeholder="Не озвучено" maxLength={10000} />
}
export function TemplatePaper({ values, vitals, metadata, onChange, onMetadata, edited, register, reveal }: {
  values: TemplateValues; vitals: TemplateVitals; metadata: PatientMetadata;
  onChange: (id: FieldId, text: string) => void; onMetadata: (key: 'doctor' | 'date', text: string) => void;
  edited: Partial<TemplateValues>; register: (id: FieldId, el: HTMLElement | null) => void; reveal: (id: FieldId) => void;
}) {
  const labels = Object.fromEntries(FIELD_DEFINITIONS.map(f => [f.id, f.label]))
  const measures = VITAL_DEFINITIONS.filter(v => vitals[v.id]).map(v => `${v.label}: ${vitals[v.id]} ${v.unit}`).join('; ')
  return <div className="paper source-paper" aria-label="Черновик по бланку ЖДА ВОП-1">
    {blocks.map((block, i) => <div key={i} className="source-paragraph" style={{ textAlign: block.align === 'both' ? 'justify' : block.align as 'left', marginBottom: `${block.after}pt` }}>
      {!block.runs.length ? <br /> : block.runs.map((run, r) => <span key={r} style={{ fontFamily: run.font, fontSize: `${run.size}pt`, fontWeight: run.bold ? 700 : 400, fontStyle: run.italic ? 'italic' : 'normal', whiteSpace: 'pre-wrap' }}>
        {run.text.split(/(\{\{[a-z_]+\}\})/g).map((part, p) => {
          const key = part.match(/^\{\{([a-z_]+)\}\}$/)?.[1]
          if (!key) return <span key={p}>{part}</span>
          if (key === 'doctor' || key === 'date') return <InlineField key={p} value={metadata[key]} label={key === 'doctor' ? 'Врач' : 'Дата'} onChange={v => onMetadata(key, v)} />
          const id = key as FieldId
          return <span className="source-slot" key={p} ref={el => register(id, el)}>
            {id === 'objective_status' && measures && <span className="source-measurements">{measures}<br /></span>}
            <InlineField value={values[id]} label={labels[id]} onChange={v => onChange(id, v)} />
            {values[id] && <button className="source-note" onClick={() => reveal(id)}>{Object.hasOwn(edited, id) ? 'Ваша правка' : 'Источник в разговоре'}</button>}
          </span>
        })}
      </span>)}
    </div>)}
  </div>
}
