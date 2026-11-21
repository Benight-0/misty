#!/bin/bash
set -euo pipefail
getent group archival-backup >/dev/null || groupadd --system archival-backup
usermod -aG archival-backup ubuntu
install -d -o root -g archival-backup -m 0750 /var/backups/archival
install -m 0644 /tmp/archival-migration/vm-backup.py /opt/archival/scripts/
install -m 0644 /tmp/archival-migration/archival-backup.service /tmp/archival-migration/archival-backup.timer /etc/systemd/system/
systemd-analyze calendar '*-*-* 03:00:00 Asia/Kolkata'
systemctl daemon-reload
systemctl enable --now archival-backup.timer
systemctl start --no-block archival-backup.service
