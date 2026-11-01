import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from "remotion";
import { C } from "../theme";
import { cue } from "../timeline";
import { clamp, Backdrop, useVertical, Words } from "../ui";

// Loose pages drifting in the dark: documents with nowhere to live.
const PAGES = Array.from({ length: 14 }, (_, i) => ({
  x: random(`x${i}`),
  y: random(`y${i}`),
  rot: (random(`r${i}`) - 0.5) * 50,
  scale: 0.45 + random(`s${i}`) * 0.65,
  speed: 0.3 + random(`v${i}`) * 0.6,
  broken: random(`b${i}`) > 0.55,
}));

const Page: React.FC<{ broken: boolean }> = ({ broken }) => (
  <div style={{ width: 210, height: 280, borderRadius: 10, background: C.cream, padding: "30px 24px", boxShadow: "0 20px 50px #0009" }}>
    <div style={{ height: 14, width: "70%", borderRadius: 7, background: C.brand, opacity: 0.85, marginBottom: 22 }} />
    {[100, 92, 100, 64, 88, 96].map((w, i) => (
      <div
        key={i}
        style={{
          height: 9,
          width: `${w}%`,
          borderRadius: 5,
          background: broken && i % 2 ? "#c2543d" : "#1d1f1c",
          opacity: broken && i % 2 ? 0.55 : 0.18,
          marginBottom: 13,
          marginLeft: broken && i === 3 ? 40 : 0,
          transform: broken && i === 4 ? "rotate(-4deg)" : undefined,
        }}
      />
    ))}
  </div>
);

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const vertical = useVertical();
  // the pages are pulled into the centre as the scene hands over to the logo
  const pull = interpolate(frame, [durationInFrames - 24, durationInFrames], [0, 1], clamp);
  const intro = interpolate(frame, [0, 20], [0, 1], clamp);

  return (
    <AbsoluteFill>
      <Backdrop glowY={50} />
      {PAGES.map((p, i) => {
        const x = p.x * width + Math.sin((frame + i * 20) / 40) * 12;
        const y = p.y * height - frame * p.speed;
        const tx = interpolate(pull, [0, 1], [x, width / 2]);
        const ty = interpolate(pull, [0, 1], [y, height / 2]);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: tx - 105,
              top: ty - 140,
              opacity: intro * 0.32 * (1 - pull),
              transform: `rotate(${p.rot + frame * 0.05 * (i % 2 ? 1 : -1)}deg) scale(${p.scale * (1 - pull * 0.8)})`,
              filter: `blur(${(1 - p.scale) * 6}px)`,
            }}
          >
            <Page broken={p.broken} />
          </div>
        );
      })}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: 1 - pull }}>
        <Words
          size={vertical ? 112 : 104}
          style={{ justifyContent: "center", maxWidth: vertical ? 900 : 1300, textAlign: "center" }}
          words={[
            { text: "Your", at: cue("hook", "Your") - 3 },
            { text: "documents", at: cue("hook", "documents") - 3 },
            { text: "deserve", at: cue("hook", "deserve") - 3 },
            { text: "a", at: cue("hook", "a") - 3 },
            { text: "better", at: cue("hook", "better") - 3, color: C.accentInk },
            { text: "home.", at: cue("hook", "home") - 3, color: C.accentInk },
          ]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
