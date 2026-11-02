#!/usr/bin/env python3
"""Package an already-tested checkout. No publishing, credentials or dependencies."""
import argparse, gzip, hashlib, io, json, os, re, subprocess, tarfile, stat
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--tag',required=True)
parser.add_argument('--output',default='release-assets')
args=parser.parse_args()
m=re.fullmatch(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|beta|rc)\.(0|[1-9]\d*)',args.tag)
if not m: raise SystemExit('Expected strict vX.Y.Z-alpha|beta|rc.N prerelease tag')
root=Path(__file__).resolve().parents[1]
version='.'.join(m.group(1,2,3))
if json.loads((root/'package.json').read_text())['version'] != version: raise SystemExit('Tag/package version mismatch')
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
if os.environ.get('GITHUB_SHA') and os.environ['GITHUB_SHA'] != sha: raise SystemExit('Checkout SHA mismatch')
subprocess.run(['git','diff','--exit-code','HEAD','--'],cwd=root,check=True,stdout=subprocess.DEVNULL)
mtime=int(subprocess.check_output(['git','show','-s','--format=%ct',sha],cwd=root,text=True))
# Positive source allowlist, and tracked-only: never include environment/state/node_modules.
names=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
exact={'package.json','package-lock.json','tsconfig.json','README.md','PLAN.md','config.example.json','slack-app-manifest.json','.gitignore','.env.example'}
prefixes=('src/','test/','docs/','skills/codex-connector/','scripts/')
def checked_bytes(name):
 p=root/name
 if p.resolve() != p or not p.resolve().is_relative_to(root):raise SystemExit('Symlinked/escaped parent cannot be packaged')
 if not stat.S_ISREG(p.lstat().st_mode):raise SystemExit('Only regular non-symlink files may be packaged')
 if name != '.env.example':
  for part in Path(name).parts:
   low=part.lower()
   if low in {'.git','.aws','.ssh','.codex','node_modules','config.json','state.json','auth.json','api.token','service.env','daemon.env','daemon.lock'} or low.startswith(('.env','credentials','state.')) or low.endswith(('.token','.pem','.key','.p12','.pfx','.env')):
    raise SystemExit('Private/config/state filename cannot be packaged: '+name)
 data=p.read_bytes()
 if re.search(r'(?:xox[baprs]-[A-Za-z0-9]{15,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)',data.decode()):raise SystemExit('Potential secret in '+name)
 return data
files={n:checked_bytes(n) for n in names if n and (n in exact or n.startswith(prefixes))}
required={'package.json','package-lock.json','docs/MACOS-SETUP.md','src/cli.ts','skills/codex-connector/SKILL.md'}
if not required.issubset(files):raise SystemExit('Missing required tracked files')
compiled={str(p.relative_to(root)):checked_bytes(str(p.relative_to(root))) for p in (root/'dist/src').glob('*.js')}
if 'dist/src/cli.js' not in compiled:raise SystemExit('Run build/tests before packaging')
out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
if any(out.iterdir()):raise SystemExit('Output directory must be empty')
prefix='codex-connector-'+args.tag.removeprefix('v')+'/'
def archive(name,items):
 with (out/name).open('wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',filename='',mtime=0) as gz,tarfile.open(fileobj=gz,mode='w') as tar:
  for name,data in sorted(items.items()):
   info=tarfile.TarInfo(prefix+name);info.size=len(data);info.mode=0o644;info.mtime=mtime
   tar.addfile(info,io.BytesIO(data))
info=json.dumps({'release':args.tag,'sourceCommit':sha,'sourcePackageVersion':version,'kind':'portable-node','node':'>=22','nativeMacOSVerified':False,'liveSlackVerified':False,'liveSharedSessionTakeoverVerified':False},indent=2)+'\n'
archive(f'codex-connector-{args.tag}-source.tar.gz',files)
archive(f'codex-connector-{args.tag}-node.tar.gz',{**files,**compiled,'RELEASE-INFO.json':info.encode()})
(out/'RELEASE-INFO.json').write_text(info)
(out/'MACOS-SETUP.md').write_bytes(files['docs/MACOS-SETUP.md'])
notes=f'''# Codex Connector {args.tag} — macOS 首轮实测预发布

目标提交：`{sha}`。这是可移植 Node.js 包，不是签名/公证的 macOS 应用；Intel/Apple Silicon 都需本机适配的 Node.js 22+ 和 Codex。

## 下载与启动
**portable 包不是免依赖独立程序。必须先执行 npm ci 安装运行时依赖，再执行 init；不要跳过。**
- `*-node.tar.gz`：预构建 JavaScript；解压后运行 `npm ci --omit=dev --ignore-scripts`。
- `*-source.tar.gz`：源码；运行 `npm ci --ignore-scripts && npm run build`。
- 运行 `node dist/src/cli.js init`，按附件 **MACOS-SETUP.md** 创建 Slack App、填写身份/频道/项目/Codex路径并安全配置令牌。先 `doctor`、前台 `start`、`status`，通过后再考虑 login LaunchAgent。
- 使用 `shasum -a 256 -c SHA256SUMS` 校验下载附件；源码内 package.json 仍为 {version}，tag 标记预发布渠道，不是稳定版。

## 边界与验收
自动化使用 Node.js22 构建、严格类型检查和 mock/fake 测试；不运行真实 Codex、不连接 Slack、不安装服务、不发布 npm。
当前协议证据来自 Codex 0.166.0-alpha.1；不同版本须验证共享 proxy/queue 能力。`sessionPolicy.allowAllSharedSessions` 和 `backend.autoStartDaemon` 都默认false，只由本机操作者选择；前者不扩大文件根，后者遵循 Codex 自身daemon/updater策略，不能与显式socketPath组合。

**真实 macOS、Slack、活动共享会话接管、跨客户端审批及睡眠唤醒仍未验收。** 合并/Actions成功不代表这些已验证。请先用可丢弃测试会话检查 help→capabilities→list→attach→send→人工审批，再测试重连；不要批量绑定生产会话或发送真实秘密。详见完整配置指南和 docs/RUNTIME-VERIFICATION.md。\n'''
(out/'RELEASE-NOTES.zh-CN.md').write_text(notes)
with (out/'SHA256SUMS').open('w') as sums:
 for p in sorted(out.iterdir()):
  if p.name!='SHA256SUMS':sums.write(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n')
print(json.dumps({'tag':args.tag,'sha':sha,'files':[p.name for p in sorted(out.iterdir())]}))
