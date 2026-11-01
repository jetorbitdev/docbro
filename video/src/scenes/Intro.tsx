import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { cue } from "../timeline";
import { AppIcon, clamp, Backdrop, Pill, Rise, useEnter, useRamp, useVertical } from "../ui";

const PLATFORMS = [
  { label: "macOS", word: "Mac" },
  { label: "Windows", word: "Windows" },
  { label: "Linux", word: "Linux" },
];

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const logoAt = cue("intro", "DocBro") - 6;
  const icon = useEnter(logoAt, 11, 0.9);
  // the logo lifts to make room for the tagline when "A fast…" starts
  const lift = useRamp(cue("intro", "A") - 8, cue("intro", "A") + 10);
  const name = "DocBro";
  const vertical = useVertical();
  // portrait: a smaller lock-up that lifts further, and the tagline on two lines
  const k = vertical ? 0.8 : 1;
  const liftBy = vertical ? 200 : 120;

  return (
    <AbsoluteFill>
      <Backdrop glowY={44} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `translateY(${-lift * liftBy}px)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 44 * k * (1 - lift * 0.3) }}>
          <AppIcon
            size={(220 - lift * 80) * k}
            style={{
              transform: `scale(${icon}) rotate(${(1 - icon) * -25}deg)`,
              filter: `drop-shadow(0 30px 60px ${C.brand}88)`,
            }}
          />
          <div style={{ display: "flex", fontFamily: FONT, fontWeight: 800, fontSize: (170 - lift * 50) * k, letterSpacing: "-0.05em", color: C.ink }}>
            {name.split("").map((ch, i) => {
              const at = logoAt + 6 + i * 2;
              const o = interpolate(frame, [at, at + 8], [0, 1], clamp);
              return (
                <span key={i} style={{ opacity: o, transform: `translateX(${(1 - o) * -30}px)`, display: "inline-block" }}>
                  {ch}
                </span>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingTop: vertical ? 220 : 170 }}>
        <Rise delay={cue("intro", "fast") - 4}>
          <div style={{ fontFamily: FONT, fontSize: vertical ? 76 : 64, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.12, color: C.ink2, textAlign: "center" }}>
            A <span style={{ color: C.accentInk }}>fast, native</span>
            {vertical ? <br /> : " "}word processor.
          </div>
        </Rise>
        <div style={{ display: "flex", gap: vertical ? 16 : 22, marginTop: 56 }}>
          {PLATFORMS.map((p) => {
            const at = cue("intro", p.word) - 4;
            const s = useEnter(at, 12);
            return (
              <div key={p.label} style={{ transform: `scale(${s})`, opacity: s }}>
                <Pill style={{ fontSize: 30, padding: "14px 30px", background: C.surface, color: C.ink, border: `1px solid ${C.line2}` }}>
                  <div style={{ width: 10, height: 10, borderRadius: 5, background: C.accentInk }} />
                  {p.label}
                </Pill>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
