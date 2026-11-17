const { request, showLogin, capturePromos } = require('./client');
const periods = ['2020 年之前', '2020–2022 年', '2022–2024 年', '2024 年至今'];
const actions = {
  lead: ['/leads', '留资已提交'], cooperation: ['/cooperations', '已保存签约绑定'],
  followup: ['/followups', '已保存跟进记录'], name: ['/profile/name', '已保存显示名称'],
};

function makePage(isHome) {
  return {
    data: { isHome, periods, period: '', signedOn: '', view: null, metric: 0, ledger: '洽谈中', selectedLead: null,
      ledgerRecords: [], assignedRecords: [], followFilter: '待跟进', editingName: false, busy: false, notice: '', phoneInvalid: false, security: false, recoveryCode: '' },
    onHide() { this.setData({ security: false, recoveryCode: '' }); },
    onLoad(query) { getApp().capturePromo(query); },
    onShow() {
      if (!getApp().globalData.token) return this.returnToLogin();
      return this.once(async () => {
        const snapshot = await this.fetchView();
        if (snapshot.actor.role === 'investor' && await capturePromos()) {
          this.setData({ notice: '已记录首次推广来源' });
        }
      });
    },
    returnToLogin() {
      this.setData({ view: null, selectedLead: null, editingName: false, ledgerRecords: [], assignedRecords: [], followFilter: '待跟进', notice: '', security: false, recoveryCode: '' });
      showLogin();
    },
    async once(work) {
      if (this.data.busy) return;
      this.setData({ busy: true, notice: '' });
      try { await work(); }
      catch (error) {
        if (error.status === 401) this.returnToLogin();
        else this.setData({ notice: error.message });
      } finally { this.setData({ busy: false }); }
    },
    async fetchView() {
      const snapshot = await request('/view');
      if (snapshot.actor.passwordChangeRequired) {
        wx.reLaunch({ url: '/pages/login/index' });
        return snapshot;
      }
      if (!['investor', 'broker', 'sales'].includes(snapshot.actor.role)) {
        const error = new Error('请使用小程序业务账号');
        error.status = 401;
        throw error;
      }
      const selected = this.data.selectedLead;
      const sameActor = this.data.view?.actor.id === snapshot.actor.id && this.data.view?.actor.role === snapshot.actor.role;
      const ledger = sameActor ? this.data.ledger : '洽谈中';
      const followFilter = sameActor ? this.data.followFilter : '待跟进';
      this.setData({ view: snapshot, signedOn: this.data.signedOn || snapshot.today, metric: sameActor ? this.data.metric : 0,
        selectedLead: sameActor && selected ? snapshot.leads?.find(item => item.id === selected.id) || null : null,
        ledger, ledgerRecords: (snapshot.ledger || []).filter(item => item.status === ledger), followFilter,
        assignedRecords: (snapshot.assignedLeads || []).filter(item => !followFilter || item.status === followFilter) });
      return snapshot;
    },
    logout() {
      return this.once(async () => {
        await request('/auth/logout', {});
        this.returnToLogin();
      });
    },
    toggleName() { this.setData({ editingName: !this.data.editingName, notice: '' }); },
    toggleSecurity() { this.setData({ security: !this.data.security, recoveryCode: '', notice: '' }); },
    copyRecoveryCode() { if (this.data.recoveryCode) wx.setClipboardData({ data: this.data.recoveryCode }); },
    submitSecurity(event) {
      const input = event.detail.value;
      const type = event.currentTarget.dataset.type;
      if (type === 'change' && input.password !== input.confirm) {
        this.setData({ notice: '两次输入的密码不一致' });
        return;
      }
      return this.once(async () => {
        if (type === 'change') {
          await request('/auth/change-password', input);
          this.returnToLogin();
          wx.showToast({ title: '密码已修改，请重新登录', icon: 'none' });
        } else {
          const result = await request('/auth/recovery-code', input);
          this.setData({ recoveryCode: result.code, notice: '请保存恢复码，关闭后无法再次查看。' });
        }
      });
    },
    pickDate(event) { this.setData({ signedOn: event.detail.value }); },
    pickPeriod(event) { this.setData({ period: periods[event.detail.value] }); },
    clearPhoneError() {
      if (this.data.phoneInvalid) this.setData({ phoneInvalid: false });
    },
    pickMetric(event) { this.setData({ metric: Number(event.currentTarget.dataset.index) }); },
    pickFollow(event) {
      const followFilter = event.currentTarget.dataset.status;
      this.setData({ followFilter, assignedRecords: this.data.view.assignedLeads.filter(item => !followFilter || item.status === followFilter) });
    },
    pickLedger(event) {
      const ledger = event.currentTarget.dataset.status;
      this.setData({ ledger, ledgerRecords: this.data.view.ledger.filter(item => item.status === ledger) });
    },
    showLead(event) {
      const id = event.currentTarget.dataset.id;
      this.setData({ selectedLead: this.data.view.leads.find(item => item.id === id) || null });
    },
    closeLead() { this.setData({ selectedLead: null }); },
    copyCode() { wx.setClipboardData({ data: this.data.view.broker.code }); },
    submit(event) {
      const { type, id, version } = event.currentTarget.dataset;
      const input = event.detail.value;
      if (type === 'lead') {
        input.phone = String(input.phone ?? '').trim();
        if (!/^1\d{10}$/.test(input.phone)) {
          this.setData({ notice: '', phoneInvalid: true });
          return;
        }
        input.period = this.data.period;
        input.consent = Array.isArray(input.consent) && input.consent.length > 0;
      }
      if (type === 'cooperation') input.signedOn = this.data.signedOn;
      if (type === 'followup') { input.leadId = id; input.version = version; }
      return this.once(async () => {
        const [path, notice] = actions[type];
        await request(path, input);
        await this.fetchView();
        if (type === 'lead') wx.switchTab({ url: '/pages/mine/index' });
        if (type === 'name') this.setData({ editingName: false });
        this.setData({ notice });
      });
    },
    onShareAppMessage() {
      const broker = this.data.view?.broker;
      const query = broker ? '?promo=' + encodeURIComponent(broker.code) : '';
      return { title: '股民索赔宝 · 沪紫律师事务所', path: '/pages/home/index' + query };
    },
  };
}

module.exports = makePage;
