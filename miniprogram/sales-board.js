const { request } = require('./client');

function state(role = 'sales') {
  return { salesBoard: null, boardSelected: null, boardPeriod: 'all', boardFrom: '', boardTo: '', boardRangeFrom: '', boardRangeTo: '', boardMetric: role === 'broker' ? 'customers' : 'channels',
    boardDraft: '', boardQ: '', boardLedger: 'all', boardLoading: false, boardError: '', boardDateError: '', boardExpanded: true, boardOffset: 0, boardPage: 1, boardPages: 1 };
}

const methods = {
  toggleBoardDetails() { this.setData({ boardExpanded: !this.data.boardExpanded }); },
  async loadSalesBoard(offset = this.data.boardOffset || 0) {
    const token = getApp().globalData.token;
    const actor = this.data.view?.actor;
    const role = actor?.role;
    if (!token || !['sales', 'broker'].includes(role) || (role === 'sales' && this.data.isHome) || (role === 'broker' && !this.data.isHome) || this.data.isRecordsPage || this.boardVisible === false) return;
    if (this.boardToken !== token || this.boardOwner !== role + ':' + actor.id) {
      this.boardToken = token;
      this.boardOwner = role + ':' + actor.id;
      this.setData(state(role));
      offset = 0;
    }
    if (role === 'broker' && this.data.boardMetric === 'signings') {
      this.setData({ boardMetric: 'effective', boardLedger: 'all', boardOffset: 0 });
      offset = 0;
    }
    const { boardPeriod, boardRangeFrom, boardRangeTo, boardMetric } = this.data;
    const sequence = this.boardSequence = (this.boardSequence || 0) + 1;
    const current = () => sequence === this.boardSequence && token === getApp().globalData.token
      && actor.id === this.data.view?.actor.id && role === this.data.view?.actor.role && this.boardVisible !== false;
    this.setData({ boardLoading: true, boardError: '', salesBoard: null, boardSelected: null });
    const params = { period: boardPeriod, metric: boardMetric, offset, limit: 5 };
    if (role === 'broker') Object.assign(params, { q: this.data.boardQ, ledger: this.data.boardLedger });
    if (boardPeriod === 'custom') Object.assign(params, { from: boardRangeFrom, to: boardRangeTo });
    const query = Object.keys(params).map(key => key + '=' + encodeURIComponent(params[key])).join('&');
    try {
      const board = await request('/' + role + '/board?' + query);
      if (!current()) return;
      if (!board || board.selected !== boardMetric || !Array.isArray(board.metrics) || !Array.isArray(board.items)
          || !board.metrics.some(item => item.key === board.selected)
          || !Number.isInteger(board.total) || board.total < 0 || !Number.isInteger(board.offset)
          || board.offset < 0 || board.limit !== params.limit || board.items.length > board.limit) {
        throw new Error('统计数据暂未完整返回，请重试');
      }
      const visibleBoard = role === 'broker' ? { ...board, metrics: board.metrics.filter(item => item.key !== 'signings') } : board;
      this.setData({ salesBoard: visibleBoard, boardSelected: visibleBoard.metrics.find(item => item.key === board.selected),
        boardLoading: false, boardMetric: board.selected, boardOffset: board.offset,
        boardPage: Math.floor(board.offset / board.limit) + 1,
        boardPages: Math.max(1, Math.ceil(board.total / board.limit)) });
    } catch (error) {
      if (!current()) return;
      this.setData({ boardLoading: false, boardError: error.message || '暂时无法加载统计' });
      if (error.status === 401) this.returnToLogin();
    }
  },
  pickBoardPeriod(event) {
    const period = event.currentTarget.dataset.period;
    if (!['all', 'month'].includes(period)) return;
    this.setData({ boardPeriod: period, boardDateError: '', boardOffset: 0, boardExpanded: true });
    return this.loadSalesBoard(0);
  },
  pickBoardDate(event) {
    const field = event.currentTarget.dataset.field;
    if (field === 'from' || field === 'to') this.setData({ [field === 'from' ? 'boardFrom' : 'boardTo']: event.detail.value, boardDateError: '' });
  },
  applyBoardDates() {
    const { boardFrom, boardTo } = this.data;
    if (!boardFrom || !boardTo) { this.setData({ boardDateError: '请选择起止日期' }); return; }
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(boardFrom) || !validDate(boardTo)) { this.setData({ boardDateError: '请选择有效的日期' }); return; }
    if (boardFrom > boardTo) { this.setData({ boardDateError: '开始日期须早于或等于结束日期' }); return; }
    if (this.data.view.today && boardTo > this.data.view.today) { this.setData({ boardDateError: '日期不能晚于今天' }); return; }
    this.setData({ boardPeriod: 'custom', boardRangeFrom: boardFrom, boardRangeTo: boardTo, boardDateError: '', boardOffset: 0, boardExpanded: true });
    return this.loadSalesBoard(0);
  },
  pickBoardMetric(event) {
    const broker = this.data.view?.actor.role === 'broker';
    const requested = event.currentTarget.dataset.key;
    const key = broker && requested === 'signings' ? 'effective' : requested;
    const keys = broker ? ['customers', 'ongoing', 'effective', 'closed'] : ['channels', 'customers', 'effective', 'closed'];
    if (!keys.includes(key)) return;
    this.setData({ boardMetric: key, boardLedger: 'all', boardOffset: 0, boardExpanded: true });
    return this.loadSalesBoard(0);
  },
  boardInput(event) {
    if (this.data.view?.actor.role === 'broker' && this.data.isHome) this.setData({ boardDraft: event.detail.value });
  },
  boardSearch() { return this.applyBrokerFilters({ boardQ: this.data.boardDraft.trim() }); },
  boardReset() { return this.applyBrokerFilters({ boardDraft: '', boardQ: '' }); },
  pickBoardLedger(event) {
    const ledger = event.currentTarget.dataset.ledger;
    if (!['all', 'negotiating', 'signed'].includes(ledger) || !['customers', 'effective'].includes(this.data.boardMetric)) return;
    return this.applyBrokerFilters({ boardMetric: ledger === 'signed' ? 'effective' : 'customers',
      boardLedger: ledger === 'negotiating' ? 'negotiating' : 'all' });
  },
  applyBrokerFilters(patch) {
    if (this.data.view?.actor.role !== 'broker' || !this.data.isHome) return;
    this.setData({ ...patch, boardOffset: 0, boardExpanded: true });
    return this.loadSalesBoard(0);
  },
  boardPrevious() {
    const board = this.data.salesBoard;
    if (board && !this.data.boardLoading && board.offset > 0) {
      this.setData({ boardExpanded: true });
      return this.loadSalesBoard(Math.max(0, board.offset - board.limit));
    }
  },
  boardNext() {
    const board = this.data.salesBoard;
    if (board && !this.data.boardLoading && board.offset + board.limit < board.total) {
      this.setData({ boardExpanded: true });
      return this.loadSalesBoard(board.offset + board.limit);
    }
  },
  retryBoard() { return this.loadSalesBoard(); },
};

module.exports = { state, methods };
