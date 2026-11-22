"""Build after npm ci and npm run build. Only the audited default-owner probe, its three compiled modules, and ws ship. No hooks, tokens or state."""
from hashlib import sha256
from pathlib import Path
from sys import argv
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
root = Path(__file__).resolve().parents[1]
files = ['scripts/verify-default-owner.mjs', 'docs/WINDOWS-CANDIDATE.md', 'package.json', 'test/fixtures/app-server.cjs']
for name in ['codex', 'servers', 'rpc-diagnostics']:
    files.extend(['src/'+name+'.ts', 'dist/src/'+name+'.js'])
ws = root/'node_modules/ws'
files.extend(str(p.relative_to(root)).replace('\\','/') for p in ws.rglob('*') if p.is_file() and (p.suffix in ['.js','.mjs'] or p.name in ['LICENSE','package.json']))
dest=Path(argv[1]); assert dest.suffix == '.zip'
with ZipFile(dest,'x',compression=ZIP_DEFLATED) as z:
    def add(name,data):
        info=ZipInfo(name,(2026,11,22,0,0,0));info.compress_type=ZIP_DEFLATED;z.writestr(info,data)
    sums=[]
    for f in sorted(set(files)):
        p=root/f
        assert p.is_file() and not p.is_symlink()
        data=p.read_bytes();add(f,data);sums.append(sha256(data).hexdigest()+'  '+f)
    add('SHA256SUMS',('\n'.join(sums)+'\n').encode())
print(sha256(dest.read_bytes()).hexdigest(),dest.name,dest.stat().st_size)
