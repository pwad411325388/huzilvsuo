export function businessBoardScope(actor, page, ledger = '洽谈中') {
  if (!actor || !['sales', 'broker'].includes(actor.role)) return null;
  if (actor.role === 'sales' && page !== 'mine' || actor.role === 'broker' && !['home', 'mine'].includes(page)) return null;
  return { role: actor.role, owner: actor.id, page,
    ledger: actor.role === 'broker' && page === 'mine' ? ledger === '已签约' ? 'signed' : 'negotiating' : '' };
}

export function businessBoardMatches(scope, actor, page, ledger) {
  const next = businessBoardScope(actor, page, ledger);
  return !!scope && !!next && ['role', 'owner', 'page', 'ledger'].every(key => scope[key] === next[key]);
}

export function businessBoardParams(board, scope, offset = board.offset) {
  const params = { period: board.period, metric: scope.ledger ? 'customers' : board.metric, offset };
  if (board.period === 'custom') Object.assign(params, { from: board.rangeFrom, to: board.rangeTo });
  if (scope.ledger) params.ledger = scope.ledger;
  return params;
}

export function businessBoardPresentation(scope) {
  const ledger = !!scope?.ledger;
  return { title: ledger ? '客户台账' : '我的数据', showMetrics: !ledger, showLedger: ledger,
    label: ledger ? scope.ledger === 'signed' ? '已签约客户' : '洽谈中客户' : '',
    showSalesGuide: scope?.role === 'sales' };
}
