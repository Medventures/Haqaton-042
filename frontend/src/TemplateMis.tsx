import { useEffect, useState } from 'react'
import { API_BASE, visitApi } from './hooks/useVisitWorkspace'
import { normalizeFields } from './lib/api'
import type { TemplateValues, TemplateVitals } from './lib/visitTemplate'
import { VITAL_DEFINITIONS } from './lib/visitTemplate'

async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${API_BASE}${path}`, {method: body === undefined ? 'GET' : method, cache:'no-store', headers:{'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})})
  const value = await response.json()
  if (!response.ok) throw new Error(value.error?.message || 'МИС не ответила.')
  return value
}
export function TemplateMis({values, vitals, reviewed, locked}:{values:TemplateValues; vitals:TemplateVitals; reviewed:boolean; locked:boolean}) {
  const [settings,setSettings] = useState<{api_key_configured:boolean; destination:string}|null>(null)
  const [test,setTest] = useState(false)
  const [busy,setBusy] = useState(false)
  const [message,setMessage] = useState('')
  const [receipt,setReceipt] = useState<{document_id:string; revision:number; snapshot:string}|null>(null)
  const [document,setDocument] = useState<Record<string,string>|null>(null)
  const fingerprint = JSON.stringify([values,vitals])
  useEffect(() => { void request('/integrations/mis/settings').then(setSettings).catch(() => {}) }, [])
  async function act(fn:()=>Promise<void>) {setBusy(true);setMessage('');try {await fn()} catch(e){setMessage(e instanceof Error ? e.message : 'Ошибка МИС')}finally{setBusy(false)}}
  return <section className="template-mis" aria-label="Подтверждение и отправка в МИС"><details><summary>Тестовая МИС · настройки подключения</summary>
    <p>Получатель: {settings?.destination || 'не настроен'}. Ключ: {settings?.api_key_configured ? 'на сервере, скрыт' : 'не настроен'}.</p>
    <p>Пациент А — вымышленный. В тестовую базу передаётся проверенный бланк. Аудио и полная расшифровка не отправляются.</p>
    <button className="button secondary" disabled={busy} onClick={()=>void act(async()=>{await request('/integrations/mis/check',{});setMessage('МИС приняла API-ключ. Подключение проверено.')})}>Проверить API-ключ МИС</button></details>
    <label><input type="checkbox" checked={test} onChange={e=>setTest(e.target.checked)} />Только тестовые данные, разрешаю сохранить бланк в тестовой МИС</label>
    <button className="button primary full-width" disabled={busy || locked || !reviewed || !test || receipt?.snapshot === fingerprint} onClick={()=>void act(async()=>{
      const snapshot = fingerprint
      const fields = {...values}
      fields.objective_status = [VITAL_DEFINITIONS.filter(v=>vitals[v.id]).map(v=>`${v.label}: ${vitals[v.id]} ${v.unit}`).join('; '),fields.objective_status].filter(Boolean).join('\n')
      // Isolated export snapshot cannot race with the automatic LLM worker.
      let ws = await visitApi.create()
      try {
        ws = await request(`/workspaces/${ws.id}/form`, {expected_revision:ws.revision,document_fields:fields,fields:normalizeFields({
          complaints:fields.complaints,anamnesis:[fields.illness_history,fields.life_history,fields.gynecological_history,fields.anemia_history,fields.epidemiological_history,fields.objective_status,fields.laboratory_results].filter(Boolean).join('\n'),
          allergies:fields.allergies,diagnosis:fields.diagnosis,prescriptions:[fields.examination_plan,fields.treatment].filter(Boolean).join('\n'),recommendations:fields.recommendations,
        })},'PATCH')
        ws = await request(`/workspaces/${ws.id}/confirm`,{expected_revision:ws.revision})
        const result = await request(`/workspaces/${ws.id}/mis-export`,{expected_revision:ws.revision,patient_id:'demo-patient-001',synthetic_data_confirmed:true})
        setReceipt({...result,snapshot});setDocument(null);setMessage('Тестовая МИС сохранила бланк. Квитанция получена.')
      } finally {await visitApi.remove(ws.id).catch(()=>{})}
    })}>{busy?'Отправка…':receipt?.snapshot === fingerprint?'Отправлено в МИС':'Подтвердить и отправить в МИС'}</button>
    {message && <p role="status">{message}</p>}
    {receipt && <><p>Документ: {receipt.document_id}</p>{receipt.snapshot !== fingerprint && <p>Бланк изменён после отправки. Эта квитанция относится к предыдущему тексту.</p>}<button className="text-button" onClick={()=>void act(async()=>{const result=await request(`/integrations/mis/documents/${receipt.document_id}`);setDocument(result.document.document_fields)})}>Прочитать бланк из базы МИС</button></>}
    {document && <details open><summary>Бланк, прочитанный из базы МИС</summary><pre>{JSON.stringify(document,null,2)}</pre></details>}
  </section>
}
