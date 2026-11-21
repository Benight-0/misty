"""Real mouse input on the machine with an interactive desktop.
Windows uses Win32; macOS uses pyobjc-framework-Quartz. Run on the laptop through
an approved Codex task. The headless VM does not have the laptop's desktop.
  mouse.py click X Y        left click at screen points (x, y)
  mouse.py scroll X Y N     scroll N lines at (x, y) (negative = up)
"""
import sys, time
if sys.platform == 'darwin':
    import Quartz as Q


def windows():
    import ctypes
    user32 = ctypes.windll.user32
    user32.SetProcessDPIAware()
    return user32

def post(e):
    Q.CGEventPost(Q.kCGHIDEventTap, e)

def click(x, y):
    if sys.platform == 'win32':
        u = windows()
        if not u.SetCursorPos(int(float(x)), int(float(y))):
            raise RuntimeError('Could not position the mouse on this desktop')
        time.sleep(.05)
        u.mouse_event(0x0002,0,0,0,0)
        u.mouse_event(0x0004,0,0,0,0)
        return
    if sys.platform != 'darwin':
        raise RuntimeError('Run this helper on the Windows/macOS laptop, not the headless VM')
    p = (float(x), float(y))
    post(Q.CGEventCreateMouseEvent(None, Q.kCGEventMouseMoved, p, Q.kCGMouseButtonLeft)); time.sleep(0.05)
    post(Q.CGEventCreateMouseEvent(None, Q.kCGEventLeftMouseDown, p, Q.kCGMouseButtonLeft)); time.sleep(0.05)
    post(Q.CGEventCreateMouseEvent(None, Q.kCGEventLeftMouseUp, p, Q.kCGMouseButtonLeft))

def scroll(x, y, n):
    if sys.platform == 'win32':
        u = windows()
        if not u.SetCursorPos(int(float(x)),int(float(y))):
            raise RuntimeError('Could not position the mouse on this desktop')
        u.mouse_event(0x0800,0,0,int(n)*120,0)
        return
    if sys.platform != 'darwin':
        raise RuntimeError('Run this helper on the Windows/macOS laptop, not the headless VM')
    post(Q.CGEventCreateMouseEvent(None, Q.kCGEventMouseMoved, (float(x), float(y)), Q.kCGMouseButtonLeft))
    for _ in range(abs(int(n))):
        post(Q.CGEventCreateScrollWheelEvent(None, Q.kCGScrollEventUnitLine, 1, -5 if int(n) > 0 else 5)); time.sleep(0.02)

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "click": click(*sys.argv[2:4])
    elif cmd == "scroll": scroll(*sys.argv[2:5])
