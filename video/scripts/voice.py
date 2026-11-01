"""Generates one voice-over clip per script line with Microsoft Edge neural TTS
(edge-tts) and writes each clip's length and word timings to
src/voiceover.json, which the composition reads to size every scene to its
narration and to time the captions.

Run with the interpreter that has edge-tts installed:
  ~/.local/share/uv/tools/edge-tts/bin/python3 scripts/voice.py
"""
import asyncio
import json
import subprocess
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
TICKS_PER_SECOND = 10_000_000  # edge-tts offsets are in 100 ns ticks


async def synth(line: dict, script: dict) -> dict:
    path = ROOT / "public" / "voice" / f"{line['id']}.mp3"
    words = []
    tts = edge_tts.Communicate(
        line["text"], script["voice"], rate=script["rate"], pitch=script["pitch"], boundary="WordBoundary"
    )
    with path.open("wb") as audio:
        async for chunk in tts.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / TICKS_PER_SECOND
                words.append({"text": chunk["text"], "start": round(start, 3),
                              "end": round(start + chunk["duration"] / TICKS_PER_SECOND, 3)})
    seconds = float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]
    ).decode().strip())
    print(f"{line['id']:<6} {seconds:5.2f}s  {line['text']}")
    return {"id": line["id"], "text": line["text"], "file": f"voice/{line['id']}.mp3",
            "seconds": seconds, "words": words}


async def main() -> None:
    script = json.loads((ROOT / "scripts" / "script.json").read_text())
    (ROOT / "public" / "voice").mkdir(parents=True, exist_ok=True)
    lines = [await synth(line, script) for line in script["lines"]]
    out = {"voice": script["voice"], "lines": lines}
    (ROOT / "src" / "voiceover.json").write_text(json.dumps(out, indent=2) + "\n")


asyncio.run(main())
