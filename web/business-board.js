export function businessBoardScope(actor, page, ledger = 'all') {
  if (!actor || !['sales', 'broker'].includes(actor.role)) return null;
  if (actor.role === 'sales' && page !== 'mine' || actor.role === 'broker' && page !== 'home') return null;
  return { role: actor.role, owner: actor.id, page,
    ledger: actor.role === 'broker' ? ledger === 'negotiating' ? 'negotiating' : 'all' : '' };
}

export function businessBoardMatches(scope, actor, page, ledger) {
  const next = businessBoardScope(actor, page, ledger);
  return !!scope && !!next && ['role', 'owner', 'page', 'ledger'].every(key => scope[key] === next[key]);
}

export function businessBoardParams(board, scope, offset = board.offset) {
  const params = { period: board.period, metric: board.metric, offset, limit: 5 };
  if (board.period === 'custom') Object.assign(params, { from: board.rangeFrom, to: board.rangeTo });
  if (scope.role === 'broker') Object.assign(params, { ledger: scope.ledger, q: board.q || '' });
  return params;
}

export function businessBoardPresentation(scope) {
  return { title: scope?.role === 'broker' ? '渠道概览' : '我的数据', showMetrics: true,
    label: scope?.ledger === 'negotiating' ? '洽谈中客户' : '',
    showSalesGuide: scope?.role === 'sales' };
}
