const { request, showLogin, openProgress } = require('../../client');

Page({
  data: { draft: '', query: '', items: [], total: 0, offset: 0, limit: 20, loading: true, notice: '' },
  onShow() {
    const token = getApp().globalData.token;
    if (!token) return showLogin();
    if (this.sessionToken !== token) this.setData({ draft: '', query: '', offset: 0 });
    this.sessionToken = token;
    return this.load(this.data.query, this.data.offset);
  },
  onHide() {
    this.sequence = (this.sequence || 0) + 1;
    this.setData({ items: [], total: 0 });
  },
  onUnload() { this.sequence = (this.sequence || 0) + 1; },
  async load(query, offset) {
    const sequence = this.sequence = (this.sequence || 0) + 1;
    this.setData({ loading: true, notice: '', items: [], total: 0, query, offset });
    try {
      const result = await request('/registry?q=' + encodeURIComponent(query) + '&offset=' + offset);
      if (this.sequence !== sequence || this.sessionToken !== getApp().globalData.token) return;
      if (offset && offset >= result.total) return this.load(query, Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit);
      this.setData({ items: result.items, total: result.total, offset: result.offset, limit: result.limit });
    } catch (error) {
      if (this.sequence !== sequence || this.sessionToken !== getApp().globalData.token) return;
      if (error.status === 401) return showLogin();
      this.setData({ notice: error.message || '暂时无法读取登记记录' });
    } finally {
      if (this.sequence === sequence) this.setData({ loading: false });
    }
  },
  input(e) { this.setData({ draft: e.detail.value }); },
  openProgress,
  search() { return this.load(this.data.draft.trim(), 0); },
  reset() { this.setData({ draft: '' }); return this.load('', 0); },
  previous() { return this.load(this.data.query, Math.max(0, this.data.offset - this.data.limit)); },
  next() { return this.load(this.data.query, this.data.offset + this.data.limit); },
});
