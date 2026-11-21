"""Generate Misty's short, self-contained notification sound."""

import math
import struct
import wave
from pathlib import Path


rate = 48_000
duration = 0.3
path = Path(__file__).resolve().parents[1] / "desktop/Misty.Overlay/Assets/notification-ping.wav"
frames = bytearray()
for index in range(round(rate * duration)):
    time = index / rate
    envelope = min(1.0, time / 0.008) * math.exp(-12 * time) * min(1.0, (duration - time) / 0.025)
    tone = math.sin(2 * math.pi * 880 * time) + 0.28 * math.sin(2 * math.pi * 1320 * time)
    frames.extend(struct.pack("<h", round(32767 * 0.18 * envelope * tone)))

with wave.open(str(path), "wb") as sound:
    sound.setnchannels(1)
    sound.setsampwidth(2)
    sound.setframerate(rate)
    sound.writeframes(frames)

print(path)
