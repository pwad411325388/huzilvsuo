const { request, saveToken, capturePromos, referralToken, clearReferral } = require('../../client');

Page({
  data: { registering: false, recovering: false, changing: false, busy: false, error: '', notice: '' },
  async onShow() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      if (getApp().globalData.token) {
        const snapshot = await request('/view');
        if (snapshot.actor.passwordChangeRequired) this.setData({ changing: true });
        else wx.switchTab({ url: '/pages/home/index' });
      } else {
        await capturePromos();
      }
    } catch (error) {
      if (error.status === 401) { saveToken(''); this.setData({ changing: false }); }
      else this.setData({ error: error.message });
    } finally { this.setData({ busy: false }); }
  },
  toggle() { this.setData({ registering: !this.data.registering, error: '' }); },
  toggleRecovery() { if (!this.data.busy) this.setData({ recovering: !this.data.recovering, registering: false, error: '', notice: '' }); },
  async backToLogin() {
    if (this.data.busy) return;
    try { await request('/auth/logout', {}); } catch { /* The local credential is cleared even if the session expired. */ }
    saveToken('');
    this.setData({ changing: false, error: '', notice: '' });
  },
  async submit(event) {
    if (this.data.busy) return;
    const input = event.detail.value;
    if ((this.data.registering || this.data.recovering || this.data.changing) && input.password !== input.confirm) {
      this.setData({ error: '两次输入的密码不一致' });
      return;
    }
    this.setData({ busy: true, error: '' });
    try {
      if (this.data.recovering || this.data.changing) {
        await request(this.data.changing ? '/auth/change-password' : '/auth/recover', input);
        saveToken('');
        this.setData({ recovering: false, changing: false, notice: '密码已更新，请用新密码登录。旧登录和恢复码均已失效。' });
        return;
      }
      await capturePromos();
      const payload = this.data.registering ? { phone: input.phone, password: input.password } : { username: input.username, password: input.password };
      const session = await request(this.data.registering ? '/auth/register' : '/auth/login', {
        ...payload, platform: 'mini', referralToken: referralToken(),
      });
      saveToken(session.token);
      if (session.actor.role === 'investor' && !session.actor.passwordChangeRequired) clearReferral();
      if (session.actor.passwordChangeRequired) this.setData({ changing: true, notice: '' });
      else wx.switchTab({ url: '/pages/home/index' });
    } catch (error) {
      if (error.status === 401 && this.data.changing) { saveToken(''); this.setData({ changing: false }); }
      this.setData({ error: error.message });
    }
    finally { this.setData({ busy: false }); }
  },
});
