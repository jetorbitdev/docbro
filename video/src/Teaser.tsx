import React from "react";
import { AbsoluteFill, Html5Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import "./fonts";
import { Ai } from "./scenes/Ai";
import { Files } from "./scenes/Files";
import { Hook } from "./scenes/Hook";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { Undo } from "./scenes/Undo";
import { Write } from "./scenes/Write";
import { C } from "./theme";
import { cue, LEAD, OVERLAP, scene, scenes, speaking } from "./timeline";
import { clamp } from "./ui";

const VIEWS: Record<string, React.FC> = { hook: Hook, intro: Intro, files: Files, write: Write, ai: Ai, undo: Undo, outro: Outro };

/** Cross-fades a scene in and out over the overlap with its neighbours. */
const Transition: React.FC<{ first: boolean; last: boolean; children: React.ReactNode }> = ({ first, last, children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeIn = first ? 1 : interpolate(frame, [0, OVERLAP], [0, 1], clamp);
  const fadeOut = last ? 1 : interpolate(frame, [durationInFrames - OVERLAP, durationInFrames], [1, 0], clamp);
  const zoom = interpolate(fadeIn, [0, 1], [1.04, 1]) * interpolate(fadeOut, [0, 1], [0.97, 1]);
  return <AbsoluteFill style={{ opacity: fadeIn * fadeOut, transform: `scale(${zoom})` }}>{children}</AbsoluteFill>;
};

/** A one-shot sound effect at an absolute frame. */
const Sfx: React.FC<{ name: string; at: number; volume?: number }> = ({ name, at, volume = 0.3 }) => (
  <Sequence from={Math.max(0, at)} durationInFrames={75} layout="none">
    <Html5Audio src={staticFile(`sfx/${name}.wav`)} volume={volume} />
  </Sequence>
);

const at = (id: string, word: string, offset = 0, nth = 0) => scene(id).start + cue(id, word, nth) + offset;

// how much of the narration is playing around a frame, so the music dips smoothly under it
const voiceAround = (frame: number) => {
  let hits = 0;
  for (let d = -8; d <= 8; d++) hits += speaking(frame + d) ? 1 : 0;
  return hits / 17;
};

export const Teaser: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.night }}>
      {scenes.map((s, i) => {
        const View = VIEWS[s.id];
        return (
          <Sequence key={s.id} name={s.id} from={s.start} durationInFrames={s.length}>
            <Transition first={i === 0} last={i === scenes.length - 1}>
              <View />
            </Transition>
            <Sequence from={LEAD} layout="none" name={`voice: ${s.id}`}>
              <Html5Audio src={staticFile(s.voice)} />
            </Sequence>
          </Sequence>
        );
      })}

      <Html5Audio
        src={staticFile("music.wav")}
        volume={(f) =>
          interpolate(voiceAround(f), [0, 1], [0.32, 0.13]) *
          interpolate(f, [durationInFrames - 50, durationInFrames - 2], [1, 0], clamp)
        }
      />

      {scenes.slice(1).map((s) => (
        <Sfx key={s.id} name="whoosh" at={s.start - 6} volume={0.18} />
      ))}
      <Sfx name="chime" at={at("intro", "DocBro", -6)} volume={0.22} />
      {["Mac", "Windows", "Linux"].map((w) => (
        <Sfx key={w} name="pop" at={at("intro", w, -4)} volume={0.22} />
      ))}
      {["Word", "Markdown"].map((w) => (
        <Sfx key={w} name="pop" at={at("files", w, -6)} volume={0.22} />
      ))}
      <Sfx name="click" at={at("files", "save")} volume={0.35} />
      <Sfx name="click" at={at("write", "slash")} volume={0.4} />
      {["Headings", "tables", "images"].map((w) => (
        <Sfx key={w} name="pop" at={at("write", w, 4)} volume={0.2} />
      ))}
      {["Claude", "Cursor", "Codex"].map((w) => (
        <Sfx key={w} name="pop" at={at("ai", w, -4)} volume={0.22} />
      ))}
      <Sfx name="click" at={at("undo", "undo", -2)} volume={0.4} />
      <Sfx name="click" at={at("undo", "undo")} volume={0.4} />
      <Sfx name="chime" at={at("outro", "DocBro", -8)} volume={0.28} />
    </AbsoluteFill>
  );
};
