const base = 'http://127.0.0.1:7101/api';

function request(path, input) {
  const token = getApp().globalData.token;
  return new Promise((resolve, reject) => {
    wx.request({
      url: base + path,
      method: input ? 'POST' : 'GET',
      data: input,
      header: token ? { Authorization: 'Bearer ' + token, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data);
        const error = new Error(response.data?.message || '请求失败');
        error.status = response.statusCode;
        reject(error);
      },
      fail: () => reject(new Error('无法连接本地服务，请确认服务已启动')),
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

module.exports = { request, saveToken, showLogin, capturePromos, referralToken, clearReferral };
