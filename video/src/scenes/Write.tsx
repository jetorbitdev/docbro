import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { MilestoneTable } from "../app";
import { C, FONT, SERIF } from "../theme";
import { cue } from "../timeline";
import { Backdrop, clamp, Keycap, Rise, useEnter, useRamp, useVertical } from "../ui";

const MENU = [
  { icon: "H", label: "Heading", hint: "Big section title" },
  { icon: "▦", label: "Table", hint: "Rows and columns" },
  { icon: "▣", label: "Image", hint: "From a file" },
  { icon: "❝", label: "Quote", hint: "Pull a line out" },
  { icon: "—", label: "Divider", hint: "Break the page" },
];

const Caret: React.FC = () => {
  const frame = useCurrentFrame();
  return <span style={{ display: "inline-block", width: 3, height: "1.1em", background: C.accentInk, verticalAlign: "-0.15em", opacity: Math.floor(frame / 15) % 2 ? 0.2 : 1 }} />;
};

/** Grows a block's height from nothing, so what follows it slides down. */
const Grow: React.FC<{ p: number; h: number; children: React.ReactNode }> = ({ p, h, children }) => (
  <div style={{ height: p * h, opacity: interpolate(p, [0.4, 1], [0, 1], clamp), overflow: "hidden" }}>{children}</div>
);

export const Write: React.FC = () => {
  const frame = useCurrentFrame();
  const slashAt = cue("write", "slash");
  const menu = useEnter(slashAt + 2, 14);
  const headingAt = cue("write", "Headings");
  const tableAt = cue("write", "tables");
  const imageAt = cue("write", "images");
  const closeAt = cue("write", "Nothing") - 4;
  const selected = frame < tableAt - 4 ? 0 : frame < imageAt - 4 ? 1 : 2;
  const heading = useEnter(headingAt + 4, 15);
  const table = useEnter(tableAt + 4, 15);
  const image = useEnter(imageAt + 4, 15);
  const menuOut = useRamp(closeAt, closeAt + 10);
  const menuOpacity = menu * (1 - menuOut);
  const paper = useEnter(0, 18);
  const vertical = useVertical();
  // portrait: keycap and headline side by side on top, the page under them
  const L = vertical
    ? { text: { left: 60, top: 180, width: 960 }, paper: { left: 50, top: 450, width: 980 } }
    : { text: { left: 120, top: 250, width: 560 }, paper: { left: 760, top: 110, width: 1040 } };

  return (
    <AbsoluteFill>
      <Backdrop glowX={vertical ? 50 : 30} glowY={vertical ? 30 : 45} />
      <div style={{ position: "absolute", left: L.text.left, top: L.text.top, width: L.text.width, display: vertical ? "flex" : "block", gap: 44, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 20, marginBottom: vertical ? 0 : 46 }}>
          <Keycap label="/" size={130} pressAt={slashAt} />
        </div>
        <div>
        <Rise delay={cue("write", "Type") - 2}>
          <div style={{ fontFamily: FONT, fontSize: 68, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, color: C.ink }}>
            Type <span style={{ color: C.accentInk }}>/</span> to insert
            <br />
            anything.
          </div>
        </Rise>
        <Rise delay={closeAt}>
          <div style={{ fontFamily: FONT, fontSize: 34, fontWeight: 500, color: C.ink3, marginTop: 26 }}>Nothing gets in your way.</div>
        </Rise>
        </div>
      </div>

      {/* the page, close up */}
      <div
        style={{
          position: "absolute",
          left: L.paper.left,
          top: L.paper.top,
          width: L.paper.width,
          height: 1700,
          borderRadius: 14,
          background: C.surface,
          border: `1px solid ${C.line2}`,
          boxShadow: "0 50px 120px #000a",
          padding: "70px 80px",
          opacity: paper,
          transform: `translateY(${(1 - paper) * 60}px)`,
          fontFamily: SERIF,
          fontSize: 25,
          lineHeight: 1.7,
          color: C.ink,
          overflow: "hidden",
        }}
      >
        {/* the page scrolls as blocks land, so the caret and its menu stay in view */}
        <div style={{ transform: `translateY(${-(vertical ? image * 120 : table * 90 + image * 160)}px)` }}>
        <p style={{ margin: "0 0 26px", color: C.ink2 }}>
          The release centres on offline sync and a faster editor. Beta testers opened it daily, and support tickets fell by a third.
        </p>
        <Grow p={heading} h={78}>
          <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.3, paddingBottom: 26 }}>Milestones</div>
        </Grow>
        <Grow p={table} h={230}>
          <div style={{ paddingBottom: 30 }}>
            <MilestoneTable scale={1.45} />
          </div>
        </Grow>
        <Grow p={image} h={200}>
          <div
            style={{
              height: 180,
              borderRadius: 12,
              background: `linear-gradient(135deg, ${C.brand}, #2f8f68 45%, ${C.amber} 120%)`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ position: "absolute", left: 60, bottom: -40, width: 260, height: 160, borderRadius: "50%", background: "#ffffff22" }} />
            <div style={{ position: "absolute", right: 90, top: 40, width: 60, height: 60, borderRadius: 30, background: "#ffffff55" }} />
          </div>
        </Grow>
        <div style={{ position: "relative", color: C.ink }}>
          {frame >= slashAt ? <span style={{ color: C.accentInk }}>/</span> : null}
          <Caret />
          {/* slash menu */}
          <div
            style={{
              position: "absolute",
              left: 10,
              top: 52,
              width: 420,
              padding: 10,
              borderRadius: 14,
              background: C.head,
              border: `1px solid ${C.line2}`,
              boxShadow: "0 30px 80px #000c",
              fontFamily: FONT,
              opacity: menuOpacity,
              transform: `translateY(${(1 - menu) * -14}px) scale(${0.96 + menu * 0.04})`,
              transformOrigin: "top left",
            }}
          >
            {MENU.map((m, i) => (
              <div
                key={m.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "11px 14px",
                  borderRadius: 9,
                  background: i === selected ? C.accentSoft : "transparent",
                }}
              >
                <div style={{ width: 40, height: 40, borderRadius: 9, border: `1px solid ${C.line2}`, display: "grid", placeItems: "center", color: i === selected ? C.accentInk : C.ink2, fontSize: 20, fontWeight: 700 }}>
                  {m.icon}
                </div>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: i === selected ? C.accentInk : C.ink, lineHeight: 1.2 }}>{m.label}</div>
                  <div style={{ fontSize: 16, color: C.muted, lineHeight: 1.3 }}>{m.hint}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
