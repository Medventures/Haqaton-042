import type { Workspace } from './api';

type Props = { workspace: Workspace | null; locked: boolean; apply: (body: object) => void; openSource: (record: string, segment: string) => void };
type Source = { kind: string; value: string; record_id: string; segment_id: string; quote: string; record_kind: string; visit_date: string | null };
type Auto = { result?: {mode:string; height_cm:string; weight_kg:string; bmi:string; iron_deficit_mg:string|null; hb_g_l:string|null; target_hb_g_l:string|null; iron_store_mg:string|null}; sources?: Source[]; missing?:string[]; conflicts?:{field:string}[]; uses_history?:boolean; message?:string };
const captions: Record<string,string> = {height_cm:'Рост, см',weight_kg:'Вес, кг',hb_g_l:'Гемоглобин, г/л',target_hb_g_l:'Целевой Hb, г/л',iron_store_mg:'Запас железа, мг'};

export function Calculator({ workspace, locked, apply, openSource }: Props) {
  const automatic = (workspace?.automatic_calculation || {}) as Auto;
  const result = automatic.result;
  return <section className="calculator"><div className="calc-heading"><div><span className="eyebrow">АВТОМАТИЧЕСКИ ИЗ РАЗГОВОРОВ</span><h3>Показатели и расчёт</h3></div><span className="calc-symbol">ƒ</span></div>
    <p className="small muted">Сначала текущий приём, затем последние датированные данные истории. Повторный ввод не нужен.</p>
    <div className="calc-grid">{automatic.sources?.map(source => <div key={source.kind}><small>{captions[source.kind]}</small><strong style={{display:'block',fontSize:20}}>{source.value}</strong><button className="text-button" title={source.quote} onClick={() => openSource(source.record_id,source.segment_id)}>{source.record_kind === 'history' ? 'История · ' + (source.visit_date || 'без даты') : 'Текущий разговор'} ↗</button></div>)}</div>
    {result ? <><div className="calc-result"><span>ИМТ <strong>{result.bmi}</strong> кг/м²</span><small>{result.weight_kg} ÷ ({result.height_cm} / 100)²</small></div>
      {result.iron_deficit_mg && <div className="calc-result iron"><span>Общий дефицит железа <strong>{result.iron_deficit_mg}</strong> мг</span><small>Общая потребность по Ганзони, не разовая доза.</small></div>}
      {automatic.uses_history && <p className="stale">Использованы данные прошлого приёма. Проверьте их актуальность перед переносом в документ.</p>}
      <button className="secondary full" disabled={locked} onClick={() => apply({ mode:result.mode, height_cm:result.height_cm,weight_kg:result.weight_kg,reviewed:true,...(result.mode==='iron_deficit' ? {hb_g_l:result.hb_g_l,target_hb_g_l:result.target_hb_g_l,iron_store_mg:result.iron_store_mg} : {}) })}>Данные проверены — перенести расчёт в черновик →</button>
    </> : <p className="empty-note">В разговорах пока не найдены однозначные рост и вес с единицами измерения. Уточните реплики и роли говорящих.</p>}
    {!!automatic.conflicts?.length && <p className="stale">Расхождения: {automatic.conflicts.map(c => captions[c.field]).join(', ')}. Значение не выбрано автоматически.</p>}
    {!result?.iron_deficit_mg && <p className="small muted">Для общего дефицита железа нужны также Hb, целевой Hb и запас железа, явно указанные в источнике.</p>}
    <p className="calc-disclaimer">{automatic.message || 'Доза требует препарата и актуального правила назначения. ИМТ сам по себе дозу не определяет.'}</p>
  </section>;
}
