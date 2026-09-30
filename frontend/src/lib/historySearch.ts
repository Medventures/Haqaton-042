import type { HistoryRecord } from './visitWorkspace'
export function normalizeHistorySearch(text: string): string[] {
  const expanded = text.toLocaleLowerCase('ru').replaceAll('ё','е')
    .replace(/общ\p{L}*\s+анализ\p{L}*\s+кров\p{L}*/gu, 'оак')
    .replace(/complete blood count|\bcbc\b/gu, 'оак')
  return [...new Set(expanded.match(/[\p{L}\p{N}]+/gu) || [])]
}
export function matchesHistory(record: HistoryRecord, query: string): boolean {
  const terms = normalizeHistorySearch(query)
  const words = normalizeHistorySearch(`${record.title} ${record.segments.map(s=>s.text).join(' ')}`)
  return terms.every(term=>words.some(word=>word.startsWith(term)))
}
