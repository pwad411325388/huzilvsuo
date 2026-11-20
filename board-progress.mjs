// A customer card describes only the records included in its current date range.
// Signing eligibility is separate and must never be derived from this label.
export function summarizeProgress(statuses) {
  const labels = [...new Set(statuses.map(value => String(value || '').trim() || '进度待核对'))];
  return labels.length > 1 ? '多个案件进度' : labels[0] || '进度待核对';
}
