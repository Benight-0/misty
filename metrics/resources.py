"""Five-second host counters, independent of private usage databases and traffic."""
from collections import deque
import copy
import os
from pathlib import Path
import threading
import time

INTERVAL = 5
WINDOW = 15 * 60


def read_host(previous):
    fields = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    counters = (sum(fields), fields[3] + fields[4])
    elapsed = counters[0] - previous[0] if previous else 0
    cpu = round(max(0, min(100, 100 * (1 - (counters[1] - previous[1]) / elapsed))), 1) if elapsed > 0 else None
    memory = {k: int(v.split()[0]) * 1024 for k, v in
              (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    total, used = memory['MemTotal'], memory['MemTotal'] - memory['MemAvailable']
    disk = os.statvfs('/')
    disk_total = disk.f_blocks * disk.f_frsize
    disk_used = (disk.f_blocks - disk.f_bfree) * disk.f_frsize
    return counters, dict(cpuPercent=cpu, memoryUsedBytes=used, memoryTotalBytes=total,
                         memoryPercent=round(used / total * 100, 1), diskUsedBytes=disk_used,
                         diskTotalBytes=disk_total, diskAvailableBytes=disk.f_bavail * disk.f_frsize,
                         diskPercent=round(disk_used / disk_total * 100, 1))


class Sampler:
    def __init__(self):
        self.previous = None
        self.history = deque(maxlen=WINDOW // INTERVAL + 1)
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.value = None
        self.thread = None

    def sample(self):
        counters, host = read_host(self.previous)
        now = int(time.time() * 1000)
        self.previous = counters
        with self.lock:
            self.history.append(dict(at=now, cpuPercent=host['cpuPercent'],
                                     memoryPercent=host['memoryPercent']))
            while self.history and self.history[0]['at'] < now - WINDOW * 1000:
                self.history.popleft()
            self.value = dict(schema=1, updatedAt=now, refreshSeconds=INTERVAL,
                              host=host, history=list(self.history))

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.value)

    def run(self):
        while not self.stopped.is_set():
            try:
                self.sample()
            except (OSError, ValueError, KeyError, ZeroDivisionError):
                pass  # Retain the original timestamp; the page will mark it stale.
            self.stopped.wait(INTERVAL)

    def start(self):
        self.thread = threading.Thread(target=self.run, daemon=True, name='host-sampler')
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)
