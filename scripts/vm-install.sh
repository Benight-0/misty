#!/bin/bash
set -euo pipefail
tar -xzf /tmp/archival-migration/app.tar.gz -C /opt/archival
cp /tmp/archival-migration/main.go /opt/archival/collector-src/main.go
cd /opt/archival/collector-src
export PATH=/opt/archival/build/go/bin:$PATH GOMAXPROCS=1 GOFLAGS=-p=1 GOMEMLIMIT=350MiB
export GOCACHE=/home/ubuntu/.cache/go-build GOMODCACHE=/home/ubuntu/go/pkg/mod
go build -trimpath -ldflags=-s -o /tmp/archival-collector .
install -m 0755 /tmp/archival-collector /opt/archival/bin/archival-collector
if [ ! -e /var/lib/archival/data/archive.sqlite ]; then
 python3 /opt/archival/scripts/vm-migrate-archive.py
fi
runuser -u archival -- /opt/archival/bin/node --disable-warning=ExperimentalWarning /opt/archival/scripts/vm-link-whatsapp.mjs
install -m 0644 /opt/archival/scripts/archival.service /etc/systemd/system/archival.service
systemctl daemon-reload
systemctl enable --now archival.service
systemctl is-active archival.service
