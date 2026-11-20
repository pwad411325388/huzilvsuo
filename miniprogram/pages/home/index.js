const home = require('../../page')(true);

Page({
  ...home,
  data: { ...home.data, cooperationFocused: false },
  onHide() {
    this.homeActionSequence = (this.homeActionSequence || 0) + 1;
    if (this.data.cooperationFocused) this.setData({ cooperationFocused: false });
    home.onHide.call(this);
  },
  loadSalesBoard(offset) {
    this.homeBoardRequest = home.loadSalesBoard.call(this, offset);
    return this.homeBoardRequest;
  },
  blurCooperation() {
    this.setData({ cooperationFocused: false });
  },
  async openHomeAction() {
    const actor = this.data.view?.actor;
    const token = getApp().globalData.token;
    const sequence = this.homeActionSequence = (this.homeActionSequence || 0) + 1;
    const onSamePage = () => this.homeActionSequence === sequence && this.boardVisible !== false && token === getApp().globalData.token
      && this.data.view?.actor.id === actor?.id && this.data.view?.actor.role === actor?.role;
    if (actor?.role === 'sales') {
      wx.pageScrollTo({ selector: '#home-cooperation', duration: 0, success: () => {
        if (onSamePage()) this.setData({ cooperationFocused: true });
      } });
      return;
    }
    if (actor?.role !== 'broker') return;
    if (this.data.boardMetric !== 'customers') {
      await this.applyBrokerFilters({ boardMetric: 'customers', boardLedger: 'all' });
    } else {
      this.setData({ boardExpanded: true });
      if (this.data.boardLoading) await this.homeBoardRequest;
      else if (!this.data.salesBoard) await this.loadSalesBoard();
    }
    wx.nextTick(() => {
      if (onSamePage() && this.data.salesBoard?.selected === 'customers' && this.data.boardExpanded) {
        wx.pageScrollTo({ selector: '#home-board-details', duration: 200 });
      }
    });
  },
});
