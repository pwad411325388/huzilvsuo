const { request, showLogin, openProgress } = require('../../client');

Page({
  data: { detail: null, loading: true, notice: '', retryable: false },
  onLoad({ kind, id }) {
    if (['lead', 'case', 'registry'].includes(kind) && typeof id === 'string' && id) {
      this.record = { kind, id };
    }
  },
  async onShow() {
    const token = getApp().globalData.token;
    if (!token) return showLogin();
    if (!this.record) {
      this.setData({ loading: false, detail: null, notice: '请选择一条具体记录查看进度。', retryable: false });
      return;
    }
    const sequence = this.sequence = (this.sequence || 0) + 1;
    this.setData({ loading: true, detail: null, notice: '', retryable: false });
    try {
      const { kind, id } = this.record;
      const detail = await request('/progress?kind=' + kind + '&id=' + encodeURIComponent(id));
      if (sequence !== this.sequence || token !== getApp().globalData.token) return;
      const { current } = detail;
      const steps = detail.steps ?? (current ? [{ node: current.node, label: current.label, status: 'current' }] : []);
      const signing = detail.contractNumber && current?.stage === 'intake' && steps.find(step =>
        step.status !== 'reference' && (step.node === 'signed' || step.node === 'signed_waiting_filing'));
      this.setData({ loading: false, detail: { ...detail, steps, contractStep: signing ? signing.node : '',
        hasReference: steps.some(step => step.status === 'reference') } });
    } catch (error) {
      if (sequence !== this.sequence || token !== getApp().globalData.token) return;
      if (error.status === 401) return showLogin();
      const retryable = !error.status || error.status >= 500;
      this.setData({ loading: false, detail: null, notice: error.message || '暂时无法读取案件进度。', retryable });
    }
  },
  onHide() {
    this.sequence = (this.sequence || 0) + 1;
    this.setData({ loading: true, detail: null, notice: '', retryable: false });
  },
  onUnload() { this.sequence = (this.sequence || 0) + 1; },
  retry() { return this.onShow(); },
  openProgress,
});
