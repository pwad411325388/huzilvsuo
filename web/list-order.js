// Shared by server readers and browser lists. Sort complete collections before
// pagination, and reuse the same comparator for on-screen rows and exports.
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });
const text = value => String(value ?? '').normalize('NFKC').trim();
const stableKey = row => text(row.id ?? row.key ?? row.entryKey ?? row.rowKey ?? row.username ?? row.number);
const nameOf = row => text(row.name ?? row.title ?? row.customer ?? row.username);
const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const customers = row => count(row.customerCount ?? row.customers ?? row.channelCustomers);
const records = row => count(row.recordCount ?? row.leads);
const statusOf = row => row.accountStatus ?? row.status ?? (row.username ? 'active' : 'pending');
const sourceStatus = row => row.sourceStatus ?? row.accountStatus ?? row.status ?? 'active';
const pendingKeys = new Map(['system_new', 'system_legacy', 'registry_unlinked'].map((key, index) => [key, index]));

export const orderLabels = {
  accounts: '正常账号在前，待开户其次，已注销在后；同组按姓名排序。',
  accountsRecent: '正常账号在前，待开户其次，已注销在后；同组按创建时间从新到旧排序，缺少日期的在最后。',
  accountsPending: '待开户在前，正常账号其次，已注销在后；同组按姓名排序。',
  sales: '正常销售在前，待开户其次，已注销在后；同组按客户档案数、登记条数从多到少排序。',
  sources: '有效来源在前，待开户其次，仅注销券商来源在后；同组按客户档案数、登记条数从多到少排序。',
  recent: '按登记日期从新到旧排序；缺少日期的记录在最后。',
  oldest: '按登记日期从旧到新排序；缺少日期的记录在最后。',
  pending: '新待分配在前，历史待核其次，历史待关联在后；各组优先处理登记时间较早的记录，无日期在最后。',
};

export function accountRank(status, pendingFirst = false) {
  const value = text(status).toLowerCase();
  if (['closed', 'inactive', '已注销', '已停用', '注销'].includes(value)) return 2;
  const active = ['active', 'effective', '正常', '已开户', '有效来源', '历史 / 客户来源'].includes(value);
  return active ? pendingFirst ? 1 : 0 : pendingFirst ? 0 : 1;
}

export function compareName(a, b) {
  return names.compare(nameOf(a), nameOf(b)) || stableKey(a).localeCompare(stableKey(b), 'en');
}

export function compareAccounts(a, b, pendingFirst = false) {
  return accountRank(statusOf(a), pendingFirst) - accountRank(statusOf(b), pendingFirst) || compareName(a, b);
}

export function compareSalesSummary(a, b) {
  return accountRank(statusOf(a)) - accountRank(statusOf(b)) || customers(b) - customers(a) || records(b) - records(a) || compareName(a, b);
}

export function compareSourceSummary(a, b) {
  return accountRank(sourceStatus(a)) - accountRank(sourceStatus(b)) || customers(b) - customers(a) || records(b) - records(a) || compareName(a, b);
}

function dateOf(row) {
  const key = ['registeredOn', 'date', 'createdOn', 'createdAt', 'openedOn', 'signedOn', 'updatedAt'].find(key => Object.hasOwn(row, key));
  const value = key ? row[key] : '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || value.length === 10 && new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

function compareDate(a, b, direction) {
  const first = dateOf(a), second = dateOf(b);
  if (first === null || second === null) return first === second ? compareName(a, b) : first === null ? 1 : -1;
  return direction * (first - second) || compareName(a, b);
}

export const compareRecent = (a, b) => compareDate(a, b, -1);
export const compareOldest = (a, b) => compareDate(a, b, 1);
export const comparePending = (a, b) => (pendingKeys.get(a.queue) ?? pendingKeys.size) - (pendingKeys.get(b.queue) ?? pendingKeys.size) || compareOldest(a, b);
