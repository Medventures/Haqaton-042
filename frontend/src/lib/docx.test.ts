import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { createConsultationDocx } from './docx'
import { emptyTemplate, emptyVitals, FIELD_IDS } from './visitTemplate'
it('fills the supplied Word template and preserves its non-content OOXML parts',()=>{
  const template = new Uint8Array(readFileSync('public/templates/therapist.docx'))
  const values=emptyTemplate(); values.complaints='Слабость & утомляемость\nПравка врача'
  const output=createConsultationDocx(template,{values,vitals:emptyVitals(),metadata:{name:'',iin:'',doctor:'Тестовый врач',date:'2026-09-30'}})
  const original=unzipSync(template), entries=unzipSync(output), xml=strFromU8(entries['word/document.xml'])
  expect(xml).toContain('Слабость &amp; утомляемость')
  expect(xml).toContain('Правка врача')
  expect(xml).toContain('Осмотр терапевта')
  expect(xml).not.toContain('Сорбифер')
  for(const field of FIELD_IDS) expect(xml).not.toContain(`{{${field}}}`)
  for(const key of Object.keys(original)) if(key!=='word/document.xml') expect(entries[key]).toEqual(original[key])
})
