"""Synthesizes the teaser's music bed and sound effects, so the video carries
no third-party audio. Writes public/music.wav and public/sfx/*.wav.

  uv run --no-project --with numpy python scripts/music.py
"""
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SR = 44_100
rng = np.random.default_rng(7)


def write(path: Path, x: np.ndarray) -> None:
    x = x / max(1e-9, np.abs(x).max()) * 0.89
    stereo = x if x.ndim == 2 else np.stack([x, x], axis=1)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def lowpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def soft_saw(f: float, t: np.ndarray, harmonics: int = 7) -> np.ndarray:
    return sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, harmonics + 1))


# ------------------------------------------------------------------ music bed
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
DUR = 48.0
t = np.arange(int(DUR * SR)) / SR

# D major: Dmaj9, Bm9, Gmaj7, A6sus; two bars each
CHORDS = [[50, 57, 61, 64, 66], [47, 54, 57, 61, 62], [43, 50, 54, 57, 62], [45, 52, 54, 57, 62]]
CHORD_LEN = 2 * BAR


def chord_at(time: float) -> list[int]:
    return CHORDS[int(time // CHORD_LEN) % len(CHORDS)]


pad = np.zeros_like(t)
n_chords = int(np.ceil(DUR / CHORD_LEN))
for c in range(n_chords):
    start, end = c * CHORD_LEN, (c + 1) * CHORD_LEN
    lo, hi = int(max(0, start - 0.6) * SR), int(min(DUR, end + 0.6) * SR)
    seg = t[lo:hi]
    env = np.clip((seg - (start - 0.6)) / 1.2, 0, 1) * np.clip(((end + 0.6) - seg) / 1.2, 0, 1)
    tone = np.zeros_like(seg)
    for note in CHORDS[c % len(CHORDS)]:
        for detune in (-0.08, 0.0, 0.08):
            tone += soft_saw(hz(note + detune), seg, 5)
    pad[lo:hi] += tone * env
pad = lowpass(pad, 900) * 0.5
pad *= 0.55 + 0.45 * np.clip(t / 6, 0, 1)  # swells in under the hook

# arpeggio, eighth notes, from bar 2
arp = np.zeros_like(t)
step = BEAT / 2
for i in range(int(DUR / step)):
    start = i * step
    if start < BAR * 2 or start > DUR - 3.5:
        continue
    chord = chord_at(start)
    note = chord[[1, 2, 3, 4, 3, 2, 4, 3][i % 8]] + 12
    n = int(0.9 * SR)
    lo = int(start * SR)
    seg = np.arange(min(n, len(t) - lo)) / SR
    env = np.exp(-seg * 6.5) * np.clip(seg / 0.004, 0, 1)
    f = hz(note)
    arp[lo:lo + len(seg)] += (np.sin(2 * np.pi * f * seg) + 0.25 * np.sin(4 * np.pi * f * seg)) * env
arp *= 0.22

# kick on the beat and offbeat hats, building through the middle
kick = np.zeros_like(t)
hats = np.zeros_like(t)
duck = np.ones_like(t)
for i in range(int(DUR / BEAT)):
    start = i * BEAT
    lo = int(start * SR)
    if BAR * 4 <= start < DUR - 4.0:
        seg = np.arange(int(0.45 * SR)) / SR
        seg = seg[: len(t) - lo]
        freq = 45 + 75 * np.exp(-seg * 30)
        phase = 2 * np.pi * np.cumsum(freq) / SR
        kick[lo:lo + len(seg)] += np.sin(phase) * np.exp(-seg * 9)
        duck[lo:lo + len(seg)] = np.minimum(duck[lo:lo + len(seg)], 1 - 0.45 * np.exp(-seg * 7))
    if BAR * 8 <= start < DUR - 4.0:
        hlo = int((start + BEAT / 2) * SR)
        seg = np.arange(int(0.08 * SR)) / SR
        seg = seg[: max(0, len(t) - hlo)]
        noise = rng.standard_normal(len(seg))
        noise = noise - lowpass(noise, 6000)
        hats[hlo:hlo + len(seg)] += noise * np.exp(-seg * 60)

mix = pad * duck + arp * duck + kick * 0.55 + hats * 0.05
fade_out = np.clip((DUR - t) / 4.0, 0, 1)
mix *= fade_out * np.clip(t / 0.8, 0, 1)
pan = 0.15 * np.sin(2 * np.pi * t / 7)
write(ROOT / "public" / "music.wav", np.stack([mix * (1 - pan), mix * (1 + pan)], axis=1))

# ------------------------------------------------------------------ sound effects
def whoosh() -> np.ndarray:
    n = int(0.7 * SR)
    s = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    # band of noise whose centre rises then falls, made by differencing two lowpasses
    for k in range(0, n, 512):
        pos = k / n
        centre = 300 + 2600 * np.sin(np.pi * pos)
        chunk = noise[k:k + 512]
        out[k:k + 512] = lowpass(chunk, centre * 1.4) - lowpass(chunk, centre * 0.6)
    return out * np.sin(np.pi * s / s[-1]) ** 2


def pop() -> np.ndarray:
    s = np.arange(int(0.14 * SR)) / SR
    f = 520 + 380 * np.exp(-s * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-s * 28)


def click() -> np.ndarray:
    s = np.arange(int(0.05 * SR)) / SR
    noise = rng.standard_normal(len(s))
    body = np.sin(2 * np.pi * 1800 * s) * 0.4
    return ((noise - lowpass(noise, 2500)) * 0.7 + body) * np.exp(-s * 120)


def chime() -> np.ndarray:
    s = np.arange(int(2.2 * SR)) / SR
    out = np.zeros_like(s)
    for delay, note in ((0.0, 74), (0.11, 81), (0.22, 86)):
        d = s - delay
        on = d >= 0
        f = hz(note)
        out[on] += (np.sin(2 * np.pi * f * d[on]) + 0.3 * np.sin(2 * np.pi * f * 2.76 * d[on])) * np.exp(-d[on] * 2.6)
    return out


for name, fn in (("whoosh", whoosh), ("pop", pop), ("click", click), ("chime", chime)):
    write(ROOT / "public" / "sfx" / f"{name}.wav", fn())
print("wrote public/music.wav and public/sfx/*.wav")
