"""One isolated VM process for delegated workers and the scheduled supervisor."""
import fcntl
import os
import signal
import threading
import time

import agent_worker
import config
import supervisor


def main():
    lock = open(config.data('agent_runtime.lock'), 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    parent = int(os.environ.get('MISTY_AGENT_PARENT_PID', '0'))
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    roles = ('coding', 'analysis') if config.enabled('multi_agent_enabled') else ()
    threads = [threading.Thread(target=agent_worker.worker_loop, args=(role, stop), daemon=True)
               for role in roles]
    if config.enabled('supervisor_enabled'):
        threads.append(threading.Thread(target=supervisor.loop, args=(stop,), daemon=True))
    for thread in threads: thread.start()
    while not stop.wait(5):
        if parent:
            try:
                os.kill(parent, 0)
            except (ProcessLookupError, PermissionError):
                stop.set()
    for thread in threads: thread.join(timeout=8)


if __name__ == '__main__': main()
