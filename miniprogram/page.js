const { request, showLogin, capturePromos, openProgress } = require('./client');
const salesBoard = require('./sales-board');
const userRecords = require('./user-records');
const periods = ['2020 年之前', '2020–2022 年', '2022–2024 年', '2024 年至今'];
const actions = {
  lead: ['/leads', '留资已提交'], cooperation: ['/cooperations', '已保存签约绑定'],
  name: ['/profile/name', '已保存显示名称'],
};

function makePage(isHome, isRecordsPage = false) {
  return {
    data: { ...salesBoard.state(), recordList: userRecords.state(!isHome), isHome, isRecordsPage, periods, period: '', signedOn: '', view: null, metric: 0,
      editingName: false, consultationOpen: false, consultationStarted: false, busy: false, notice: '', phoneInvalid: false, security: false, recoveryCode: '' },
    ...salesBoard.methods,
    ...userRecords.methods,
    onHide() {
      this.boardVisible = false;
      this.recordsVisible = false;
      this.recordsSequence = (this.recordsSequence || 0) + 1;
      this.updateRecords({ data: null, loading: false });
      this.boardSequence = (this.boardSequence || 0) + 1;
      this.viewSequence = (this.viewSequence || 0) + 1;
      this.workSequence = (this.workSequence || 0) + 1;
      this.setData({ busy: false, security: false, recoveryCode: '', salesBoard: null, boardLoading: false });
    },
    onLoad(query = {}) {
      if (!isRecordsPage) getApp().capturePromo?.(query);
      else {
        this.initialRecords = { ...userRecords.state(), customerId: query.customerId || '', signingCustomer: query.signingCustomer === '1' && !!query.customerId };
        if (query.presentation === 'home') this.initialRecords.presentation = 'home';
        if (['all', 'month', 'custom'].includes(query.period)) this.initialRecords.period = query.period;
        if (query.period === 'custom') Object.assign(this.initialRecords, { from: query.from || '', to: query.to || '', rangeFrom: query.from || '', rangeTo: query.to || '' });
      }
    },
    onUnload() { this.onHide(); },
    onTabItemTap() {
      if (isHome && this.data.view?.actor.role === 'sales' && this.data.recordList.expanded) {
        this.updateRecords({ expanded: false });
      }
    },
    onShow() {
      this.boardVisible = true;
      this.recordsVisible = true;
      const token = getApp().globalData.token;
      if (!token) return this.returnToLogin();
      if (this.visibleToken !== token) {
        this.workSequence = (this.workSequence || 0) + 1;
        this.boardSequence = (this.boardSequence || 0) + 1;
        this.boardToken = '';
        const recordList = !this.visibleToken && this.initialRecords ? this.initialRecords : userRecords.state(!isHome);
        this.recordsSequence = (this.recordsSequence || 0) + 1;
        this.setData({ ...salesBoard.state(), recordList, view: null, busy: false, consultationOpen: false, consultationStarted: false, phoneInvalid: false, period: '', security: false, recoveryCode: '' });
        this.visibleToken = token;
      }
      return this.once(async () => {
        const snapshot = await this.fetchView();
        if (!isRecordsPage && snapshot?.actor.role === 'investor') await capturePromos();
      });
    },
    returnToLogin() {
      this.workSequence = (this.workSequence || 0) + 1;
      this.viewSequence = (this.viewSequence || 0) + 1;
      this.boardSequence = (this.boardSequence || 0) + 1;
      this.boardToken = '';
      this.recordsSequence = (this.recordsSequence || 0) + 1;
      this.setData({ ...salesBoard.state(), recordList: userRecords.state(!isHome) });
      this.setData({ view: null, busy: false, editingName: false, consultationOpen: false, consultationStarted: false, phoneInvalid: false, period: '', notice: '', security: false, recoveryCode: '' });
      showLogin();
    },
    async once(work) {
      if (this.data.busy) return;
      const sequence = this.workSequence = (this.workSequence || 0) + 1;
      this.setData({ busy: true, notice: '' });
      try { await work(); }
      catch (error) {
        if (sequence !== this.workSequence) return;
        if (error.status === 401) this.returnToLogin();
        else this.setData({ notice: error.message });
      } finally { if (sequence === this.workSequence) this.setData({ busy: false }); }
    },
    async fetchView() {
      const token = getApp().globalData.token;
      const sequence = this.viewSequence = (this.viewSequence || 0) + 1;
      let snapshot;
      try { snapshot = await request('/view'); }
      catch (error) { if (sequence !== this.viewSequence || token !== getApp().globalData.token) return null; throw error; }
      if (sequence !== this.viewSequence || token !== getApp().globalData.token) return null;
      if (snapshot.actor.passwordChangeRequired) {
        wx.reLaunch({ url: '/pages/login/index' });
        return snapshot;
      }
      if (!['investor', 'broker', 'sales'].includes(snapshot.actor.role)) {
        const error = new Error('请使用小程序业务账号');
        error.status = 401;
        throw error;
      }
      const sameActor = this.data.view?.actor.id === snapshot.actor.id && this.data.view?.actor.role === snapshot.actor.role;
      if (isRecordsPage && !sameActor) {
        const title = snapshot.actor.role !== 'investor' ? '客户与股票记录'
          : this.data.recordList.presentation === 'home' ? '全部记录' : '我的股票登记';
        wx.setNavigationBarTitle?.({ title });
      }
      // Broker lists load through the paginated board and record endpoints.
      const view = snapshot.actor.role === 'broker' ? { actor: snapshot.actor, broker: snapshot.broker, today: snapshot.today } : snapshot;
      this.setData({ view, signedOn: this.data.signedOn || snapshot.today, metric: sameActor ? this.data.metric : 0 });
      if (!isRecordsPage && (snapshot.actor.role === 'broker' && isHome || snapshot.actor.role === 'sales' && !isHome)) await this.loadSalesBoard();
      if (isRecordsPage || snapshot.actor.role === 'sales' && isHome || snapshot.actor.role === 'investor' && !isHome) await this.loadRecords();
      return snapshot;
    },
    logout() {
      return this.once(async () => {
        await request('/auth/logout', {});
        this.returnToLogin();
      });
    },
    toggleName() { this.setData({ editingName: !this.data.editingName, notice: '' }); },
    toggleConsultation() { this.setData({ consultationStarted: true, consultationOpen: !this.data.consultationOpen }); },
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
    openProgress,
    copyCode() {
      const code = this.data.view?.broker?.code;
      if (code) wx.setClipboardData({ data: code });
    },
    submit(event) {
      const { type } = event.currentTarget.dataset;
      const action = actions[type];
      if (!Array.isArray(action)) return;
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
      return this.once(async () => {
        const [path, notice] = action;
        await request(path, input);
        await this.fetchView();
        if (type === 'lead') {
          this.setData({ consultationOpen: false, consultationStarted: false, period: '', phoneInvalid: false });
          wx.switchTab({ url: '/pages/mine/index' });
        }
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
