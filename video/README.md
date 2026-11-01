# DocBro teaser

A 43-second product teaser made with Remotion, in two cuts: `DocBroTeaser` (1920×1080) and `DocBroReel` (1080×1920, for Reels, Shorts and TikTok). The voice-over is Microsoft's `en-US-AndrewMultilingualNeural` voice, generated through edge-tts. The music and sound effects are synthesized by `scripts/music.py`.

```bash
pnpm install
pnpm voice     # scripts/script.json -> public/voice/*.mp3 + src/voiceover.json (word timings)
pnpm music     # public/music.wav + public/sfx/*.wav
pnpm studio    # preview and edit in Remotion Studio
pnpm render        # out/docbro-teaser.mp4, loudness-normalised to -14 LUFS
pnpm render:reel   # out/docbro-reel.mp4, the portrait cut
```

To change the narration, edit `scripts/script.json` and run `pnpm voice`. Each scene takes its length from its own clip, and its animations are keyed to the spoken words through `cue(scene, word)` in `src/timeline.ts`. Both cuts share the timeline and audio. Each scene checks `useVertical()` and picks its own portrait layout, which keeps the bottom ~400px clear for the Reels caption and buttons. If you rename a cued word, update the matching `cue` call too, or the composition will throw an error that names the missing word.

Remotion's bundled headless Chrome crashes on this Mac, so `remotion.config.ts` renders with the installed Google Chrome when it finds one.
