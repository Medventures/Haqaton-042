import { useEffect, useState } from 'react';
import { api, type Fields, type Workspace } from './api';

type Settings = { configured: boolean; api_key_configured: boolean; destination: string;
  workspace_storage: string; speech_cache_enabled: boolean; ttl_seconds: number };
type Patient = { id: string; label: string };
type Receipt = { document_id: string; revision: number; patient_id: string;
  received_at: string; superseded: boolean };
type Props = { workspace: Workspace | null; locked: boolean; dirty: boolean };

export function MisPanel({ workspace, locked, dirty }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patient, setPatient] = useState('demo-patient-001');
  const [synthetic, setSynthetic] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [received, setReceived] = useState<Fields | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void api<Settings>('/integrations/mis/settings').then(setSettings).catch(e => setError(String(e))); }, []);
  useEffect(() => { setReceipt(null); setReceived(null); setSynthetic(false); setMessage(''); }, [workspace?.id]);
  useEffect(() => { setSynthetic(false); }, [workspace?.revision]);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="mis-panel" aria-label="Интеграция с тестовой МИС">
    <h3>Тестовая МИС</h3>
    <details><summary>Настройки интеграции и обработки данных</summary>
      <p>Этот стенд использует тестовых пациентов. Реальная МИС клиники не подключена.</p>
      <dl><dt>Адрес получателя</dt><dd>{settings?.destination || 'Не настроен'}</dd>
        <dt>API-ключ МИС</dt><dd>{settings?.api_key_configured ? 'Настроен на сервере · скрыт' : 'Не настроен'}</dd>
        <dt>Рабочая сессия MedHub</dt><dd>{settings?.workspace_storage === 'memory' ? 'В памяти до завершения или истечения срока; перезапуск удаляет черновик' : 'Сохраняется в PostgreSQL'}</dd>
        <dt>Кэш новых записей</dt><dd>{settings?.speech_cache_enabled ? 'Включён: аудио и текст сохраняются' : 'Отключён'}</dd></dl>
      <p>Отправляется только подтверждённый бланк и тестовый ID пациента. Аудио и полный разговор в МИС не отправляются. Полученный бланк сохраняется в тестовой базе МИС.</p>
      <p>Подготовленная тестовая запись остаётся в демо-базе. Маскирование имён не реализовано. Скачанный Word остаётся на устройстве. OpenAI — отдельная внешняя интеграция.</p>
      <p className="muted small">Администратор задаёт MIS_API_KEY и MEDHUB_MIS_BASE_URL на сервере. Ключ не передаётся браузеру. Стенд предназначен только для тестовых данных.</p>
    </details>
    <button className="secondary full" disabled={locked || busy || !settings?.configured} onClick={() => void action(async () => {
      const result = await api<{patients: Patient[]}>('/integrations/mis/check', 'POST');
      setPatients(result.patients); setMessage('Соединение проверено: МИС приняла API-ключ.');
    })}>Проверить подключение по API-ключу</button>
    <label>Пациент в тестовой базе<select value={patient} disabled={busy || locked} onChange={e => { setPatient(e.target.value); setSynthetic(false); }}>
      {(patients.length ? patients : [{id:'demo-patient-001',label:'Тестовый пациент А'}, {id:'demo-patient-002',label:'Тестовый пациент Б'}]).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select></label>
    <label className="check-label"><input type="checkbox" checked={synthetic} disabled={locked || busy} onChange={e => setSynthetic(e.target.checked)} /><span>Это тестовая запись с вымышленными данными. Разрешаю сохранить бланк в тестовой МИС.</span></label>
    <button className="primary full" disabled={locked || busy || dirty || !synthetic || !settings?.configured || !workspace || workspace.confirmed_revision !== workspace.revision} onClick={() => void action(async () => {
      const next = await api<Receipt>(`/workspaces/${workspace!.id}/mis-export`, 'POST', {
        expected_revision: workspace!.revision, patient_id: patient, synthetic_data_confirmed: synthetic,
      });
      setReceipt(next); setReceived(null);
      setMessage(next.superseded ? `МИС приняла версию ${next.revision}; текущий черновик уже изменился.` : `Версия ${next.revision} сохранена в тестовой МИС.`);
    })}>{busy ? 'Запрос к МИС…' : 'Отправить в тестовую МИС'}</button>
    {error && <p className="alert error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {receipt && <div className="mis-receipt"><strong>Квитанция получателя</strong><p>Документ: {receipt.document_id}<br/>Пациент: {receipt.patient_id}<br/>Версия: {receipt.revision}<br/>{new Date(receipt.received_at).toLocaleString('ru-RU')}</p>
      {(dirty || receipt.revision !== workspace?.revision) && <p className="stale">Текущие правки ещё не отправлены.</p>}
      <button className="text-button" disabled={busy || locked} onClick={() => void action(async () => {
        const result = await api<{document: {fields: Fields}}>(`/integrations/mis/documents/${receipt.document_id}`);
        setReceived(result.document.fields); setMessage('Документ прочитан из базы принимающей МИС.');
      })}>Показать документ из базы МИС</button>
      {received && <pre className="mis-document">{JSON.stringify(received, null, 2)}</pre>}
    </div>}
  </section>;
}
