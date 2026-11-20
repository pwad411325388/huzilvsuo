const { request } = require('./client');

function state(expanded = true) {
  return { draft: '', q: '', period: 'all', from: '', to: '', rangeFrom: '', rangeTo: '', ledger: 'all', signingCustomer: false,
    customerId: '', offset: 0, data: null, loading: false, error: '', dateError: '', datesOpen: false, expanded, page: 1, pages: 1 };
}

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

const methods = {
  updateRecords(patch) { this.setData({ recordList: { ...this.data.recordList, ...patch } }); },
  toggleRecordResults() {
    const list = this.data.recordList;
    this.updateRecords({ expanded: !list.expanded });
    if (!list.expanded && !list.data && !list.loading) return this.loadRecords();
  },
  applyRecordFilter(patch) {
    this.updateRecords({ ...patch, offset: 0, expanded: true });
    return this.loadRecords(0);
  },
  toggleDateFields() { this.updateRecords({ datesOpen: !this.data.recordList.datesOpen }); },
  async loadRecords(offset = this.data.recordList.offset) {
    const token = getApp().globalData.token;
    const actor = this.data.view?.actor;
    if (!token || !['investor', 'sales', 'broker'].includes(actor?.role) || this.recordsVisible === false) return;
    if (actor.role === 'broker' && !this.data.isRecordsPage) return;
    const list = this.data.recordList;
    const params = { q: list.q, period: list.period, offset, limit: 5 };
    if (actor.role === 'investor' && list.presentation === 'home') params.presentation = 'home';
    if (actor.role === 'broker') params.ledger = list.ledger;
    if (list.customerId) params.customerId = list.customerId;
    if (list.period === 'custom') Object.assign(params, { from: list.rangeFrom, to: list.rangeTo });
    const sequence = this.recordsSequence = (this.recordsSequence || 0) + 1;
    const owner = actor.role + ':' + actor.id;
    const current = () => sequence === this.recordsSequence && token === getApp().globalData.token
      && owner === this.data.view?.actor.role + ':' + this.data.view?.actor.id && this.recordsVisible !== false;
    this.updateRecords({ loading: true, error: '', data: null });
    try {
      const query = Object.keys(params).map(key => key + '=' + encodeURIComponent(params[key])).join('&');
      const result = await request('/records?' + query);
      if (!current()) return;
      if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0
          || !Number.isInteger(result.offset) || result.offset < 0 || result.limit !== params.limit || result.items.length > result.limit) {
        throw new Error('客户与股票记录暂未完整返回，请重试');
      }
      if (result.offset && result.offset >= result.total) return this.loadRecords(Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit);
      this.updateRecords({ data: result, loading: false, offset: result.offset,
        page: Math.floor(result.offset / result.limit) + 1, pages: Math.max(1, Math.ceil(result.total / result.limit)) });
    } catch (error) {
      if (!current()) return;
      this.updateRecords({ loading: false, error: error.message || '暂时无法读取记录' });
      if (error.status === 401) this.returnToLogin();
    }
  },
  recordsInput(event) { this.updateRecords({ draft: event.detail.value }); },
  recordsSearch() { return this.applyRecordFilter({ q: this.data.recordList.draft.trim() }); },
  recordsReset() { return this.applyRecordFilter({ draft: '', q: '' }); },
  recordsAllCustomers() { return this.applyRecordFilter({ customerId: '', signingCustomer: false }); },
  recordsPickPeriod(event) {
    const period = event.currentTarget.dataset.period;
    if (!['all', 'month'].includes(period)) return;
    return this.applyRecordFilter({ period, dateError: '' });
  },
  recordsPickDate(event) {
    const field = event.currentTarget.dataset.field;
    if (field === 'from' || field === 'to') this.updateRecords({ [field]: event.detail.value, dateError: '' });
  },
  recordsApplyDates() {
    const { from, to } = this.data.recordList;
    if (!validDate(from) || !validDate(to)) { this.updateRecords({ dateError: '请选择有效的起止日期' }); return; }
    if (from > to) { this.updateRecords({ dateError: '开始日期须早于或等于结束日期' }); return; }
    if (this.data.view?.today && to > this.data.view.today) { this.updateRecords({ dateError: '日期不能晚于今天' }); return; }
    return this.applyRecordFilter({ period: 'custom', rangeFrom: from, rangeTo: to, dateError: '' });
  },
  recordsPickLedger(event) {
    const ledger = event.currentTarget.dataset.ledger;
    if (this.data.view?.actor.role !== 'broker' || !['all', 'negotiating', 'signed'].includes(ledger)) return;
    return this.applyRecordFilter({ ledger });
  },
  recordsPrevious() {
    const { data, loading } = this.data.recordList;
    if (data && !loading && data.offset > 0) {
      this.updateRecords({ expanded: true });
      return this.loadRecords(Math.max(0, data.offset - data.limit));
    }
  },
  recordsNext() {
    const { data, loading } = this.data.recordList;
    if (data && !loading && data.offset + data.limit < data.total) {
      this.updateRecords({ expanded: true });
      return this.loadRecords(data.offset + data.limit);
    }
  },
  retryRecords() { return this.loadRecords(); },
  openCustomerRecords(event) {
    const dataset = event.currentTarget.dataset;
    const customerId = dataset.customerId || '';
    const params = {};
    if (customerId) params.customerId = customerId;
    const signingCustomer = dataset.board && customerId && this.data.view?.actor.role === 'broker' && this.data.boardMetric === 'signings';
    if (signingCustomer) Object.assign(params, { period: 'all', signingCustomer: '1' });
    else if (dataset.board) {
      params.period = this.data.boardPeriod;
      if (params.period === 'custom') Object.assign(params, { from: this.data.boardRangeFrom, to: this.data.boardRangeTo });
    }
    const query = Object.keys(params).map(key => key + '=' + encodeURIComponent(params[key])).join('&');
    wx.navigateTo({ url: '/pages/registry/index' + (query ? '?' + query : '') });
  },
};

module.exports = { state, methods };
