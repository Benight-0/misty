#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
test "$(id -u)" -eq 0 || { echo 'Run with sudo.' >&2; exit 1; }
id archival >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/archival --shell /usr/sbin/nologin archival
install -d -m 0755 /opt/archival /opt/archival/bin /opt/archival/build
install -d -m 0750 -o archival -g archival /var/lib/archival /var/lib/archival/data /var/lib/archival/staging
install -d -m 0750 -o root -g archival /etc/archival
if ! swapon --show=NAME --noheadings | grep -q .; then
  if [ ! -e /var/lib/archival.swap ]; then
    fallocate -l 2G /var/lib/archival.swap
    chmod 0600 /var/lib/archival.swap
    mkswap /var/lib/archival.swap >/dev/null
  fi
  swapon /var/lib/archival.swap
  grep -q '^/var/lib/archival.swap ' /etc/fstab || printf '/var/lib/archival.swap none swap sw 0 0\n' >> /etc/fstab
fi
printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-archival.conf
sysctl -p /etc/sysctl.d/90-archival.conf >/dev/null
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils sqlite3 gcc libc6-dev git python3 >/dev/null
python3 - <<'PY'
import hashlib,json,pathlib,subprocess,urllib.request
directory=pathlib.Path('/opt/archival/build')
def download(url,target,checksum):
    with urllib.request.urlopen(url,timeout=120) as response, target.open('wb') as output:
        while chunk:=response.read(1024*1024): output.write(chunk)
    if hashlib.sha256(target.read_bytes()).hexdigest()!=checksum: raise RuntimeError('Download checksum mismatch')
node_base='https://nodejs.org/dist/latest-v22.x/'
sums=urllib.request.urlopen(node_base+'SHASUMS256.txt',timeout=40).read().decode().splitlines()
checksum,filename=next(line.split() for line in sums if line.endswith('-linux-x64.tar.xz'))
target=directory/filename
download(node_base+filename,target,checksum)
subprocess.run(['tar','-xJf',str(target),'-C',str(directory)],check=True)
node_dir=directory/filename.removesuffix('.tar.xz')
subprocess.run(['install','-m','0755',str(node_dir/'bin/node'),'/opt/archival/bin/node'],check=True)
go_releases=json.load(urllib.request.urlopen('https://go.dev/dl/?mode=json',timeout=40))
go_file=next(f for f in go_releases[0]['files'] if f['os']=='linux' and f['arch']=='amd64' and f['kind']=='archive')
target=directory/go_file['filename']
download('https://go.dev/dl/'+go_file['filename'],target,go_file['sha256'])
subprocess.run(['tar','-xzf',str(target),'-C',str(directory)],check=True)
print('Verified Node and Go downloads installed.')
PY
/opt/archival/bin/node --version
/opt/archival/build/go/bin/go version
free -m
