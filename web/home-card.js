const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const count = value => Number.isSafeInteger(value) && value >= 0;

export function salesHomeNote({ data, loading, error } = {}) {
  if (loading) return '正在读取客户与股票记录…';
  if (error || !count(data?.total)) return '客户与股票记录暂未加载，请在下方重试。';
  const scope = data.q ? '当前检索 · ' : data.period === 'month' ? '本月登记 · ' : data.period === 'custom' ? '所选日期登记 · ' : '';
  return `${scope}${data.total} 条客户与股票记录`;
}

export function brokerHomeNote({ data, loading, error } = {}) {
  if (loading) return '正在读取渠道案件…';
  const ongoing = data?.metrics?.find(item => item.key === 'ongoing')?.value;
  if (error || !count(ongoing)) return '渠道案件暂未加载，请在下方重试。';
  const scope = data.period === 'month' ? '本月登记 · ' : data.period === 'custom' ? '所选日期登记 · ' : '';
  return `${scope}${ongoing} 件案件在办`;
}

export function renderHomeCard({ role, name, today, note, action, actionLabel, value = '' }) {
  const titles = { investor: '我的维权服务', sales: '销售工作台', broker: '渠道台账' };
  if (!Object.hasOwn(titles, role)) return '';
  const date = /^\d{4}-(\d{2})-(\d{2})$/.exec(today || '');
  const greeting = role === 'broker' ? escape(name || '欢迎使用') : name ? escape(name) + '，您好' : '您好';
  return `<section class="home-paper-card" data-home-role="${role}"><div class="home-paper-content">
    <div class="home-paper-top"><span class="home-paper-greeting">${greeting}</span>${date ? `<time datetime="${escape(today)}">${Number(date[1])}月${Number(date[2])}日</time>` : ''}</div>
    <div class="home-paper-copy"><h1>${titles[role]}</h1><p class="home-paper-note" data-home-note aria-live="polite">${escape(note)}</p>
    <button type="button" class="home-paper-action" data-action="${escape(action)}" data-value="${escape(value)}">${escape(actionLabel)}<span aria-hidden="true" class="home-paper-arrow"></span></button></div></div>
    <img class="home-paper-art" src="/assets/home-${role}.png" width="166" height="138" alt="" aria-hidden="true"></section>`;
}
