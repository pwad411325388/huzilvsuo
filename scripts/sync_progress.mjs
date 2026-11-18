import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createStore, RequestError } from '../store.mjs';

// Local company-system adapter. The mini program only reads the resulting snapshots.
const usage = '用法：node scripts/sync_progress.mjs <进度快照.json> [--db <现有数据库文件>]';
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error(usage);
  const dbPath = values.db || process.env.DEMO_DB || fileURLToPath(new URL('../.runtime/demo.sqlite', import.meta.url));
  if (!(await stat(dbPath)).isFile()) throw new Error('请选择已初始化的项目数据库');
  let items;
  const content = await readFile(positionals[0], 'utf8');
  try { items = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new Error('快照文件须为有效 JSON'); }
  if (!Array.isArray(items)) throw new Error('快照文件须为记录数组');
  const store = createStore(dbPath);
  try {
    const { updated, unchanged } = store.syncProgress(items);
    console.log(`已核对 ${items.length} 条进度快照，更新 ${updated} 条，已有同版 ${unchanged} 条。`);
  } finally { store.close(); }
}

main().catch(error => {
  const message = error instanceof RequestError ? error.message :
    error.code === 'ENOENT' ? '找不到快照或数据库文件' : (error instanceof SyntaxError ? '无法解析快照' : error.message);
  console.error(message);
  process.exitCode = 1;
});
