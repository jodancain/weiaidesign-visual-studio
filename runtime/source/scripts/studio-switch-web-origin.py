#!/usr/bin/env python3
"""Switch exactly the four Studio web ingress services, preserving all other bytes."""
import argparse,hashlib,json,os,re,subprocess,tempfile
from datetime import datetime,timezone
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--to-port',choices=['18191','18194'],required=True);p.add_argument('--apply',action='store_true');p.add_argument('--receipt',type=Path,required=True);args=p.parse_args()
config=Path.home()/'.cloudflared/byd.yml'
raw=config.read_bytes();lines=raw.decode().splitlines(keepends=True)
hosts={'weiaidesign.youngtuo.win','weiaidesign.com','www.weiaidesign.com','visual.youngtuo.win'}
seen=set();current=None;changes=[];output=[]
for line in lines:
    match=re.match(r'\s*- hostname:\s*([^\s]+)',line)
    if match:current=match.group(1)
    if current in hosts and re.match(r'\s*service:',line):
        match=re.fullmatch(r'(\s*service: http://100\.84\.235\.123:)(18191|18194)(\r?\n?)',line)
        if not match:raise SystemExit('Unexpected service for '+current+'; no changes made')
        if current in seen:raise SystemExit('Duplicate hostname; no changes made')
        seen.add(current);new=match.group(1)+args.to_port+match.group(3)
        changes.append({'host':current,'from':match.group(2),'to':args.to_port});line=new
    output.append(line)
if seen!=hosts:raise SystemExit('Missing expected hostname; no changes made')
updated=''.join(output).encode()
backupDir=config.parent/'backups'/'studio-v3-20261001';backupDir.mkdir(parents=True,exist_ok=True);os.chmod(backupDir,0o700)
backup=backupDir/('byd-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.yml')
backup.write_bytes(raw);os.chmod(backup,0o600)
with tempfile.NamedTemporaryFile(prefix='studio-ingress-',suffix='.yml',dir=config.parent,delete=False) as f:f.write(updated);candidate=Path(f.name)
try:
    run=subprocess.run(['/opt/homebrew/bin/cloudflared','tunnel','--config',str(candidate),'ingress','validate'],capture_output=True,text=True)
    if run.returncode:raise SystemExit('Candidate ingress validation failed; config unchanged')
    if args.apply:
        if config.read_bytes()!=raw:raise SystemExit('Config changed concurrently; no changes made')
        os.chmod(candidate,config.stat().st_mode&0o777);os.replace(candidate,config)
    result={'at':datetime.now(timezone.utc).isoformat(),'applied':args.apply,'changes':changes,'beforeSha256':hashlib.sha256(raw).hexdigest(),'afterSha256':hashlib.sha256(updated).hexdigest(),'backup':str(backup),'otherLinesUnchanged':True,'validation':'passed','serviceRestartRequired':args.apply}
    args.receipt.parent.mkdir(parents=True,exist_ok=True);args.receipt.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
finally:candidate.unlink(missing_ok=True)
