import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const caseStatuses = ['待受理', '已受理', '诉讼中', '已结案'];
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
export const today = () => businessDate.format(new Date());
export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message, status = 400) {
  if (!condition) throw new RequestError(status, message);
}

function requiredText(value, label, max = 100) {
  const text = typeof value === 'string' ? value.trim() : '';
  requireValue(text && text.length <= max, `${label}须填写且最多 ${max} 字`);
  return text;
}

function date(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), `请选择${label}`);
  const parsed = new Date(value);
  requireValue(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, `${label}无效`);
  return value;
}

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

const unusedPassword = `${randomBytes(16).toString('hex')}:${randomBytes(32).toString('hex')}`;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const sessionSeconds = 7 * 24 * 60 * 60;

function accountName(value) {
  const username = requiredText(value, '登录账号', 40).toLowerCase();
  requireValue(/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username), '账号须为 3 到 40 位字母、数字或 . _ -');
  return username;
}

function accountPassword(value) {
  requireValue(typeof value === 'string' && value.length >= 8 && value.length <= 128, '密码长度须为 8 到 128 位');
  return value;
}

const companyNameKey = value => value.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const stockCodeKey = value => value.normalize('NFKC').trim().toUpperCase();

export function createStore(path, { cutoff = `${today().slice(0, 7)}-01`, seed = false, admin } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS brokers(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, salesId TEXT NOT NULL,
      signedOn TEXT NOT NULL, rebate REAL NOT NULL, code TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS accounts(
      brokerId TEXT PRIMARY KEY REFERENCES brokers(id), username TEXT NOT NULL UNIQUE, password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_staff(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identities(
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('investor','broker','sales','admin')),
      subjectId TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(role, subjectId)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions(
      digest TEXT PRIMARY KEY, identityId INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_recovery(
      identityId INTEGER PRIMARY KEY REFERENCES identities(id), digest TEXT NOT NULL, expires INTEGER
    );
    CREATE TABLE IF NOT EXISTS recovery_attempts(
      accountDigest TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_referrals(
      digest TEXT PRIMARY KEY, brokerId TEXT NOT NULL REFERENCES brokers(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients(
      id TEXT PRIMARY KEY, name TEXT, phone TEXT, firstBrokerId TEXT REFERENCES brokers(id),
      brokerId TEXT REFERENCES brokers(id), createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leads(
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id),
      stockName TEXT NOT NULL, stockCode TEXT NOT NULL, period TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cases(
      id TEXT PRIMARY KEY, leadId TEXT NOT NULL REFERENCES leads(id), title TEXT NOT NULL,
      openedOn TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signings(
      clientId TEXT PRIMARY KEY REFERENCES clients(id), signedOn TEXT NOT NULL, reference TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_numbers(
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('lead', 'signing')), subjectId TEXT NOT NULL,
      UNIQUE(kind, subjectId)
    );
    CREATE TABLE IF NOT EXISTS case_numbers(number INTEGER PRIMARY KEY AUTOINCREMENT, caseId TEXT NOT NULL UNIQUE REFERENCES cases(id));
    CREATE TABLE IF NOT EXISTS followups(
      id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id), salesId TEXT NOT NULL,
      note TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS companies(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, stockCode TEXT NOT NULL UNIQUE,
      salesId TEXT REFERENCES sales_staff(id), active INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS company_names(
      nameKey TEXT PRIMARY KEY, name TEXT NOT NULL, companyId TEXT NOT NULL REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS lead_assignments(
      leadId TEXT PRIMARY KEY REFERENCES leads(id), companyId TEXT REFERENCES companies(id),
      salesId TEXT REFERENCES sales_staff(id), reason TEXT NOT NULL, method TEXT NOT NULL,
      legacy INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      contactName TEXT, contactPhone TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lead_followups(
      id TEXT PRIMARY KEY, leadId TEXT NOT NULL REFERENCES leads(id), salesId TEXT NOT NULL REFERENCES sales_staff(id),
      assignmentVersion INTEGER NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assigned_sales ON lead_assignments(salesId);
    CREATE INDEX IF NOT EXISTS leads_by_client ON leads(clientId);
    CREATE INDEX IF NOT EXISTS followups_by_lead ON lead_followups(leadId,createdAt);
    CREATE TABLE IF NOT EXISTS audit(
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL,
      details TEXT NOT NULL, createdAt TEXT NOT NULL
    );
  `);
  const one = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const now = () => new Date().toISOString();

  // Additive migration: account lifecycle changes never remove business records.
  const identityColumns = all('PRAGMA table_info(identities)').map(column => column.name);
  if (!identityColumns.includes('status')) db.exec("ALTER TABLE identities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!identityColumns.includes('closedAt')) db.exec('ALTER TABLE identities ADD COLUMN closedAt TEXT');
  if (!identityColumns.includes('passwordChangeRequired')) db.exec('ALTER TABLE identities ADD COLUMN passwordChangeRequired INTEGER NOT NULL DEFAULT 0');

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function audit(actor, action, subject, details = {}) {
    run('INSERT INTO audit(actor,action,subject,details,createdAt) VALUES (?,?,?,?,?)',
      `${actor.role}:${actor.id}`, action, subject, JSON.stringify(details), now());
  }

  function startInvestor(id = randomUUID()) {
    run('INSERT OR IGNORE INTO clients(id,createdAt) VALUES (?,?)', id, now());
    return id;
  }

  date(cutoff, '案件分界日期');
  run('INSERT OR IGNORE INTO settings VALUES (?,?)', 'caseCutoff', cutoff);
  const caseCutoff = one('SELECT value FROM settings WHERE key = ?', 'caseCutoff').value;

  if (seed && !one('SELECT 1 FROM settings WHERE key = ?', 'seeded')) {
    transaction(() => {
      const day = today();
      run('INSERT INTO brokers VALUES (?,?,?,?,?,?)', 'broker-a', '示例券商 A', 'sales-a', day, 10, 'DEMO-A');
      run('INSERT INTO brokers VALUES (?,?,?,?,?,?)', 'broker-b', '示例券商 B', 'sales-b', day, 0, 'DEMO-B');
      run('INSERT INTO identities(username,password,role,subjectId,name) VALUES (?,?,?,?,?)',
        'broker-a', passwordHash('demo-broker-a'), 'broker', 'broker-a', '示例券商 A');
      run('INSERT INTO identities(username,password,role,subjectId,name) VALUES (?,?,?,?,?)',
        'broker-b', passwordHash('demo-broker-b'), 'broker', 'broker-b', '示例券商 B');
      run('INSERT INTO clients VALUES (?,?,?,?,?,?)', 'customer-a', '虚构客户甲', '19900000001', 'broker-a', 'broker-a', now());
      run('INSERT INTO clients VALUES (?,?,?,?,?,?)', 'customer-b', '虚构客户乙', '19900000002', 'broker-b', 'broker-b', now());
      startInvestor('customer-new');
      run('INSERT INTO leads VALUES (?,?,?,?,?,?)', 'lead-demo-a', 'customer-a', '示例股票甲', '000000', '2022–2024 年', now());
      run('INSERT INTO leads VALUES (?,?,?,?,?,?)', 'lead-demo-b', 'customer-b', '示例股票乙', '000001', '2024 年至今', now());
      if (day >= caseCutoff) {
        run('INSERT INTO cases VALUES (?,?,?,?,?)', 'case-demo-1', 'lead-demo-a', '示例案件 01', day, '已受理');
        run('INSERT INTO cases VALUES (?,?,?,?,?)', 'case-demo-2', 'lead-demo-a', '示例案件 02', day, '已结案');
      }
      run('INSERT INTO signings VALUES (?,?,?)', 'customer-a', day, '虚构签约凭据');
      run('INSERT INTO settings VALUES (?,?)', 'seeded', '1');
    });
  }

  transaction(() => {
    if (!one('SELECT 1 FROM settings WHERE key = ?', 'authV012')) {
      run(`INSERT INTO identities(username,password,role,subjectId,name)
        SELECT a.username,a.password,'broker',a.brokerId,b.name FROM accounts a JOIN brokers b ON b.id = a.brokerId`);
      run('DELETE FROM accounts');
      run('INSERT INTO settings VALUES (?,?)', 'authV012', '1');
    }
    run(`INSERT OR IGNORE INTO sales_staff(id,name) SELECT DISTINCT salesId,
      CASE salesId WHEN 'sales-a' THEN '销售 A' WHEN 'sales-b' THEN '销售 B' ELSE salesId END FROM brokers`);
    run(`INSERT INTO report_numbers(kind,subjectId)
      SELECT 'lead', l.id FROM leads l WHERE NOT EXISTS (
        SELECT 1 FROM report_numbers n WHERE n.kind = 'lead' AND n.subjectId = l.id
      ) ORDER BY l.createdAt, l.id`);
    run(`INSERT INTO report_numbers(kind,subjectId)
      SELECT 'signing', s.clientId FROM signings s WHERE NOT EXISTS (
        SELECT 1 FROM report_numbers n WHERE n.kind = 'signing' AND n.subjectId = s.clientId
      ) ORDER BY s.signedOn, s.clientId`);
    // Legacy leads are visible for human review; never infer their handler from a broker.
    run(`INSERT INTO lead_assignments(leadId,reason,method,legacy,contactName,contactPhone,updatedAt)
      SELECT l.id,'历史留资待核对','legacy',1,c.name,c.phone,? FROM leads l JOIN clients c ON c.id = l.clientId
      WHERE NOT EXISTS (SELECT 1 FROM lead_assignments a WHERE a.leadId = l.id)`, now());
    run(`INSERT INTO case_numbers(caseId) SELECT id FROM cases k WHERE NOT EXISTS
      (SELECT 1 FROM case_numbers n WHERE n.caseId = k.id) ORDER BY openedOn,id`);
  });

  function addIdentity(username, password, role, subjectId, name) {
    requireValue(!one('SELECT 1 FROM identities WHERE username = ?', username), '该登录账号已使用', 409);
    return Number(run('INSERT INTO identities(username,password,role,subjectId,name) VALUES (?,?,?,?,?)',
      username, passwordHash(password), role, subjectId, name).lastInsertRowid);
  }

  if (admin) transaction(() => {
    if (!one("SELECT 1 FROM identities WHERE role = 'admin'")) {
      addIdentity(accountName(admin.username), accountPassword(admin.password), 'admin', randomUUID(), requiredText(admin.name, '后台名称'));
    }
  });

  function registerInvestor(input, referralToken) {
    const phone = requiredText(input.phone, '注册手机号', 11);
    requireValue(/^1\d{10}$/.test(phone), '请输入以 1 开头的 11 位注册手机号');
    const password = accountPassword(input.password);
    return transaction(() => {
      const clientId = startInvestor();
      const id = addIdentity(phone, password, 'investor', clientId, phone);
      audit({ role: 'investor', id: clientId }, '股民注册', clientId);
      attachPending({ role: 'investor', id: clientId }, referralToken);
      return id;
    });
  }

  function verifyLogin(input) {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = input.password;
    requireValue(username.length <= 40 && typeof password === 'string' && password.length <= 128, '账号或密码有误', 401);
    const account = one('SELECT id,role,subjectId,password,status,passwordChangeRequired FROM identities WHERE username = ?', username);
    const expected = account?.password || unusedPassword;
    const provided = passwordHash(password, expected.split(':')[0]);
    requireValue(timingSafeEqual(Buffer.from(expected), Buffer.from(provided)) && account?.status === 'active', '账号或密码有误，或账号已注销', 401);
    return account;
  }

  function createSession(identityId) {
    const token = randomBytes(32).toString('hex');
    transaction(() => {
      requireValue(one("SELECT 1 FROM identities WHERE id = ? AND status = 'active'", identityId), '账号不可用', 401);
      run('DELETE FROM auth_sessions WHERE expires <= ?', Date.now());
      run('INSERT INTO auth_sessions VALUES (?,?,?)', tokenHash(token), identityId, Date.now() + sessionSeconds * 1000);
    });
    return token;
  }

  function getSession(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const identity = one(`SELECT i.subjectId AS id,i.role,i.username AS account,COALESCE(b.name,i.name) AS name,i.passwordChangeRequired
      FROM auth_sessions s JOIN identities i ON i.id = s.identityId
      LEFT JOIN brokers b ON i.role = 'broker' AND b.id = i.subjectId
      WHERE s.digest = ? AND s.expires > ? AND i.status = 'active'`, tokenHash(token), Date.now());
    if (identity) identity.passwordChangeRequired = Boolean(identity.passwordChangeRequired);
    return identity || null;
  }

  function revokeSession(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) run('DELETE FROM auth_sessions WHERE digest = ?', tokenHash(token));
  }

  function ownIdentity(actor, password) {
    let identity;
    try { identity = verifyLogin({ username: actor.account, password }); }
    catch (error) {
      if (error instanceof RequestError && error.status === 401) throw new RequestError(400, '当前密码不正确');
      throw error;
    }
    requireValue(identity.subjectId === actor.id && identity.role === actor.role, '请重新登录', 401);
    return identity;
  }

  function managedIdentity(actor, input) {
    requireValue(actor.role === 'admin', '只有后台管理员可以管理账号', 403);
    ownIdentity(actor, input.currentPassword);
    const id = Number(input.identityId);
    requireValue(Number.isSafeInteger(id) && id > 0, '请选择有效账号');
    const identity = one('SELECT id,role,subjectId,username,status FROM identities WHERE id = ?', id);
    requireValue(identity, '账号不存在', 404);
    return identity;
  }

  function setPassword(identityId, password, mustChange = false) {
    run('UPDATE identities SET password = ?, passwordChangeRequired = ? WHERE id = ?', passwordHash(password), Number(mustChange), identityId);
    run('DELETE FROM auth_sessions WHERE identityId = ?', identityId);
    run('DELETE FROM password_recovery WHERE identityId = ?', identityId);
  }

  function resetAccountPassword(actor, input) {
    const password = accountPassword(input.password);
    return transaction(() => {
      const identity = managedIdentity(actor, input);
      requireValue(identity.status === 'active', '请先恢复账号后再重置密码');
      setPassword(identity.id, password, true);
      audit(actor, '后台重置密码', identity.username, { role: identity.role });
      return { changed: true, signedOut: identity.subjectId === actor.id && identity.role === actor.role };
    });
  }

  function setAccountStatus(actor, input) {
    requireValue(['active', 'closed'].includes(input.status), '账号状态无效');
    return transaction(() => {
      const identity = managedIdentity(actor, input);
      if (input.status === 'closed') {
        requireValue(!(identity.role === actor.role && identity.subjectId === actor.id), '不能注销当前登录的管理员账号');
        requireValue(identity.role !== 'admin' || one("SELECT COUNT(*) AS count FROM identities WHERE role = 'admin' AND status = 'active'").count > 1,
          '不能注销最后一个可用管理员账号');
      }
      if (identity.status === input.status) return { changed: false };
      run('UPDATE identities SET status = ?, closedAt = ? WHERE id = ?', input.status, input.status === 'closed' ? now() : null, identity.id);
      run('DELETE FROM auth_sessions WHERE identityId = ?', identity.id);
      run('DELETE FROM password_recovery WHERE identityId = ?', identity.id);
      if (input.status === 'closed' && identity.role === 'broker') run('DELETE FROM pending_referrals WHERE brokerId = ?', identity.subjectId);
      audit(actor, input.status === 'closed' ? '注销账号' : '恢复账号', identity.username, { role: identity.role });
      return { changed: true };
    });
  }

  function changePassword(actor, input) {
    const password = accountPassword(input.password);
    requireValue(password !== input.currentPassword, '新密码不能与当前密码相同');
    return transaction(() => {
      const identity = ownIdentity(actor, input.currentPassword);
      setPassword(identity.id, password);
      audit(actor, '自行修改密码', actor.account);
      return { changed: true };
    });
  }

  function issueRecoveryCode(actor, input, assisted = false) {
    return transaction(() => {
      const identity = assisted ? managedIdentity(actor, input) : ownIdentity(actor, input.currentPassword);
      requireValue(identity.status === 'active', '请先恢复账号后再生成恢复码');
      const code = randomBytes(16).toString('hex');
      const expires = assisted ? Date.now() + 30 * 60 * 1000 : null;
      run(`INSERT INTO password_recovery VALUES (?,?,?) ON CONFLICT(identityId)
        DO UPDATE SET digest = excluded.digest, expires = excluded.expires`, identity.id, tokenHash(code), expires);
      const username = assisted ? identity.username : actor.account;
      run('DELETE FROM recovery_attempts WHERE accountDigest = ?', tokenHash(username));
      audit(actor, assisted ? '后台签发临时恢复码' : '生成个人恢复码', username);
      return { code: code.toUpperCase().match(/.{4}/g).join('-'), expiresAt: expires ? new Date(expires).toISOString() : null };
    });
  }

  function recoverPassword(input) {
    const username = accountName(input.username);
    const password = accountPassword(input.password);
    const code = typeof input.code === 'string' ? input.code.replace(/[\s-]/g, '').toLowerCase() : '';
    const accountDigest = tokenHash(username);
    // Failed attempts must persist even though no password or session is changed.
    const limit = transaction(() => {
      run('DELETE FROM recovery_attempts WHERE expires <= ?', Date.now());
      const prior = one('SELECT attempts FROM recovery_attempts WHERE accountDigest = ?', accountDigest);
      if (prior?.attempts >= 5) return true;
      run(`INSERT INTO recovery_attempts VALUES (?,1,?) ON CONFLICT(accountDigest)
        DO UPDATE SET attempts = attempts + 1`, accountDigest, Date.now() + 15 * 60 * 1000);
      return false;
    });
    requireValue(!limit, '尝试次数过多，请 15 分钟后再试，或联系管理员重新签发恢复码', 429);
    return transaction(() => {
      const identity = one(`SELECT i.id,i.role,i.subjectId,r.digest,r.expires FROM identities i
        JOIN password_recovery r ON r.identityId = i.id WHERE i.username = ? AND i.status = 'active'`, username);
      const digest = tokenHash(code);
      const matches = timingSafeEqual(Buffer.from(digest), Buffer.from(identity?.digest || '0'.repeat(64)));
      requireValue(matches && /^[a-f0-9]{32}$/.test(code) && identity && (!identity.expires || identity.expires > Date.now()),
        '账号或恢复码无效，恢复码也可能已使用或过期');
      setPassword(identity.id, password);
      run('DELETE FROM recovery_attempts WHERE accountDigest = ?', accountDigest);
      audit({ role: identity.role, id: identity.subjectId }, '通过恢复码重置密码', username);
      return { changed: true };
    });
  }

  function renameInvestor(actor, input) {
    const name = requiredText(input.name, '显示名称', 40);
    transaction(() => {
      run("UPDATE identities SET name = ? WHERE role = 'investor' AND subjectId = ?", name, actor.id);
      audit(actor, '修改股民显示名称', actor.id);
    });
    return { changed: true };
  }

  function brokerById(id) {
    const broker = one('SELECT * FROM brokers WHERE id = ?', requiredText(id, '券商编号'));
    requireValue(broker, '券商记录不存在', 404);
    return broker;
  }

  function clientById(id) {
    const client = one('SELECT * FROM clients WHERE id = ?', requiredText(id, '客户编号'));
    requireValue(client, '客户记录不存在', 404);
    return client;
  }

  function searchClients(actor, input) {
    requireValue(actor.role === 'admin', '只有后台管理员可以搜索客户', 403);
    requireValue(['reassign', 'signing', 'records'].includes(input.scope), '客户搜索范围无效');
    requireValue(input.q === undefined || typeof input.q === 'string', '请输入客户姓名或手机号');
    const query = (input.q || '').trim();
    requireValue(query.length <= 100, '搜索内容最多 100 字');
    const offsetText = String(input.offset ?? '0');
    const offset = Number(offsetText);
    requireValue(/^\d+$/.test(offsetText) && Number.isSafeInteger(offset), '搜索分页位置无效');
    const limit = 20;
    const records = input.scope === 'records';
    if (!query && !records) return { items: [], total: 0, offset, limit, hasMore: false };
    const eligibility = input.scope === 'reassign'
      ? 'c.brokerId IS NOT NULL'
      : records ? '(c.brokerId IS NOT NULL OR c.name IS NOT NULL)'
        : "COALESCE(TRIM(c.name),'') != '' AND COALESCE(TRIM(c.phone),'') != '' AND EXISTS (SELECT 1 FROM leads l WHERE l.clientId = c.id)";
    const matches = ["instr(lower(COALESCE(c.name,'')),lower(?)) > 0", "instr(COALESCE(c.phone,''),?) > 0",
      "instr(lower(COALESCE(i.username,'')),lower(?)) > 0"];
    if (records) matches.push("instr(lower(COALESCE(b.name,'')),lower(?)) > 0", "instr(lower(COALESCE(fb.name,'')),lower(?)) > 0",
      "EXISTS (SELECT 1 FROM leads l WHERE l.clientId = c.id AND (instr(lower(l.stockName),lower(?)) > 0 OR instr(lower(l.stockCode),lower(?)) > 0))");
    const values = query ? Array(records ? 7 : 3).fill(query) : [];
    const source = `FROM clients c LEFT JOIN identities i ON i.role = 'investor' AND i.subjectId = c.id
      LEFT JOIN brokers b ON b.id = c.brokerId
      ${records ? 'LEFT JOIN brokers fb ON fb.id = c.firstBrokerId LEFT JOIN signings s ON s.clientId = c.id' : ''}
      WHERE ${eligibility}${query ? ` AND (${matches.join(' OR ')})` : ''}`;
    const total = one(`SELECT COUNT(*) AS total ${source}`, ...values).total;
    const ordering = query
      ? `CASE WHEN c.name = ? COLLATE NOCASE OR c.phone = ? OR i.username = ? COLLATE NOCASE THEN 0 ELSE 1 END,
        c.name COLLATE NOCASE,c.phone,c.id`
      : 'c.createdAt DESC,c.id';
    const items = all(`SELECT c.id,c.name,c.phone,c.brokerId,b.name AS brokerName,i.username AS account
      ${records ? ',fb.name AS firstBrokerName,s.signedOn' : ''} ${source}
      ORDER BY ${ordering} LIMIT ? OFFSET ?`, ...values, ...(query ? [query, query, query] : []), limit, offset);
    if (records && items.length) {
      const stocks = all(`SELECT clientId,stockName,stockCode,COUNT(*) AS leadCount FROM leads
        WHERE clientId IN (${items.map(() => '?').join(',')}) GROUP BY clientId,stockName,stockCode ORDER BY stockName,stockCode`, ...items.map(item => item.id));
      const byClient = new Map(items.map(item => [item.id, []]));
      for (const { clientId, ...stock } of stocks) byClient.get(clientId).push(stock);
      for (const item of items) item.stocks = byClient.get(item.id);
    }
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  function registerBroker(actor, input) {
    const name = requiredText(input.name, '券商名称');
    const signedOn = date(input.signedOn, '券商签约日期');
    const rebateText = String(input.rebate ?? '0').trim();
    const rebate = Number(rebateText);
    requireValue(/^\d+(\.\d{1,2})?$/.test(rebateText) && rebate <= 100,
      '返佣比例须在 0 到 100 之间');
    const id = randomUUID();
    transaction(() => {
      requireValue(!one('SELECT 1 FROM brokers WHERE name = ?', name), '该券商已有合作记录', 409);
      run('INSERT INTO brokers VALUES (?,?,?,?,?,?)', id, name, actor.id, signedOn, rebate, randomBytes(10).toString('hex'));
      audit(actor, '券商合作登记', id);
    });
    return { id };
  }

  function searchBrokers(actor, input) {
    requireValue(actor.role === 'admin', '只有后台管理员可以搜索券商', 403);
    const status = input.status ?? '';
    requireValue(['', 'pending', 'active', 'closed'].includes(status), '券商账号状态无效');
    requireValue(input.q === undefined || typeof input.q === 'string', '请输入券商名称、账号或销售姓名');
    const query = (input.q || '').trim();
    requireValue(query.length <= 100, '搜索内容最多 100 字');
    const offsetText = String(input.offset ?? '0');
    const offset = Number(offsetText);
    requireValue(/^\d+$/.test(offsetText) && Number.isSafeInteger(offset), '搜索分页位置无效');
    const limit = 20;
    const source = `FROM brokers b LEFT JOIN identities i ON i.role = 'broker' AND i.subjectId = b.id
      LEFT JOIN sales_staff s ON s.id = b.salesId WHERE 1 = 1${query ? ` AND (instr(lower(b.name),lower(?)) > 0
        OR instr(lower(COALESCE(i.username,'')),lower(?)) > 0 OR instr(lower(COALESCE(s.name,'')),lower(?)) > 0)` : ''}`;
    const values = query ? [query, query, query] : [];
    const counts = one(`SELECT COALESCE(SUM(i.id IS NULL),0) AS pending,
      COALESCE(SUM(i.status = 'active'),0) AS active,COALESCE(SUM(i.status = 'closed'),0) AS closed ${source}`, ...values);
    const eligibility = status === 'pending' ? ' AND i.id IS NULL' : status ? ' AND i.status = ?' : '';
    const total = status ? counts[status] : counts.pending + counts.active + counts.closed;
    const items = all(`SELECT b.id,b.name,b.salesId,s.name AS salesName,b.signedOn,i.username,
      CASE WHEN i.id IS NULL THEN 'pending' ELSE i.status END AS accountStatus ${source}${eligibility}
      ORDER BY CASE WHEN i.id IS NULL THEN 0 WHEN i.status = 'active' THEN 1 ELSE 2 END,
        b.name COLLATE NOCASE,b.id LIMIT ? OFFSET ?`, ...values, ...(status && status !== 'pending' ? [status] : []), limit, offset);
    return { items, total, offset, limit, hasMore: offset + items.length < total, counts };
  }

  function openAccount(actor, input) {
    const broker = brokerById(input.brokerId);
    const username = accountName(input.username);
    const password = accountPassword(input.password);
    transaction(() => {
      requireValue(!one("SELECT 1 FROM identities WHERE role = 'broker' AND subjectId = ?", broker.id), '该券商已开户', 409);
      addIdentity(username, password, 'broker', broker.id, broker.name);
      audit(actor, '券商开户', broker.id);
    });
    return { id: broker.id };
  }

  function openSalesAccount(actor, input) {
    const name = requiredText(input.name, '销售姓名', 40);
    const username = accountName(input.username);
    const password = accountPassword(input.password);
    return transaction(() => {
      const existing = input.salesId ? one('SELECT id FROM sales_staff WHERE id = ?', requiredText(input.salesId, '销售编号')) : null;
      requireValue(!input.salesId || existing, '销售记录不存在', 404);
      const id = existing?.id || randomUUID();
      requireValue(!one("SELECT 1 FROM identities WHERE role = 'sales' AND subjectId = ?", id), '该销售已开户', 409);
      run('INSERT INTO sales_staff(id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name', id, name);
      addIdentity(username, password, 'sales', id, name);
      audit(actor, '销售开户', id);
      return { id };
    });
  }

  function activeBrokerFromCode(input) {
    const code = requiredText(input.code, '推广码', 32);
    const broker = one("SELECT b.id FROM brokers b JOIN identities a ON a.role = 'broker' AND a.subjectId = b.id WHERE b.code = ? AND a.status = 'active'", code);
    requireValue(broker, '推广码无效或券商未开户', 404);
    return broker.id;
  }

  function bindFirstReferral(actor, brokerId) {
    const updated = run(`UPDATE clients SET firstBrokerId = ?, brokerId = ?
      WHERE id = ? AND firstBrokerId IS NULL AND brokerId IS NULL`, brokerId, brokerId, actor.id).changes;
    if (updated) audit(actor, '首次推广归属', actor.id, { brokerId });
    return Boolean(updated);
  }

  function scan(actor, input) {
    return transaction(() => ({ recorded: bindFirstReferral(actor, activeBrokerFromCode(input)) }));
  }

  function referralDigest(token) {
    return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? tokenHash(token) : null;
  }

  function captureReferral(input, priorToken) {
    return transaction(() => {
      const brokerId = activeBrokerFromCode(input);
      const timestamp = Date.now();
      run('DELETE FROM pending_referrals WHERE expires <= ?', timestamp);
      const prior = referralDigest(priorToken);
      if (prior && one('SELECT 1 FROM pending_referrals WHERE digest = ?', prior)) {
        return { recorded: false, token: priorToken };
      }
      const token = randomBytes(32).toString('hex');
      run('INSERT INTO pending_referrals VALUES (?,?,?)', tokenHash(token), brokerId, timestamp + 24 * 60 * 60 * 1000);
      return { recorded: true, token };
    });
  }

  function attachPending(actor, token) {
    const digest = referralDigest(token);
    if (!digest) return false;
    const source = one('SELECT brokerId FROM pending_referrals WHERE digest = ? AND expires > ?', digest, Date.now());
    if (!source) return false;
    const recorded = bindFirstReferral(actor, source.brokerId);
    run('DELETE FROM pending_referrals WHERE digest = ?', digest);
    return recorded;
  }

  function redeemReferral(account, token) {
    if (account.role !== 'investor') return false;
    return transaction(() => attachPending({ role: 'investor', id: account.subjectId }, token));
  }

  function reassign(actor, input) {
    const broker = brokerById(input.brokerId);
    requireValue(one("SELECT 1 FROM identities WHERE role = 'broker' AND subjectId = ? AND status = 'active'", broker.id), '请选择可用的已开户券商');
    return transaction(() => {
      const client = clientById(input.clientId);
      requireValue(client.brokerId, '该客户尚无券商归属');
      if (client.brokerId === broker.id) return { changed: false };
      run('UPDATE clients SET brokerId = ? WHERE id = ?', broker.id, client.id);
      audit(actor, '调整客户归属', client.id, { from: client.brokerId, to: broker.id });
      return { changed: true };
    });
  }

  function addLead(actor, input) {
    const name = requiredText(input.name, '姓名', 40);
    const phone = requiredText(input.phone, '手机号码', 11);
    const stockName = requiredText(input.stockName, '股票名称', 50);
    const stockCode = requiredText(input.stockCode, '股票代码', 20);
    const period = requiredText(input.period, '买入时段', 40);
    requireValue(/^1\d{10}$/.test(phone), '请输入 11 位手机号码');
    requireValue(input.consent === true, '请确认同意将资料用于联系与咨询');
    const id = randomUUID();
    transaction(() => {
      run('UPDATE clients SET name = ?, phone = ? WHERE id = ?', name, phone, actor.id);
      run('INSERT INTO leads VALUES (?,?,?,?,?,?)', id, actor.id, stockName, stockCode, period, now());
      run('INSERT INTO report_numbers(kind,subjectId) VALUES (?,?)', 'lead', id);
      const assignment = matchCompany(stockName, stockCode);
      run(`INSERT INTO lead_assignments(leadId,companyId,salesId,reason,method,contactName,contactPhone,updatedAt)
        VALUES (?,?,?,?,?,?,?,?)`, id, assignment.companyId, assignment.salesId, assignment.reason, 'auto', name, phone, now());
      audit(actor, '新增留资', id);
      audit(actor, assignment.salesId ? '按公司自动派单' : '留资进入待分配', id, assignment);
    });
    return { id };
  }

  function addFollowup(actor, input) {
    const note = requiredText(input.note, '跟进记录', 500);
    requireValue(typeof input.leadId === 'string' && input.leadId, '请按具体留资记录跟进', 403);
    const id = randomUUID();
    transaction(() => {
      const assignment = one('SELECT salesId,version FROM lead_assignments WHERE leadId = ?', input.leadId);
      requireValue(assignment?.salesId === actor.id, '无法跟进该留资，可能已转交其他销售', 403);
      requireValue(Number(input.version) === assignment.version, '该留资的分派已更新，请刷新后再跟进', 409);
      run('INSERT INTO lead_followups VALUES (?,?,?,?,?,?)', id, input.leadId, actor.id, assignment.version, note, now());
      audit(actor, '留资跟进', input.leadId);
    });
    return { id };
  }

  function availableSales(id) {
    return one("SELECT 1 FROM identities WHERE role = 'sales' AND subjectId = ? AND status = 'active'", id);
  }

  function saveCompany(actor, input) {
    const name = requiredText(input.name, '公司名称', 80);
    const stockCode = stockCodeKey(requiredText(input.stockCode, '股票代码', 20));
    requireValue(/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(stockCode), '代码最多 20 位，可含字母、数字、点或短横线');
    requireValue(typeof input.aliases === 'string' && input.aliases.length <= 500, '股票别名最多 500 字');
    const aliases = input.aliases.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean);
    requireValue(aliases.length <= 15 && aliases.every(alias => alias.length <= 80), '最多 15 个别名，每个最多 80 字');
    const names = [...new Map([name, ...aliases].map(value => [companyNameKey(value), value])).entries()];
    const salesId = input.salesId ? requiredText(input.salesId, '负责销售') : null;
    requireValue(!salesId || availableSales(salesId), '请选择已开户且正常的销售');
    requireValue(typeof input.active === 'boolean', '请选择是否启用自动匹配');
    return transaction(() => {
      const current = input.id ? one('SELECT * FROM companies WHERE id = ?', requiredText(input.id, '公司编号')) : null;
      requireValue(!input.id || current, '公司配置不存在', 404);
      requireValue(!current || current.version === Number(input.version), '公司配置已更新，请刷新后再修改', 409);
      const id = current?.id || randomUUID();
      requireValue(!one('SELECT 1 FROM companies WHERE stockCode = ? AND id != ?', stockCode, id), '该股票代码已有公司配置', 409);
      for (const [key] of names) requireValue(!one('SELECT 1 FROM company_names WHERE nameKey = ? AND companyId != ?', key, id),
        '公司名称或别名与其他公司重复，请核对', 409);
      if (current) {
        run('UPDATE companies SET name = ?,stockCode = ?,salesId = ?,active = ?,version = version + 1 WHERE id = ?', name, stockCode, salesId, Number(input.active), id);
        run('DELETE FROM company_names WHERE companyId = ?', id);
      } else run('INSERT INTO companies(id,name,stockCode,salesId,active) VALUES (?,?,?,?,?)', id, name, stockCode, salesId, Number(input.active));
      for (const [key, value] of names) run('INSERT INTO company_names VALUES (?,?,?)', key, value, id);
      audit(actor, current ? '更新公司派单配置' : '新增公司派单配置', id, { name, stockCode, salesId, active: input.active });
      return { id };
    });
  }

  function matchCompany(stockName, stockCode) {
    const byCode = one('SELECT * FROM companies WHERE stockCode = ?', stockCodeKey(stockCode));
    const byName = one('SELECT companyId FROM company_names WHERE nameKey = ?', companyNameKey(stockName));
    const pending = reason => ({ companyId: null, salesId: null, reason });
    if (byCode && byName && byCode.id !== byName.companyId) return pending('股票名称与代码对应公司不一致');
    if (!byCode && !byName) return pending('未匹配到公司');
    if (!byCode || !byName) return pending(byCode ? '股票名称未匹配，请核对名称和代码' : '股票代码未匹配，请核对名称和代码');
    if (!byCode.active) return { ...pending('公司配置已停用'), companyId: byCode.id };
    if (!byCode.salesId || !availableSales(byCode.salesId)) return { ...pending('未配置可用负责销售'), companyId: byCode.id };
    return { companyId: byCode.id, salesId: byCode.salesId, reason: '按公司配置自动分配' };
  }

  function assignLead(actor, input) {
    const leadId = requiredText(input.leadId, '留资编号');
    const companyId = requiredText(input.companyId, '核对后的公司');
    const salesId = requiredText(input.salesId, '经办销售');
    const reason = requiredText(input.reason, '分配说明', 200);
    return transaction(() => {
      const prior = one('SELECT * FROM lead_assignments WHERE leadId = ?', leadId);
      requireValue(prior, '留资不存在', 404);
      requireValue(prior.version === Number(input.version), '留资分派已被更新，请刷新后再操作', 409);
      requireValue(one('SELECT 1 FROM companies WHERE id = ? AND active = 1', companyId), '请选择已启用的公司配置');
      requireValue(availableSales(salesId), '请选择已开户且正常的销售');
      run(`UPDATE lead_assignments SET companyId = ?,salesId = ?,reason = ?,method = 'manual',
        version = version + 1,updatedAt = ? WHERE leadId = ?`, companyId, salesId, reason, now(), leadId);
      audit(actor, prior.salesId ? '调整留资经办销售' : '人工分配留资', leadId,
        { fromSalesId: prior.salesId, fromCompanyId: prior.companyId, companyId, salesId, reason });
      return { changed: true };
    });
  }

  function changeChannelOwner(actor, input) {
    const brokerId = requiredText(input.brokerId, '券商');
    const salesId = requiredText(input.salesId, '合作负责人');
    const reason = requiredText(input.reason, '调整说明', 200);
    return transaction(() => {
      const broker = brokerById(brokerId);
      requireValue(broker.salesId === input.previousSalesId, '渠道负责人已更新，请刷新后再操作', 409);
      requireValue(availableSales(salesId), '请选择已开户且正常的销售');
      if (broker.salesId === salesId) return { changed: false };
      run('UPDATE brokers SET salesId = ? WHERE id = ?', salesId, brokerId);
      audit(actor, '调整渠道合作负责人', brokerId, { from: broker.salesId, to: salesId, reason });
      return { changed: true };
    });
  }

  function assignedLeads(salesId) {
    const rows = all(`SELECT l.*,a.companyId,a.salesId,a.reason,a.method,a.legacy,a.version,a.updatedAt,
      a.contactName AS name,a.contactPhone AS phone,co.name AS companyName,s.name AS salesName,i.status AS salesStatus,
      c.brokerId,b.name AS brokerName,n.number AS recordNumber
      FROM leads l JOIN lead_assignments a ON a.leadId = l.id JOIN clients c ON c.id = l.clientId
      LEFT JOIN companies co ON co.id = a.companyId LEFT JOIN sales_staff s ON s.id = a.salesId
      LEFT JOIN identities i ON i.role = 'sales' AND i.subjectId = a.salesId
      LEFT JOIN brokers b ON b.id = c.brokerId LEFT JOIN report_numbers n ON n.kind = 'lead' AND n.subjectId = l.id
      ${salesId ? 'WHERE a.salesId = ?' : ''} ORDER BY l.createdAt DESC,l.rowid DESC`, ...(salesId ? [salesId] : []));
    return rows.map(row => {
      const followups = all(`SELECT f.id,f.note,f.createdAt,f.assignmentVersion,f.salesId,s.name AS salesName FROM lead_followups f
        JOIN sales_staff s ON s.id = f.salesId WHERE f.leadId = ? ORDER BY f.createdAt DESC,f.rowid DESC`, row.id);
      const needsAssignment = !row.salesId || row.salesStatus !== 'active';
      return { ...row, number: `LZ-${String(row.recordNumber).padStart(6, '0')}`, createdOn: businessDate.format(new Date(row.createdAt)),
        needsAssignment, reason: row.salesId && row.salesStatus !== 'active' ? '负责销售账号不可用，请重新分配' : row.reason,
        followups, status: needsAssignment ? '待分配' : followups.some(item => item.assignmentVersion === row.version) ? '已跟进' : '待跟进',
        cases: all('SELECT id,title,status,openedOn FROM cases WHERE leadId = ? AND openedOn >= ? ORDER BY openedOn DESC,id', row.id, caseCutoff) };
    });
  }

  function saveSigning(actor, input) {
    const client = clientById(input.clientId);
    const signedOn = date(input.signedOn, '客户实际签约日期');
    const reference = requiredText(input.reference, '签约凭据说明', 160);
    requireValue(client.name && client.phone, '请先取得有效客户资料');
    requireValue(signedOn <= today(), '客户实际签约日期不能晚于今天');
    return transaction(() => {
      const earlier = one('SELECT * FROM signings WHERE clientId = ?', client.id);
      if (earlier?.signedOn === signedOn && earlier.reference === reference) return { changed: false };
      run(`INSERT INTO signings VALUES (?,?,?) ON CONFLICT(clientId) DO UPDATE SET
        signedOn = excluded.signedOn, reference = excluded.reference`, client.id, signedOn, reference);
      if (!earlier) run('INSERT INTO report_numbers(kind,subjectId) VALUES (?,?)', 'signing', client.id);
      audit(actor, earlier ? '更正客户签约' : '录入客户签约', client.id, { from: earlier?.signedOn, to: signedOn });
      return { changed: true };
    });
  }

  function saveCase(actor, input) {
    requireValue(caseStatuses.includes(input.status), '请选择有效的案件状态');
    return transaction(() => {
      if (input.id) {
        const current = one('SELECT * FROM cases WHERE id = ? AND openedOn >= ?', requiredText(input.id, '案件编号'), caseCutoff);
        requireValue(current, '案件记录不存在', 404);
        if (current.status !== input.status) {
          run('UPDATE cases SET status = ? WHERE id = ?', input.status, current.id);
          audit(actor, '更新案件状态', current.id, { from: current.status, to: input.status });
        }
        return { id: current.id };
      }
      const openedOn = date(input.openedOn, '案件登记日期');
      const title = requiredText(input.title, '案件名称', 80);
      const leadId = requiredText(input.leadId, '留资记录');
      requireValue(openedOn >= caseCutoff && openedOn <= today(), `案件日期须为 ${caseCutoff} 至今天的新增案件`);
      requireValue(one('SELECT 1 FROM leads WHERE id = ?', leadId), '请选择有效留资记录');
      const id = randomUUID();
      run('INSERT INTO cases VALUES (?,?,?,?,?)', id, leadId, title, openedOn, input.status);
      run('INSERT INTO case_numbers(caseId) VALUES (?)', id);
      audit(actor, '新建案件', id, { leadId, status: input.status });
      return { id };
    });
  }

  function boardCard(client, actor, signing) {
    const unnamed = actor.role === 'broker' ? '待留资客户' : `客户 ${client.id.slice(0, 8)}`;
    const display = { id: client.id, title: client.name || unnamed, subtitle: client.name ? '已留资' : '待留资',
      status: signing ? '已签约' : '洽谈中', signedOn: signing?.signedOn };
    if (actor.role === 'sales' && client.name) display.phone = client.phone;
    return display;
  }

  function buildBoard(actor) {
    const sales = actor.role === 'sales';
    const brokers = sales ? all('SELECT * FROM brokers WHERE salesId = ? ORDER BY signedOn DESC, name', actor.id)
      : [brokerById(actor.id)];
    const clients = all(`SELECT c.*, s.signedOn FROM clients c JOIN brokers b ON b.id = c.brokerId
      LEFT JOIN signings s ON s.clientId = c.id WHERE ${sales ? 'b.salesId' : 'b.id'} = ? ORDER BY c.createdAt DESC`, actor.id);
    const cases = all(`SELECT k.*, c.id AS clientId, c.name, c.phone FROM cases k JOIN leads l ON l.id = k.leadId
      JOIN clients c ON c.id = l.clientId JOIN brokers b ON b.id = c.brokerId
      WHERE ${sales ? 'b.salesId' : 'b.id'} = ? AND k.openedOn >= ? ORDER BY k.openedOn DESC, k.id`, actor.id, caseCutoff);
    const customerCards = clients.map(client => boardCard(client, actor, client.signedOn ? client : null));
    const caseCards = cases.map(record => ({
      id: record.id, clientId: record.clientId,
      title: record.name || (sales ? `客户 ${record.clientId.slice(0, 8)}` : '待留资客户'),
      subtitle: record.title,
      status: record.status, openedOn: record.openedOn,
      ...(sales && record.name ? { phone: record.phone } : {}),
    }));
    const closed = caseCards.filter(record => record.status === '已结案');
    const metric = (label, records, unit, kind) => ({ label, value: records.length, records, unit, kind });
    if (!sales) {
      const month = today().slice(0, 7);
      const ledger = customerCards.map(card => ({ ...card, title: `客户 ${card.id.slice(0, 8)}` }));
      return { broker: { name: brokers[0].name, code: brokers[0].code }, ledger,
        metrics: [metric('我的客户', customerCards, '人', 'customer'),
          metric('在办案件', caseCards.filter(record => ['已受理', '诉讼中'].includes(record.status)), '件', 'case'),
          metric('已结案', closed, '件', 'case'),
          metric('本月新增签约', customerCards.filter(card => card.signedOn?.startsWith(month)), '人', 'customer')] };
    }
    const brokerCards = brokers.map(broker => {
      const account = one("SELECT status FROM identities WHERE role = 'broker' AND subjectId = ?", broker.id);
      return { id: broker.id, title: broker.name, subtitle: `签约 ${broker.signedOn}`,
        status: account?.status === 'closed' ? '已注销' : account ? '已开户' : '待开户' };
    });
    return { metrics: [metric('券商渠道', brokerCards, '家', 'broker'),
      metric('渠道客户', customerCards, '人', 'customer'),
      metric('有效客户', customerCards.filter(card => card.signedOn), '人', 'customer'),
      metric('已结案', closed, '件', 'case')] };
  }

  function view(actor) {
    if (actor.passwordChangeRequired) return { actor, passwordChangeRequired: true };
    if (actor.role === 'investor') {
      const client = clientById(actor.id);
      const leads = all('SELECT * FROM leads WHERE clientId = ? ORDER BY createdAt DESC, rowid DESC', actor.id);
      return { actor, contact: client.name && client.phone ? { name: client.name, phone: client.phone } : null,
        today: today(), leads: leads.map(lead => ({ ...lead,
        createdOn: businessDate.format(new Date(lead.createdAt)),
        cases: all('SELECT id,title,status,openedOn FROM cases WHERE leadId = ? AND openedOn >= ? ORDER BY openedOn DESC, id', lead.id, caseCutoff) })) };
    }
    if (actor.role === 'admin') {
      const clients = all(`SELECT c.*, s.signedOn, s.reference, b.name AS brokerName, b.salesId, n.number AS signingNumber FROM clients c
        LEFT JOIN signings s ON s.clientId = c.id LEFT JOIN brokers b ON b.id = c.brokerId
        LEFT JOIN report_numbers n ON n.kind = 'signing' AND n.subjectId = s.clientId
        WHERE c.brokerId IS NOT NULL OR c.name IS NOT NULL ORDER BY c.createdAt DESC`);
      return { actor, today: today(), caseCutoff, caseStatuses, clients,
        companies: all(`SELECT co.*,s.name AS salesName,i.status AS salesStatus FROM companies co
          LEFT JOIN sales_staff s ON s.id = co.salesId LEFT JOIN identities i ON i.role = 'sales' AND i.subjectId = co.salesId ORDER BY co.name`)
          .map(company => ({ ...company, aliases: all('SELECT name FROM company_names WHERE companyId = ? AND nameKey != ? ORDER BY name',
            company.id, companyNameKey(company.name)).map(item => item.name).join('，') })),
        assignments: assignedLeads(),
        legacyFollowups: all(`SELECT f.*,c.name,s.name AS salesName FROM followups f JOIN clients c ON c.id = f.clientId
          LEFT JOIN sales_staff s ON s.id = f.salesId ORDER BY f.createdAt DESC,f.rowid DESC`),
        accounts: all(`SELECT i.id,i.username,i.role,i.subjectId,i.status,i.closedAt,i.passwordChangeRequired,
          COALESCE(b.name,s.name,c.name,i.name) AS name FROM identities i
          LEFT JOIN brokers b ON i.role = 'broker' AND b.id = i.subjectId
          LEFT JOIN sales_staff s ON i.role = 'sales' AND s.id = i.subjectId
          LEFT JOIN clients c ON i.role = 'investor' AND c.id = i.subjectId ORDER BY i.id DESC`),
        brokers: all(`SELECT b.*, a.username, a.status AS accountStatus, s.name AS salesName FROM brokers b
          LEFT JOIN identities a ON a.role = 'broker' AND a.subjectId = b.id
          LEFT JOIN sales_staff s ON s.id = b.salesId ORDER BY b.name`),
        sales: all(`SELECT s.id,s.name,a.username,a.status AS accountStatus FROM sales_staff s
          LEFT JOIN identities a ON a.role = 'sales' AND a.subjectId = s.id ORDER BY s.name,s.id`),
        leads: all(`SELECT l.*, COALESCE(a.contactName,c.name) AS name, n.number AS recordNumber FROM leads l JOIN clients c ON c.id = l.clientId
          LEFT JOIN lead_assignments a ON a.leadId = l.id
          LEFT JOIN report_numbers n ON n.kind = 'lead' AND n.subjectId = l.id ORDER BY l.createdAt DESC`),
        cases: all(`SELECT k.*, COALESCE(a.contactName,c.name) AS name, c.brokerId, b.salesId,n.number AS recordNumber FROM cases k JOIN leads l ON l.id = k.leadId
          LEFT JOIN lead_assignments a ON a.leadId = l.id
          JOIN clients c ON c.id = l.clientId LEFT JOIN brokers b ON b.id = c.brokerId LEFT JOIN case_numbers n ON n.caseId = k.id
          WHERE k.openedOn >= ? ORDER BY k.openedOn DESC`, caseCutoff),
        audit: all('SELECT actor,action,subject,details,createdAt FROM audit ORDER BY id DESC LIMIT 30'),
        integrations: { wps: '待提供 WPS 样表、字段映射和授权', wechat: '待提供 AppID、开发者权限和测试环境' } };
    }
    return { actor, today: today(), ...buildBoard(actor), ...(actor.role === 'sales' ? { assignedLeads: assignedLeads(actor.id) } : {}) };
  }

  return { registerInvestor, verifyLogin, createSession, getSession, revokeSession, renameInvestor, captureReferral, redeemReferral,
    resetAccountPassword, setAccountStatus, changePassword,
    issueRecoveryCode, recoverPassword,
    registerBroker, openAccount, openSalesAccount, scan, reassign, addLead, addFollowup,
    saveCompany, assignLead, changeChannelOwner,
    saveSigning, saveCase, searchClients, searchBrokers, view, close: () => db.close() };
}
