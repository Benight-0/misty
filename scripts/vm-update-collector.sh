#!/bin/bash
set -euo pipefail
cp /tmp/archival-migration/main.go /opt/archival/collector-src/main.go
cd /opt/archival/collector-src
export PATH=/opt/archival/build/go/bin:$PATH GOMAXPROCS=1 GOFLAGS=-p=1 GOMEMLIMIT=350MiB
export GOCACHE=/home/ubuntu/.cache/go-build GOMODCACHE=/home/ubuntu/go/pkg/mod
go build -trimpath -ldflags=-s -o /tmp/archival-collector .
systemctl stop archival.service
install -m 0755 /tmp/archival-collector /opt/archival/bin/archival-collector
cp /tmp/archival-migration/server.mjs /tmp/archival-migration/native-ingest.mjs /tmp/archival-migration/native-runtime.mjs /opt/archival/app/
cp /tmp/archival-migration/app.js /opt/archival/app/public/
printf 'ARCHIVAL_ANALYSIS=on\n' > /etc/archival/runtime.env
chmod 0640 /etc/archival/runtime.env
chown root:archival /etc/archival/runtime.env
systemctl start archival.service
systemctl is-active archival.service
