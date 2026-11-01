import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, FONT, MONO, SERIF } from "../theme";
import { cue } from "../timeline";
import { Backdrop, Check, clamp, Keycap, Rise, useEnter, useRamp, useVertical } from "../ui";
import { INSERTED } from "./Ai";

const HISTORY = [
  { who: "Claude", what: "insert_content", note: "added the risk paragraph" },
  { who: "Claude", what: "replace_blocks", note: "tightened the summary" },
  { who: "You", what: "typing", note: "edited Milestones" },
];

export const Undo: React.FC = () => {
  const frame = useCurrentFrame();
  const undoAt = cue("undo", "undo");
  const paper = useEnter(0, 18);
  const gone = useRamp(undoAt + 2, undoAt + 16);
  const toast = useEnter(undoAt + 6, 14);
  const toastOut = useRamp(cue("undo", "control") + 10, cue("undo", "control") + 22);
  const vertical = useVertical();
  // portrait: headline and keys on top, the page and its history under them, the payoff line last
  const L = vertical
    ? { text: { left: 60, top: 200, width: 960 }, page: { left: 70, top: 620, width: 940 }, control: { left: 60, top: 1230, width: 960 } }
    : { text: { left: 120, top: 270, width: 680 }, page: { left: 900, top: 250, width: 900 }, control: null };
  const control = (
    <Rise delay={cue("undo", "You") - 4} style={{ marginTop: 60 }}>
      <div style={{ fontFamily: FONT, fontSize: vertical ? 64 : 44, fontWeight: 600, letterSpacing: "-0.03em", color: vertical ? C.ink : C.ink2 }}>You stay in control.</div>
    </Rise>
  );

  return (
    <AbsoluteFill>
      <Backdrop glowX={vertical ? 50 : 35} glowY={vertical ? 30 : 50} />
      <div style={{ position: "absolute", left: L.text.left, top: L.text.top, width: L.text.width, textAlign: vertical ? "center" : "left" }}>
        <Rise delay={cue("undo", "Every") - 4}>
          <div style={{ fontFamily: FONT, fontSize: 70, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, color: C.ink }}>
            Every AI edit is
            <br />
            <span style={{ color: C.accentInk }}>one undo step.</span>
          </div>
        </Rise>
        <div style={{ display: "flex", gap: 22, marginTop: vertical ? 50 : 60, justifyContent: vertical ? "center" : "flex-start" }}>
          <Rise delay={cue("undo", "one") - 8}>
            <Keycap label="⌘" size={120} pressAt={undoAt - 2} />
          </Rise>
          <Rise delay={cue("undo", "one") - 4}>
            <Keycap label="Z" size={120} pressAt={undoAt} />
          </Rise>
        </div>
        {!L.control && control}
      </div>
      {L.control && <div style={{ position: "absolute", ...L.control, textAlign: "center" }}>{control}</div>}

      <div
        style={{
          position: "absolute",
          left: L.page.left,
          top: L.page.top,
          width: L.page.width,
          opacity: paper,
          transform: `translateY(${(1 - paper) * 60}px)`,
        }}
      >
        <div
          style={{
            borderRadius: 14,
            background: C.surface,
            border: `1px solid ${C.line2}`,
            boxShadow: "0 50px 120px #000a",
            padding: "50px 60px 40px",
            fontFamily: SERIF,
            fontSize: 22,
            lineHeight: 1.7,
            color: C.ink,
            position: "relative",
          }}
        >
          <div style={{ fontFamily: FONT, fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>Summary</div>
          <p style={{ margin: "0 0 18px", color: C.ink2 }}>
            The release centres on offline sync and a faster editor. Beta testers opened it daily, and support tickets fell by a third.
          </p>
          <div style={{ height: interpolate(gone, [0, 1], [118, 0]), overflow: "hidden", opacity: 1 - gone }}>
            <p style={{ margin: 0, background: C.accentSoft, boxShadow: `inset 3px 0 0 ${C.accentInk}`, padding: "6px 14px", borderRadius: 5 }}>{INSERTED}</p>
          </div>

          {/* undo toast */}
          <div
            style={{
              position: "absolute",
              right: 30,
              top: -26,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 18px",
              borderRadius: 12,
              background: C.ink,
              color: C.bg,
              fontFamily: FONT,
              fontSize: 19,
              fontWeight: 600,
              boxShadow: "0 20px 40px #000a",
              opacity: toast * (1 - toastOut),
              transform: `translateY(${(1 - toast) * -16}px)`,
            }}
          >
            <Check size={18} color={C.brand} /> Undid <span style={{ fontFamily: MONO, fontWeight: 500 }}>insert_content</span>
          </div>
        </div>

        {/* history: one row per step, newest first */}
        <div style={{ marginTop: 34, fontFamily: FONT }}>
          <div style={{ fontFamily: MONO, fontSize: 15, letterSpacing: "0.1em", color: C.muted, marginBottom: 14 }}>UNDO HISTORY</div>
          {HISTORY.map((h, i) => {
            const struck = i === 0 ? gone : 0;
            const row = useEnter(cue("undo", "AI") + i * 4, 15);
            return (
              <div
                key={h.what}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "14px 20px",
                  marginBottom: 10,
                  borderRadius: 12,
                  border: `1px solid ${i === 0 && frame < undoAt ? C.accent : C.line2}`,
                  background: C.surface2,
                  opacity: row * (1 - struck * 0.6),
                  transform: `translateX(${(1 - row) * 40 + struck * 30}px)`,
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 700, padding: "3px 10px", borderRadius: 6, color: h.who === "You" ? C.blue : C.accentInk, background: h.who === "You" ? C.blueBg : C.accentSoft }}>{h.who}</div>
                <div style={{ fontFamily: MONO, fontSize: 20, color: C.ink, textDecoration: struck > 0.5 ? "line-through" : "none" }}>{h.what}</div>
                <div style={{ fontSize: 19, color: C.muted }}>{h.note}</div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 16, color: C.muted }}>1 step</div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
