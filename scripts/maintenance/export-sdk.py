from pathlib import Path
import json,hashlib,tarfile,gzip,io,argparse
parser=argparse.ArgumentParser(description='Reproduce the minimal DSH SDK from the frozen snapshot or downloaded SDK, without node_modules or native binaries.')
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args=parser.parse_args(); source=args.source.resolve(); out=args.output.resolve(); out.mkdir(parents=True,exist_ok=True)
lock=json.loads(Path(__file__).with_name('sdk.lock.json').read_text()); packages=lock['packages']; data={}; originals={}
def add(path,relative):
 assert path.is_file() and not path.is_symlink(),path
 b=path.read_bytes();data[relative]=b;originals[relative]=hashlib.sha256(b).hexdigest()
for name,info in sorted(packages.items()):
 directory=info['directory'];p=source/directory;original=p/'package.upstream.json' if (p/'package.upstream.json').exists() else p/'package.json';manifest=json.loads(original.read_text());add(original,directory+'/package.upstream.json')
 for g in ['dependencies','peerDependencies','optionalDependencies']:
  for n,v in manifest.get(g,{}).items():
   if v.startswith('workspace:'):
    if n in packages:manifest[g][n]=packages[n]['version']
    elif n.startswith('@deepseek-ai/node-addon-landlock-run'):manifest[g][n]='0.1.1'
    else:raise Exception((name,n,v))
 manifest.pop('devDependencies',None);manifest.pop('scripts',None)
 manifest['files']=['lib','src','LICENSE','package.upstream.json']
 if name=='@deepseek-ai/cordis':add(p/'bin.js',directory+'/bin.js');manifest['files'].append('bin.js')
 if name=='@deepseek-ai/dsh-subprocess-local':
  add(p/'scripts/ensure-spawn-helper.mjs',directory+'/scripts/ensure-spawn-helper.mjs');manifest['files'].append('scripts');manifest['scripts']={'postinstall':'node scripts/ensure-spawn-helper.mjs'}
 data[directory+'/package.json']=(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n').encode()
 for folder in ['src','lib']:
  for f in sorted((p/folder).rglob('*')):
   if not f.is_file():continue
   relative=f.relative_to(p)
   if any(x in {'node_modules','__tests__','__fixtures__','tests','fixtures'} for x in relative.parts) or f.name.endswith(('.test.ts','.spec.ts','.tsbuildinfo')):continue
   if f.suffix not in {'.ts','.js','.mjs','.json','.map','.md','.cjs'}:raise Exception(('unexpected runtime file',str(f)))
   add(f,directory+'/'+relative.as_posix())
 license=p/'LICENSE' if (p/'LICENSE').is_file() else source/'LICENSE';data[directory+'/LICENSE']=license.read_bytes()
for name in ['LICENSE','THIRD_PARTY_NOTICES.md']:add(source/name,name)
provenance={'name':'CoNest frozen DSH development SDK','version':'20260915','upstream':'https://github.com/deepseek-ai/deepseek-harness','upstreamVersion':'0.1.0-rc.5','upstreamCommit':None,'note':'Minimal runtime/peer closure from the preserved development snapshot. Not an official upstream release. No node_modules, native binaries, OS dependencies or runtime state. Original manifests retained as package.upstream.json; consumer manifests resolve workspace versions and omit development scripts. src/lib bytes are preserved.','packages':packages,'originalFiles':originals,'files':{n:hashlib.sha256(b).hexdigest() for n,b in sorted(data.items())}}
data['sdk.json']=(json.dumps(provenance,indent=2)+'\n').encode()
archive=out/'conest-dsh-sdk-20260915.tar.gz'
with archive.open('wb') as raw:
 with gzip.GzipFile(fileobj=raw,mode='wb',filename='',mtime=0) as gz:
  with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as tf:
   for name,content in sorted(data.items()):
    info=tarfile.TarInfo(name);info.size=len(content);info.mode=0o644;info.mtime=0;tf.addfile(info,io.BytesIO(content))
digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
(archive.with_suffix(archive.suffix+'.sha256')).write_text(digest+'  '+archive.name+'\n')
(out/'sdk.json').write_bytes(data['sdk.json'])
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'files':len(data),'packages':len(packages),'sha256':digest}))
