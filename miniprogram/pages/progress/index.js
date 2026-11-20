const { request, showLogin, openProgress } = require('../../client');

const pendingReview = {
  current: { stage: 'unknown', node: 'unknown', stageLabel: '案件进度', label: '待核对', uncertain: true, hideDate: true },
  notice: '当前资料尚未明确具体阶段，请以律所确认结果为准。',
};

function displayedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '日期待补充';
  const utc = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) return '日期待补充';
  return value.replace(/-/g, '.');
}

function timelineStep(step, current, formal) {
  const isCurrent = step.status === 'current';
  const uncertain = step.uncertain === true || (isCurrent && current.uncertain === true);
  const stageLabel = step.stageLabel || (isCurrent || step.stage === current.stage ? current.stageLabel : '');
  const pendingRoute = step.node === 'pending_route';
  const title = pendingRoute ? step.stageLabel || '后续进度' : stageLabel || step.label;
  return {
    ...step, key: (step.stage || current.stage) + ':' + step.node, title, uncertain,
    statusLabel: pendingRoute && formal ? '待确认' : title === step.label ? '' : step.label,
    dateText: isCurrent && !uncertain && !step.hideDate ? displayedDate(step.date) : '',
  };
}

function timelineRoute(current, supplied) {
  if (!current) return [];
  const waitingForFiling = current.stage === 'intake' && current.node === 'signed_waiting_filing';
  const hasActive = waitingForFiling && supplied.some(step => step?.status === 'active');
  const labeled = step => typeof step.label === 'string' && step.label.trim() !== '';
  const matched = supplied.find(step => step?.status === 'current' && step.node === current.node
    && (hasActive ? step.stage === current.stage && labeled(step) : !step.stage || step.stage === current.stage));
  const route = [matched || { ...current, status: 'current' }];
  if (current.uncertain || route[0].uncertain || current.stage === 'closure' && current.node === 'closed') return route;
  if (hasActive && matched) {
    const preparing = supplied.find(step => step?.status === 'active' && step.stage === 'filing' && step.node === 'preparing' && labeled(step));
    const submitted = supplied.find(step => step?.status === 'next' && step.stage === 'filing' && step.node === 'submitted' && labeled(step));
    if (preparing && submitted) return [matched, preparing, submitted];
  }
  const next = supplied.find(step => step?.status === 'next' && step.label
    && (step.stage !== route[0].stage || step.node !== route[0].node)
    && !(hasActive && step.stage === 'filing' && step.node === 'submitted'));
  if (next) route.push(next);
  return route;
}

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
      const projection = detail.current ? detail : detail.displayProgress?.current?.label ? detail.displayProgress : pendingReview;
      const supplied = Array.isArray(projection.steps) ? projection.steps : [];
      const steps = timelineRoute(projection.current, supplied).map(step => timelineStep(step, projection.current, !!detail.current));
      const currentStep = steps[0];
      const signing = detail.contractNumber && detail.current?.stage === 'intake' && currentStep
        && (currentStep.node === 'signed' || currentStep.node === 'signed_waiting_filing');
      const progressNotice = detail.current ? '' : projection.notice || (currentStep.uncertain ? pendingReview.notice : '');
      this.setData({ loading: false, detail: { ...detail, steps, progressNotice, contractStep: signing ? currentStep.node : '' } });
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
