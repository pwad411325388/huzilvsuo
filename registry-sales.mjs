import { createHash } from 'node:crypto';

// The register uses one leading star to mark business origin. Retain both
// source labels in registry_links while grouping the sales name for opening accounts.
const salesName = label => label.startsWith('*') ? label.slice(1) : label;
const notPersonal = /^(?:主任|经理|主管|总监|组长|助理|负责人|领导|销售|销售员|业务员|客服|管理员|律师|未登记|无销售|无名|未知|不详|待定|待确认|待核对|未分配|待分配|未标注|公海|其他|其它|非销售|离职|渠道|公司|办公室|同事|无|暂无|姓名)$|(?:团队|公司|小组|部门|销售部|业务部|市场部|渠道部|经理|主任|主管|总监|专员|负责人|公共|公用|共享)$/u;
const personal = name => /^[\p{Script=Han}]{2,6}(?:·[\p{Script=Han}]{1,8})?$/u.test(name) && !notPersonal.test(name);

export function createRegistrySalesBatch(db, { transaction, requireValue, createSalesAccount, audit }) {
  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  const hasRegistry = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_entries'").get();

  function buildPlan() {
    const groups = new Map();
    if (hasRegistry()) {
      const labels = rows(`SELECT e.sales AS label,count(*) AS recordCount,l.identity_id AS linkedId
        FROM registry_entries e LEFT JOIN registry_links l
          ON l.type='sales' AND l.source_name=e.sales AND l.source_phone=''
        GROUP BY e.sales ORDER BY e.sales`);
      for (const item of labels) {
        const name = salesName(item.label || '');
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(item);
      }
    }
    const staff = rows(`SELECT s.id AS salesId,s.name,i.id AS identityId,i.name AS identityName,i.username,i.status
      FROM sales_staff s LEFT JOIN identities i ON i.role='sales' AND i.subjectId=s.id
      UNION ALL
      SELECT i.subjectId,i.name,i.id,i.name,i.username,i.status FROM identities i
      WHERE i.role='sales' AND NOT EXISTS (SELECT 1 FROM sales_staff s WHERE s.id=i.subjectId)
      ORDER BY salesId`);
    const usernames = new Set(rows('SELECT username FROM identities').map(row => row.username.toLowerCase()));
    let serial = 0;
    function nextUsername() {
      let username;
      do { username = 'sales-' + String(++serial).padStart(4, '0'); } while (usernames.has(username));
      usernames.add(username);
      return username;
    }
    const plan = [];
    for (const [name, sources] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
      const row = { name, labels: sources.map(item => item.label), recordCount: sources.reduce((n, item) => n + item.recordCount, 0),
        status: 'review', username: '', reason: '' };
      const matches = staff.filter(item => salesName(item.name) === name || (item.identityName && salesName(item.identityName) === name));
      const [match] = matches;
      if (!personal(name)) row.reason = '销售栏缺少可确认的个人姓名';
      else if (matches.length > 1) row.reason = '存在多个同名销售档案';
      else if (match && (match.name !== name || (match.identityName && match.identityName !== name))) row.reason = '销售档案和登记姓名需核对';
      else if (match?.identityId && match.status !== 'active') row.reason = '同名销售账号已注销';
      else if (sources.some(item => item.linkedId != null && item.linkedId !== match?.identityId)) row.reason = '登记标签已关联其他账号';
      else {
        row.status = !match?.identityId ? 'create' : sources.some(item => item.linkedId == null) ? 'reuse' : 'linked';
        row.username = match?.username || nextUsername();
      }
      plan.push({ row, salesId: match?.salesId || null, identityId: match?.identityId || null, sources });
    }
    const token = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    return { plan, token };
  }

  function checkAdmin(actor) {
    requireValue(actor?.role === 'admin' && !actor.passwordChangeRequired, '请使用已完成改密的管理员账号', 403);
  }

  function preview(actor) {
    checkAdmin(actor);
    return transaction(() => {
      const { plan, token } = buildPlan();
      return { rows: plan.map(item => item.row), token };
    }, true);
  }

  function apply(actor, input) {
    checkAdmin(actor);
    requireValue(input?.confirmed === true && typeof input.token === 'string', '请先核对批量开户预览');
    return transaction(() => {
      const { plan, token } = buildPlan();
      requireValue(input.token === token, '销售名单或账号关联已变化，请重新预览', 409);
      const result = { created: [], linkedLabels: 0, linkedRecords: 0, review: [] };
      const insert = db.prepare("INSERT INTO registry_links(type,source_name,source_phone,identity_id) VALUES ('sales',?,'',?)");
      for (const { row, salesId, identityId, sources } of plan) {
        if (row.status === 'review') { result.review.push(row); continue; }
        if (row.status === 'linked') continue;
        let target = identityId;
        if (row.status === 'create') {
          const { name, username, recordCount } = row;
          const account = createSalesAccount(actor, { salesId, name, username });
          target = account.identityId;
          result.created.push({ name, username, password: account.initialPassword, recordCount });
        }
        for (const { label, linkedId, recordCount } of sources) {
          if (linkedId != null) continue;
          insert.run(label, target);
          result.linkedLabels++;
          result.linkedRecords += recordCount;
          audit(actor, '批量关联登记台账销售', String(target), { sourceLabel: label, recordCount });
        }
      }
      return result;
    });
  }

  return { preview, apply };
}
