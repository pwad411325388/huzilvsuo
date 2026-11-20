import { createHash } from 'node:crypto';
import { classifyCase } from './data-semantics.mjs';

const limit = 20;
const fields = `e.entry_key AS entryKey,e.source_row AS sourceRow,e.customer,e.phone,e.sales,
  e.stock_name AS stockName,e.stock_code AS stockCode,e.source,e.registered_on AS registeredOn,
  e.filed_on AS filedOn,e.stage`;
const searchColumns = ['customer', 'phone', 'sales', 'stock_name', 'stock_code'];
const unknownLabel = /^(?:[\s/—–-]+|未知|不详|未登记|无|待定|未分配|待分配|未标注|无销售|公海|未知销售|待确认|待核对|无名|销售|姓名|股民姓名待核对)$/;
const groupMatch = {
  sales: "l.type = 'sales' AND l.source_name = e.sales AND l.source_phone = ''",
  investor: "l.type = 'investor' AND l.source_name = e.customer AND l.source_phone = e.phone AND e.customer <> '股民姓名待核对'",
};
const rowKey = key => createHash('sha256').update(key).digest('hex');

export function createRegistry(db, { requireValue, transaction, audit }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const imported = () => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_entries'");
  db.function('registry_public_key', { deterministic: true }, rowKey);
  db.function('registry_sort_date', { deterministic: true }, value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
  });
  db.exec(`CREATE TABLE IF NOT EXISTS registry_links(
    type TEXT NOT NULL CHECK(type IN ('investor','sales')), source_name TEXT NOT NULL, source_phone TEXT NOT NULL,
    identity_id INTEGER NOT NULL REFERENCES identities(id),
    PRIMARY KEY(type,source_name,source_phone)
  );
  CREATE INDEX IF NOT EXISTS registry_links_identity ON registry_links(identity_id,type);`);

  function authorize(actor, roles) {
    requireValue(roles.includes(actor?.role), '当前账号无权访问登记台账', 403);
    requireValue(!actor.passwordChangeRequired, '请先设置新的个人密码', 403);
  }

  function pagination({ q = '', offset = '0' }) {
    requireValue(typeof q === 'string' && q.length <= 100, '查询内容最多 100 字');
    requireValue(/^\d+$/.test(String(offset)) && Number.isSafeInteger(Number(offset)), '分页参数无效');
    return { q: q.trim(), offset: Number(offset) };
  }

  function currentLink(type, name, phone) {
    return one(`SELECT i.id AS identityId,i.username,i.name FROM registry_links l
      JOIN identities i ON i.id=l.identity_id WHERE l.type=? AND l.source_name=? AND l.source_phone=?`,
    type, name, phone) || null;
  }

  function accountScope(role) {
    return ` JOIN registry_links l ON ${groupMatch[role]}
      JOIN identities i ON i.id=l.identity_id AND i.role=? AND i.subjectId=? AND i.status='active'`;
  }

  function progressRecord(actor, key, projectionRole) {
    authorize(actor, projectionRole ? ['admin'] : ['investor', 'sales']);
    requireValue(!projectionRole || ['investor','sales'].includes(projectionRole),'预览角色无效');
    const role = projectionRole || actor.role;
    if (!imported() || !/^[a-f0-9]{64}$/.test(key)) return null;
    const columns = new Set(all('PRAGMA table_info(registry_entries)').map(col => col.name));
    const newer = ['progress_stage', 'progress_node'];
    if (role === 'sales') newer.push('contract_number');
    const extras = newer.filter(col => columns.has(col)).map(col => ',e.' + col).join('');
    return one(`SELECT e.entry_key AS internalId,e.customer,e.stock_name AS stockName,e.stock_code AS stockCode,
      e.stage AS sourceStatus,e.filed_on AS filedOn,e.registered_on AS registeredOn${extras}
      FROM registry_entries e ${projectionRole ? '' : accountScope(role)}
      WHERE registry_public_key(e.entry_key)=?`, ...(projectionRole ? [key] : [role, actor.id, key]));
  }

  function list(actor, input, pageSize = limit) {
    authorize(actor, ['admin', 'sales', 'investor']);
    const { q, offset } = pagination(input);
    const response = { items: [], total: 0, limit: pageSize, offset,
      orderLabel: '按材料登记日期从新到旧；同日按原表行号、登记键排序，缺少日期的记录在最后。' };
    if (actor.role === 'admin') Object.assign(response, { sourceName: '', importedAt: '' });
    if (!imported()) return response;
    if (actor.role === 'admin') {
      const meta = Object.fromEntries(all("SELECT key,value FROM registry_meta WHERE key IN ('source_name','imported_at')").map(row => [row.key, row.value]));
      response.sourceName = meta.source_name || '';
      response.importedAt = meta.imported_at || '';
    }
    const args = [];
    const columns = new Set(all('PRAGMA table_info(registry_entries)').map(col => col.name));
    const extra = name => columns.has(name) ? `e.${name}` : "''";
    const snapshots = !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_record_progress'");
    const progressFields = snapshots
      ? `,p.record_id AS hasSnapshot,COALESCE(p.stage,${extra('progress_stage')}) AS progressStage,COALESCE(p.node,${extra('progress_node')}) AS progressNode`
      : `,NULL AS hasSnapshot,${extra('progress_stage')} AS progressStage,${extra('progress_node')} AS progressNode`;
    let source = 'FROM registry_entries e' + (snapshots ? " LEFT JOIN company_record_progress p ON p.kind='registry' AND p.record_id=e.entry_key" : '');
    if (actor.role !== 'admin') {
      source += accountScope(actor.role);
      args.push(actor.role, actor.id);
    }
    if (q) {
      source += ` WHERE (${searchColumns.map(column => `instr(lower(e.${column}),lower(?))>0`).join(' OR ')})`;
      args.push(...searchColumns.map(() => q));
    }
    response.total = one(`SELECT count(*) AS n ${source}`, ...args).n;
    response.items = all(`SELECT ${fields}${progressFields} ${source}
      ORDER BY registry_sort_date(e.registered_on) IS NULL,registry_sort_date(e.registered_on) DESC,e.source_row,e.entry_key
      LIMIT ? OFFSET ?`, ...args, pageSize, offset);
    for (const row of response.items) {
      const rawStage = row.stage;
      row.stage = classifyCase({ rawStatus: rawStage, hasSnapshot: row.hasSnapshot,
        progressStage: row.progressStage, progressNode: row.progressNode }, actor.role === 'investor' ? 'investor' : 'sales').caseStatus;
      delete row.hasSnapshot; delete row.progressStage; delete row.progressNode;
      if (actor.role === 'admin') {
        row.rawStage = rawStage;
        row.salesLink = row.sales ? currentLink('sales', row.sales, '') : null;
        row.investorLink = row.phone ? currentLink('investor', row.customer, row.phone) : null;
      } else {
        row.rowKey = rowKey(row.entryKey);
        delete row.entryKey;
        delete row.sourceRow;
      }
    }
    return response;
  }

  function findGroup(input) {
    const { type, entryKey } = input;
    requireValue(type === 'sales' || type === 'investor', '请选择销售或股民');
    requireValue(typeof entryKey === 'string' && entryKey.length > 0 && entryKey.length <= 256, '请选择登记记录');
    const entry = imported() && one('SELECT sales,customer,phone FROM registry_entries WHERE entry_key=?', entryKey);
    requireValue(entry, '登记记录已变更，请重新查询', 404);
    const name = type === 'sales' ? entry.sales : entry.customer;
    const phone = type === 'investor' ? entry.phone : '';
    // A single leading star on a sales name is a documented register marker. Its
    // exact label stays distinct from the unmarked name for account permissions.
    const checkName = type === 'sales' && name?.startsWith('*') ? name.slice(1) : name;
    requireValue(checkName && !unknownLabel.test(checkName) && !/[*＊]/.test(checkName), '此行缺少可核对的姓名，无法关联');
    requireValue(!/[、，,;；/／＆&+\r\n]/.test(name), '登记了多位人员，请核对原表后再关联');
    requireValue(type !== 'investor' || /^1\d{10}$/.test(phone), '此行缺少有效的合同联系电话，无法关联股民');
    const affectedCount = type === 'sales' ? one('SELECT count(*) AS n FROM registry_entries WHERE sales=?', name).n
      : one('SELECT count(*) AS n FROM registry_entries WHERE customer=? AND phone=?', name, phone).n;
    const sourceToken = createHash('sha256').update(JSON.stringify([type, entryKey, name, phone, affectedCount])).digest('hex');
    return { name, phone, affectedCount, sourceToken, sourceLabel: phone ? `${name} · ${phone}` : name, currentLink: currentLink(type, name, phone) };
  }

  function candidates(actor, input) {
    authorize(actor, ['admin']);
    const { q, offset } = pagination(input);
    const { sourceLabel, sourceToken, affectedCount, currentLink } = findGroup(input);
    const response = { sourceLabel, sourceToken, affectedCount, currentLink, items: [], total: 0, offset, limit,
      orderLabel: '登录账号精确匹配优先，其次按姓名、固定账号编号排序。' };
    if (!q) return response;
    const source = `FROM identities i
      LEFT JOIN clients c ON i.role='investor' AND c.id=i.subjectId
      LEFT JOIN sales_staff s ON i.role='sales' AND s.id=i.subjectId
      WHERE i.status='active' AND i.role=? AND (
        instr(lower(i.username),lower(?))>0 OR instr(lower(i.name),lower(?))>0
        OR instr(lower(COALESCE(s.name,c.name,'')),lower(?))>0)`;
    const args = [input.type, q, q, q];
    response.total = one(`SELECT count(*) AS n ${source}`, ...args).n;
    response.items = all(`SELECT i.id AS identityId,i.username,COALESCE(s.name,c.name,i.name) AS name ${source}
      ORDER BY CASE WHEN i.username=? COLLATE NOCASE THEN 0 ELSE 1 END,name COLLATE NOCASE,i.id LIMIT ? OFFSET ?`,
    ...args, q, limit, offset);
    return response;
  }

  function link(actor, input) {
    authorize(actor, ['admin']);
    const { type, identityId, previousIdentityId } = input;
    requireValue(input.confirmed === true, '请先核实所选账号与登记人身份');
    requireValue([identityId, previousIdentityId].every(id => id === null || Number.isSafeInteger(id) && id > 0), '账号参数无效');
    return transaction(() => {
      const group = findGroup(input);
      requireValue(input.sourceToken === group.sourceToken, '来源数据已变更，请重新核对', 409);
      requireValue((group.currentLink?.identityId ?? null) === previousIdentityId, '关联已变更，请刷新后核对', 409);
      if (identityId === previousIdentityId) return { changed: false };
      if (identityId !== null) {
        requireValue(!group.currentLink, '此登记人已有账号关联，请先解除', 409);
        requireValue(one("SELECT 1 FROM identities WHERE id=? AND role=? AND status='active'", identityId, type), '请选择可用的对应角色账号');
        db.prepare('INSERT INTO registry_links(type,source_name,source_phone,identity_id) VALUES (?,?,?,?)').run(type, group.name, group.phone, identityId);
      } else {
        db.prepare('DELETE FROM registry_links WHERE type=? AND source_name=? AND source_phone=?').run(type, group.name, group.phone);
      }
      audit(actor, identityId === null ? '解除登记台账关联' : '关联登记台账账号', String(identityId ?? previousIdentityId),
        { type, affectedCount: group.affectedCount });
      return { changed: true };
    });
  }

  return { progressRecord, list: (actor, input) => transaction(() => list(actor, input), true),
    salesOverview: actor => transaction(() => {
      authorize(actor, ['sales']);
      const { total, items, orderLabel } = list(actor, {}, 3);
      return { registryCount: total, registryOrderLabel: orderLabel,
        registryPreview: items.map(({ customer, stockName, stockCode, rowKey, stage, registeredOn }) =>
        ({ customer, stockName, stockCode, rowKey, stage, registeredOn })) };
    }, true),
    candidates: (actor, input) => transaction(() => candidates(actor, input), true), link };
}
