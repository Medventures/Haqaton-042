import { expect, it } from 'vitest'
import { DEMO_HISTORY } from './visitWorkspace'
import { matchesHistory } from './historySearch'
it('finds full lab names and inflected recommendations using either spelling',()=>{
  for (const query of ['ОАК', 'общий анализ крови', 'ОАК общий анализ крови']) {
    const found = DEMO_HISTORY.filter(r=>matchesHistory(r,query))
    expect(found.map(r=>r.id)).toContain('00000000-0000-4000-8000-000000000102')
    expect(found.map(r=>r.id)).toContain('00000000-0000-4000-8000-000000000101')
    expect(found.map(r=>r.id)).not.toContain('00000000-0000-4000-8000-000000000103')
  }
})
