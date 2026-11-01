import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppWindow, Doc, WIN_H, WIN_W } from "../app";
import { C, FONT } from "../theme";
import { cue } from "../timeline";
import { Backdrop, Check, clamp, Rise, useEnter, useRamp, useVertical } from "../ui";

const WIDE = {
  text: { left: 110, top: 200, width: 560, align: "left" as const },
  cards: { left: 110, top: 560, gap: 132 },
  win: { x: 1920 - WIN_W * 0.72 - 100, y: (1080 - WIN_H * 0.72) / 2, scale: 0.72, w: WIN_W, h: WIN_H },
};
// portrait: headline on top, a narrower window shown larger, the files under it;
// the bottom ~400px stay clear for the Reels caption and buttons
const TALL = {
  text: { left: 60, top: 200, width: 960, align: "center" as const },
  cards: { left: 330, top: 1250, gap: 124 },
  win: { x: 60, y: 470, scale: 1.23, w: 780, h: 600 },
};

const FileCard: React.FC<{ name: string; badge: string; color: string; bg: string; saved: boolean }> = ({ name, badge, color, bg, saved }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 18,
      width: 420,
      padding: "18px 22px",
      borderRadius: 18,
      background: C.surface,
      border: `1px solid ${saved ? C.accent : C.line2}`,
      boxShadow: "0 30px 60px #000a",
      fontFamily: FONT,
    }}
  >
    <div style={{ width: 56, height: 68, borderRadius: 10, background: bg, color, display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16, letterSpacing: "0.04em" }}>
      {badge}
    </div>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 24, fontWeight: 600, color: C.ink }}>{name}</div>
      <div style={{ fontSize: 18, color: saved ? C.accentInk : C.muted, display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        {saved ? (
          <>
            <Check size={16} /> Saved, layout intact
          </>
        ) : (
          "Opened in DocBro"
        )}
      </div>
    </div>
  </div>
);

const CARDS = [
  { name: "Launch brief.docx", badge: "DOCX", color: C.blue, bg: C.blueBg, word: "Word" },
  { name: "release-notes.md", badge: "MD", color: C.amber, bg: C.amberBg, word: "Markdown" },
];

export const Files: React.FC = () => {
  const frame = useCurrentFrame();
  const win = useEnter(0, 18);
  const opened = useRamp(cue("files", "Word") + 4, cue("files", "files") + 12);
  const saveAt = cue("files", "save");
  const savePulse = interpolate(frame - saveAt, [0, 4, 14], [0, 1, 0], clamp);
  const saved = frame >= saveAt + 4;
  const guides = useRamp(cue("files", "exactly") - 4, cue("files", "exactly") + 12);
  const L = useVertical() ? TALL : WIDE;

  return (
    <AbsoluteFill>
      <Backdrop glowX={L === TALL ? 50 : 68} glowY={50} />
      <div style={{ position: "absolute", left: L.text.left, top: L.text.top, width: L.text.width, textAlign: L.text.align }}>
        <Rise delay={cue("files", "Open") - 4}>
          <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 600, color: C.accentInk, letterSpacing: "0.04em", marginBottom: 18 }}>WORD  ·  MARKDOWN</div>
        </Rise>
        <Rise delay={cue("files", "Word") - 2}>
          <div style={{ fontFamily: FONT, fontSize: 68, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, color: C.ink }}>Opens as laid out.</div>
        </Rise>
        <Rise delay={saveAt - 2}>
          <div style={{ fontFamily: FONT, fontSize: 68, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, color: C.accentInk }}>Saves as laid out.</div>
        </Rise>
      </div>

      {CARDS.map((card, i) => {
        const p = useEnter(cue("files", card.word) - 6, 15);
        const flash = saved ? interpolate(frame - saveAt - 4 - i * 4, [0, 6, 16], [0, 1, 0], clamp) : 0;
        return (
          <div
            key={card.name}
            style={{
              position: "absolute",
              left: L.cards.left,
              top: L.cards.top + i * L.cards.gap,
              opacity: p,
              transform: `translateX(${(1 - p) * -120}px) scale(${1 + flash * 0.04})`,
            }}
          >
            <FileCard {...card} saved={frame >= saveAt + 4 + i * 4} />
          </div>
        );
      })}

      <div
        style={{
          position: "absolute",
          left: L.win.x,
          top: L.win.y,
          transform: `translateY(${(1 - win) * 80}px) scale(${L.win.scale})`,
          transformOrigin: "top left",
          opacity: win,
        }}
      >
        <AppWindow status={saved ? "Saved" : "Edited"} savePulse={savePulse} width={L.win.w} height={L.win.h} compact={L === TALL}>
          <div style={{ opacity: opened, transform: `translateY(${(1 - opened) * 20}px)` }}>
            <Doc table={interpolate(opened, [0.3, 1], [0, 1], clamp)} guides={guides} />
          </div>
        </AppWindow>
      </div>
    </AbsoluteFill>
  );
};
