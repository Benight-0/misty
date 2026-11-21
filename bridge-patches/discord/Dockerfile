FROM golang:1.26.6-alpine3.24 AS builder
RUN apk add --no-cache git ca-certificates build-base olm-dev python3
WORKDIR /build
RUN git init . && git remote add origin https://github.com/mautrix/discord.git && git fetch --depth=1 origin c62165a46109d7c824bc0b4bb067ba02ea6528f1 && git checkout --detach FETCH_HEAD
COPY prioritize-dms.py /tmp/prioritize-dms.py
RUN python3 /tmp/prioritize-dms.py && go build -o /usr/bin/mautrix-discord
COPY repair-dm.go /build/archival-repair-dm.go
RUN python3 -c 'from pathlib import Path; p=Path("commands.go"); s=p.read_text(); assert s.count("\t\tcmdCreatePortal,")==1; p.write_text(s.replace("\t\tcmdCreatePortal,", "\t\tcmdCreatePortal,\n\t\tcmdRepairDM,"))' && gofmt -w archival-repair-dm.go && go build -o /usr/bin/mautrix-discord
COPY ensure-dm-sender.py /tmp/ensure-dm-sender.py
RUN python3 /tmp/ensure-dm-sender.py && gofmt -w portal.go && go build -o /usr/bin/mautrix-discord
COPY history-sync.go /build/archival-history-sync.go
COPY history-sync.py /tmp/history-sync.py
RUN python3 /tmp/history-sync.py && gofmt -w portal.go archival-history-sync.go && go build -o /usr/bin/mautrix-discord

FROM dock.mau.dev/mautrix/discord:v0.7.7
RUN apk add --no-cache olm
COPY --from=builder /usr/bin/mautrix-discord /usr/bin/mautrix-discord
RUN /usr/bin/mautrix-discord --version
