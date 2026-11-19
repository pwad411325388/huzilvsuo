const { request } = require('./client');

function state(role = 'sales') {
  return { salesBoard: null, boardSelected: null, boardPeriod: 'all', boardFrom: '', boardTo: '', boardRangeFrom: '', boardRangeTo: '', boardMetric: role === 'broker' ? 'customers' : 'channels',
    boardLoading: false, boardError: '', boardDateError: '', boardOffset: 0, boardPage: 1, boardPages: 1 };
}

const methods = {
  async loadSalesBoard(offset = this.data.boardOffset || 0) {
    const token = getApp().globalData.token;
    const role = this.data.view?.actor.role;
    if (!token || !['sales', 'broker'].includes(role) || (role === 'sales' && this.data.isHome) || this.boardVisible === false) return;
    if (this.boardToken !== token) {
      this.boardToken = token;
      this.setData(state(role));
      offset = 0;
    }
    const { boardPeriod, boardRangeFrom, boardRangeTo, boardMetric } = this.data;
    const sequence = this.boardSequence = (this.boardSequence || 0) + 1;
    this.setData({ boardLoading: true, boardError: '', salesBoard: null, boardSelected: null });
    const params = { period: boardPeriod, metric: boardMetric, offset };
    if (role === 'broker' && !this.data.isHome) Object.assign(params, { metric: 'customers', ledger: this.data.ledger === '已签约' ? 'signed' : 'negotiating' });
    if (boardPeriod === 'custom') Object.assign(params, { from: boardRangeFrom, to: boardRangeTo });
    const query = Object.keys(params).map(key => key + '=' + encodeURIComponent(params[key])).join('&');
    try {
      const board = await request('/' + role + '/board?' + query);
      if (sequence !== this.boardSequence || token !== getApp().globalData.token) return;
      if (!board || !Array.isArray(board.metrics) || !Array.isArray(board.items)
          || !board.metrics.some(item => item.key === board.selected)
          || !Number.isInteger(board.total) || board.total < 0 || !Number.isInteger(board.offset)
          || board.offset < 0 || !Number.isInteger(board.limit) || board.limit < 1) {
        throw new Error('统计数据暂未完整返回，请重试');
      }
      this.setData({ salesBoard: board, boardSelected: board.metrics.find(item => item.key === board.selected),
        boardLoading: false, boardMetric: board.selected, boardOffset: board.offset,
        boardPage: Math.floor(board.offset / board.limit) + 1,
        boardPages: Math.max(1, Math.ceil(board.total / board.limit)) });
    } catch (error) {
      if (sequence !== this.boardSequence || token !== getApp().globalData.token) return;
      this.setData({ boardLoading: false, boardError: error.message || '暂时无法加载统计' });
      if (error.status === 401) this.returnToLogin();
    }
  },
  pickBoardPeriod(event) {
    const period = event.currentTarget.dataset.period;
    if (!['all', 'month'].includes(period)) return;
    this.setData({ boardPeriod: period, boardDateError: '', boardOffset: 0 });
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
    this.setData({ boardPeriod: 'custom', boardRangeFrom: boardFrom, boardRangeTo: boardTo, boardDateError: '', boardOffset: 0 });
    return this.loadSalesBoard(0);
  },
  pickBoardMetric(event) {
    const key = event.currentTarget.dataset.key;
    const keys = this.data.view?.actor.role === 'broker' ? ['customers', 'ongoing', 'effective', 'closed', 'signings'] : ['channels', 'customers', 'effective', 'closed'];
    if (!keys.includes(key)) return;
    this.setData({ boardMetric: key, boardOffset: 0 });
    return this.loadSalesBoard(0);
  },
  boardPrevious() {
    const board = this.data.salesBoard;
    if (board && !this.data.boardLoading && board.offset > 0) return this.loadSalesBoard(Math.max(0, board.offset - board.limit));
  },
  boardNext() {
    const board = this.data.salesBoard;
    if (board && !this.data.boardLoading && board.offset + board.limit < board.total) return this.loadSalesBoard(board.offset + board.limit);
  },
  retryBoard() { return this.loadSalesBoard(); },
};

module.exports = { state, methods };
