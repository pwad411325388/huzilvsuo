import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSigningEvidence } from '../signing-evidence.mjs';

test('签约统计隔离模拟节点，只读取仍匹配的原正式快照，不接受过期或损坏备份', t => {
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec(`CREATE TABLE company_record_progress(kind TEXT,record_id TEXT,revision INTEGER,stage TEXT,node TEXT,
    contract_number TEXT,completed_nodes TEXT,next_stage TEXT,next_node TEXT,testing INTEGER);
    CREATE TABLE admin_progress_test_backup(kind TEXT,record_id TEXT,original_snapshot TEXT,applied_snapshot TEXT,generation INTEGER);`);
  const official={revision:1,stage:'intake',node:'signed',contract_number:'',completed_nodes:'[]',next_stage:'',next_node:'',testing:0};
  const simulated={...official,stage:'closure',node:'closed',testing:1};
  function set(kind,id,original,applied=JSON.stringify(simulated)) {
    db.prepare('INSERT INTO company_record_progress VALUES (?,?,?,?,?,?,?,?,?,?)').run(kind,id,...Object.values(simulated));
    db.prepare('INSERT INTO admin_progress_test_backup VALUES (?,?,?,?,?)').run(kind,id,original,applied,1);
  }
  set('registry','no-original','null');
  set('registry','formal-signed',JSON.stringify(official));
  set('registry','formal-cleared',JSON.stringify({...official,stage:'',node:''}));
  set('registry','bad-json','not-json');
  set('registry','stale',JSON.stringify(official),JSON.stringify({...simulated,revision:2}));
  set('lead','formal-lead',JSON.stringify(official));
  set('lead','new-lead','null');
  const signed=createSigningEvidence(db),day='2026-11-20';
  const row={hasSnapshot:true,progressStage:'closure',progressNode:'closed',rawStatus:'未立案',
    sourceProgressStage:'',sourceProgressNode:''};
  assert.equal(signed('registry','no-original',row,day),false);
  assert.equal(signed('registry','no-original',{...row,rawStatus:'已立案'},day),true);
  assert.equal(signed('registry','no-original',{...row,rawStatus:'',sourceProgressStage:'closure',sourceProgressNode:'closed'},day),true);
  assert.equal(signed('registry','formal-signed',row,day),true);
  assert.equal(signed('registry','formal-cleared',{...row,rawStatus:'已立案',filedOn:'2020-01-01'},day),false);
  for(const id of ['bad-json','stale'])assert.equal(signed('registry',id,row,day),false,id);
  assert.equal(signed('lead','formal-lead',row,day),true);
  assert.equal(signed('lead','new-lead',row,day),false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM company_record_progress').get().n,7,'only reads business evidence');
});
