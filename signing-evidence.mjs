import { hasSigningEvidence, hasRegistrySigningEvidence } from './data-semantics.mjs';

const recordKey = (kind, id) => JSON.stringify([kind, id]);
const fields = ['revision','stage','node','contract_number','completed_nodes','next_stage','next_node','testing'];
const empty = { hasSnapshot: false, progressStage: '', progressNode: '', completedNodes: '[]' };

// Create per read transaction, never cache across requests. Callers pass only
// authorized rows; temporary test snapshots must not become signing evidence.
export function createSigningEvidence(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(company_record_progress)').all().map(row=>row.name));
  const originals = new Map();
  if (columns.has('testing')) {
    const backup = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_progress_test_backup'").get();
    const selection = fields.map(field => columns.has(field) ? 'p.'+field :
      (field === 'revision' || field === 'testing' ? '0' : field === 'completed_nodes' ? "'[]'" : "''")+' AS '+field).join(',');
    const rows = db.prepare(`SELECT p.kind,p.record_id,${selection},
      ${backup ? 'b.original_snapshot,b.applied_snapshot' : 'NULL AS original_snapshot,NULL AS applied_snapshot'}
      FROM company_record_progress p ${backup ? 'LEFT JOIN admin_progress_test_backup b ON b.kind=p.kind AND b.record_id=p.record_id' : ''}
      WHERE p.testing=1`).all();
    for (const row of rows) {
      const {kind,record_id,original_snapshot,applied_snapshot,...current}=row;
      const key=recordKey(kind,record_id);
      originals.set(key,undefined);
      if (typeof original_snapshot!=='string' || JSON.stringify(current)!==applied_snapshot) continue;
      try {
        const original=JSON.parse(original_snapshot);
        if (original===null) originals.set(key,null);
        else if (original && !Array.isArray(original) && original.testing===0 &&
          typeof original.stage==='string' && typeof original.node==='string' && typeof original.completed_nodes==='string') {
          originals.set(key,original);
        }
      } catch { /* Invalid backups cannot confirm a real signing. */ }
    }
  }
  return (kind,id,row,currentDay) => {
    const key=recordKey(kind,id);
    let formal=row;
    if (originals.has(key)) {
      const original=originals.get(key);
      if (original===undefined) return false;
      formal=original===null ? {...row,...empty,
        progressStage:kind==='registry' ? row.sourceProgressStage || '' : '',
        progressNode:kind==='registry' ? row.sourceProgressNode || '' : ''}
        : {...row,hasSnapshot:true,progressStage:original.stage,progressNode:original.node,completedNodes:original.completed_nodes};
    }
    return kind==='registry' ? hasRegistrySigningEvidence(formal,currentDay) : hasSigningEvidence(formal);
  };
}
