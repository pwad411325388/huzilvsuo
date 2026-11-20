const networkConfig = require('./network-config');

function apiEndpoint() {
  const base = String(networkConfig.apiBase || '').trim().replace(/\/$/, '');
  // WeChat's native JS runtime does not require a browser URL implementation.
  const match = /^(https?):\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?((?:\/[a-z0-9._~-]+)*)$/i.exec(base);
  const invalid = () => new Error('服务地址配置无效，请检查 network-config.js 中的 apiBase。');
  if (!match) throw invalid();
  const [, scheme, hostname, port, path] = match;
  const host = hostname.toLowerCase();
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split('.').every(part =>
    /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  const domain = host.length <= 253 && host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
    && /^[a-z][a-z\d-]*$/.test(host.split('.').pop());
  if ((!domain && !ipv4) || (port && (Number(port) < 1 || Number(port) > 65535)) || path.split('/').some(part => part === '.' || part === '..')) throw invalid();

  let version;
  try { version = wx.getAccountInfoSync().miniProgram.envVersion; } catch { /* Apply release rules when the version is unavailable. */ }
  const debugging = version === 'develop' || version === 'trial';
  const localName = !host.includes('.') || /(?:^|\.)(?:localhost|local|lan|internal|localdomain|home\.arpa)$/.test(host);
  if (!debugging && (scheme.toLowerCase() !== 'https' || !domain || localName)) {
    throw new Error('正式版需要配置公网 HTTPS 服务域名，请联系管理员。');
  }
  return { base, debugging, loopback: /(?:^|\.)localhost$/.test(host) || /^127\./.test(host) || host === '0.0.0.0' };
}

function connectionMessage(endpoint) {
  if (!endpoint.debugging) return '无法连接服务，请检查手机网络后重试。';
  const health = endpoint.base + '/health';
  if (endpoint.loopback) return '当前使用电脑本机地址，电脑可访问 ' + health + ' 检查服务。请让手机和电脑连接同一 Wi-Fi，在电脑运行「启动真机调试.cmd」，然后重新编译并扫码真机调试。';
  return '无法连接服务。请用手机浏览器打开 ' + health + ' 检查连接。本地调试时，请让手机和电脑连接同一 Wi-Fi，在电脑运行「启动真机调试.cmd」，然后重新编译并扫码真机调试。';
}

function request(path, input) {
  return new Promise((resolve, reject) => {
    const endpoint = apiEndpoint();
    const token = getApp().globalData.token;
    wx.request({
      url: endpoint.base + path,
      method: input ? 'POST' : 'GET',
      data: input,
      header: token ? { Authorization: 'Bearer ' + token, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data);
        const error = new Error(response.data?.message || '请求失败');
        error.status = response.statusCode;
        reject(error);
      },
      fail: () => reject(new Error(connectionMessage(endpoint))),
    });
  });
}

function saveToken(token) {
  getApp().globalData.token = token;
  if (token) wx.setStorageSync('huzi-auth-token', token);
  else wx.removeStorageSync('huzi-auth-token');
}

function showLogin() {
  saveToken('');
  wx.reLaunch({ url: '/pages/login/index' });
}

function openProgress(event) {
  const { kind, id } = event.currentTarget.dataset;
  if (!['lead', 'case', 'registry'].includes(kind) || !id) return;
  wx.navigateTo({ url: '/pages/progress/index?kind=' + kind + '&id=' + encodeURIComponent(id) });
}

const referralKey = 'huzi-promo-session';
const referralToken = () => wx.getStorageSync(referralKey) || '';

function clearReferral() { wx.removeStorageSync(referralKey); }

async function capturePromos() {
  const app = getApp();
  let first = false;
  while (app.globalData.pendingPromos.length) {
    const [code] = app.globalData.pendingPromos;
    try {
      const result = await request('/referral/capture', { code, platform: 'mini', referralToken: referralToken() });
      if (result.referralToken) wx.setStorageSync(referralKey, result.referralToken);
      first = first || result.recorded;
    } catch (error) {
      if (![400, 404].includes(error.status)) throw error;
    }
    app.savePromos(app.globalData.pendingPromos.filter(item => item !== code));
  }
  return first;
}

module.exports = { request, saveToken, showLogin, capturePromos, referralToken, clearReferral, openProgress };
