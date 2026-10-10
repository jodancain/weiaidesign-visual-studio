#!/usr/bin/env python3
"""Select reviewed Studio projects from an online SQLite backup; never copy paid jobs."""
import argparse, hashlib, json, shutil, sqlite3, tarfile
from pathlib import Path
from datetime import datetime, timezone
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--backup',type=Path,required=True)
parser.add_argument('--project',action='append',required=True)
args=parser.parse_args()
if args.output.exists():raise SystemExit('Refusing to overwrite an existing export directory')
args.output.mkdir(parents=True);args.backup.parent.mkdir(parents=True,exist_ok=True)
if args.backup.exists():raise SystemExit('Refusing to overwrite an existing online backup')
source=sqlite3.connect(f'file:{args.source / "studio.sqlite"}?mode=ro',uri=True)
backup=sqlite3.connect(args.backup);source.backup(backup);source.close()
# A standalone frozen backup must not depend on creating WAL/shm files when opened read-only.
backup.execute('PRAGMA journal_mode=DELETE');backup.close();args.backup.chmod(0o600)
source=sqlite3.connect(f'file:{args.backup}?mode=ro',uri=True);source.row_factory=sqlite3.Row
assert source.execute('PRAGMA quick_check').fetchone()[0]=='ok'
target=sqlite3.connect(args.output/'studio.sqlite')
for row in source.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"):
 target.execute(row['sql'])
target.execute('PRAGMA user_version=2');summary=[]
for project_id in args.project:
 row=source.execute('SELECT * FROM projects WHERE id=?',(project_id,)).fetchone()
 if not row:raise ValueError('Project missing: '+project_id)
 project=json.loads(row['json'])
 if any(shot.get('takes') or shot.get('approval') for shot in project['shots']):raise ValueError('Reviewed release seed must not copy approved/paid shots')
 for table in ['projects','assets','history','command_receipts']:
  key='id' if table=='projects' else 'project_id'
  for record in source.execute(f'SELECT * FROM {table} WHERE {key}=?',(project_id,)):
   values=dict(record)
   if table=='assets':
    asset=json.loads(values['json']);data=Path(values['path']).read_bytes()
    if hashlib.sha256(data).hexdigest()!=asset['hash']:raise ValueError('Asset hash mismatch')
    dest=args.output/'assets'/asset['hash'];dest.parent.mkdir(exist_ok=True);dest.write_bytes(data)
    values['path']='/data/studio/assets/'+asset['hash']
   columns=','.join(values);marks=','.join('?' for _ in values)
   target.execute(f'INSERT INTO {table} ({columns}) VALUES ({marks})',tuple(values.values()))
 summary.append({'id':project_id,'revision':project['revision'],'assets':len(project['assets']),'projectHash':hashlib.sha256(row['json'].encode()).hexdigest()})
target.commit();assert target.execute('PRAGMA quick_check').fetchone()[0]=='ok';assert not target.execute('PRAGMA foreign_key_check').fetchall()
assert target.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]==0 and target.execute('SELECT COUNT(*) FROM job_receipts').fetchone()[0]==0
target.close();source.close()
manifest={'at':datetime.now(timezone.utc).isoformat(),'projects':summary,'jobs':0,'jobReceipts':0,'paidApprovals':0,'onlineBackup':str(args.backup),'assetBytes':sum(p.stat().st_size for p in (args.output/'assets').iterdir()),'files':{str(p.relative_to(args.output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.output.rglob('*')) if p.is_file()}}
(args.output/'release-data-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
bundle=args.output.with_suffix('.tar.gz')
with tarfile.open(bundle,'w:gz') as stream:
 for p in args.output.rglob('*'):
  if p.is_file():stream.add(p,arcname=str(p.relative_to(args.output)))
print(json.dumps({'projects':summary,'assetsBytes':manifest['assetBytes'],'jobs':0,'bundle':str(bundle),'bundleSha256':hashlib.sha256(bundle.read_bytes()).hexdigest()}))
