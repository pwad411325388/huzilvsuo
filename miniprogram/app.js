App({
  globalData: { token: '', pendingPromos: [] },
  onLaunch(options = {}) {
    this.globalData.token = wx.getStorageSync('huzi-auth-token') || '';
    const pending = wx.getStorageSync('huzi-promo-codes');
    this.globalData.pendingPromos = Array.isArray(pending) ? pending : [];
    this.capturePromo(options.query);
  },
  onShow(options = {}) { this.capturePromo(options.query); },
  capturePromo(query = {}) {
    let code;
    try { code = decodeURIComponent(query.scene || query.promo || ''); }
    catch { return; }
    const pending = this.globalData.pendingPromos;
    if (!/^[a-z0-9_-]{1,32}$/i.test(code) || pending.includes(code)) return;
    this.savePromos([...pending, code]);
  },
  savePromos(codes) {
    this.globalData.pendingPromos = codes;
    wx.setStorageSync('huzi-promo-codes', codes);
  },
});
