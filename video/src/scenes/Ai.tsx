import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppWindow, Doc, WIN_H, WIN_W } from "../app";
import { C, FONT, MONO, SERIF } from "../theme";
import { cue } from "../timeline";
import { Backdrop, Check, clamp, Rise, useEnter, useRamp, useVertical } from "../ui";

type Pt = { x: number; y: number };
interface Layout {
  text: { left: number; top: number; width: number; align: "left" | "center" };
  win: { x: number; y: number; scale: number; w: number; h: number; compact: boolean };
  port: Pt;
  chips: Pt[];
  /** Each connector, as the four points of a cubic Bézier from chip `i` to the port. */
  wire(i: number): [Pt, Pt, Pt, Pt];
  glow: [number, number];
}

const CHIP = { w: 290, h: 78 };

// clients stacked on the left, wired into the window's left edge
const WIDE: Layout = (() => {
  const win = { x: 1920 - WIN_W * 0.78 - 80, y: (1080 - WIN_H * 0.78) / 2 + 50, scale: 0.78, w: WIN_W, h: WIN_H, compact: false };
  const port = { x: win.x, y: win.y + WIN_H * 0.78 * 0.55 };
  const chips = [0, 1, 2].map((i) => ({ x: 110, y: 560 + i * 110 }));
  return {
    text: { left: 110, top: 150, width: 540, align: "left" },
    win,
    port,
    chips,
    wire: (i) => {
      const a = { x: chips[i].x + CHIP.w, y: chips[i].y + CHIP.h / 2 };
      return [a, { x: a.x + 160, y: a.y }, { x: port.x - 160, y: port.y }, port];
    },
    glow: [62, 58],
  };
})();

// portrait: clients in a row under the window, wired up into its bottom edge
const TALL: Layout = (() => {
  const win = { x: 60, y: 380, scale: 0.96, w: 1000, h: 900, compact: true };
  const port = { x: 540, y: win.y + win.h * win.scale };
  const chips = [0, 1, 2].map((i) => ({ x: 75 + i * (CHIP.w + 30), y: 1380 }));
  return {
    text: { left: 60, top: 170, width: 960, align: "center" },
    win,
    port,
    chips,
    wire: (i) => {
      const a = { x: chips[i].x + CHIP.w / 2, y: chips[i].y };
      return [a, { x: a.x, y: a.y - 90 }, { x: port.x, y: port.y + 90 }, port];
    },
    glow: [50, 45],
  };
})();

const CLIENTS = [
  { name: "Claude", word: "Claude", mark: "✳", color: "#d97757" },
  { name: "Cursor", word: "Cursor", mark: "▲", color: C.ink },
  { name: "Codex", word: "Codex", mark: "◎", color: C.blue },
];

export const INSERTED = "Risk: the sync server needs a load test before beta. Dimas owns it, due Mar 10.";

const Switch: React.FC<{ on: number }> = ({ on }) => (
  <div style={{ width: 36, height: 20, borderRadius: 10, background: on > 0.5 ? C.accent : C.line2, position: "relative" }}>
    <div style={{ position: "absolute", top: 2, left: 2 + on * 16, width: 16, height: 16, borderRadius: 8, background: "#fff" }} />
  </div>
);

const ToolCard: React.FC<{ name: string; args: string; done: boolean; appear: number }> = ({ name, args, done, appear }) => (
  <div
    style={{
      opacity: appear,
      transform: `translateY(${(1 - appear) * 16}px)`,
      border: `1px solid ${C.line2}`,
      borderRadius: 10,
      background: C.surface,
      padding: "10px 12px",
      marginBottom: 10,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: C.amber, background: C.amberBg, padding: "2px 7px", borderRadius: 5 }}>EXTERNAL</span>
      <span style={{ fontFamily: MONO, color: C.ink, fontWeight: 500 }}>{name}</span>
      <div style={{ flex: 1 }} />
      {done ? <Check size={16} /> : <span style={{ color: C.muted, fontSize: 12 }}>running…</span>}
    </div>
    <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{args}</div>
  </div>
);

const Assistant: React.FC = () => {
  const frame = useCurrentFrame();
  const serverOn = useRamp(cue("ai", "MCP"), cue("ai", "MCP") + 8);
  const readAt = cue("ai", "read");
  const editAt = cue("ai", "edit");
  const readCard = useEnter(readAt - 4, 16);
  const editCard = useEnter(editAt - 2, 16);
  return (
    <div style={{ padding: "16px 16px", fontFamily: FONT, color: C.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Assistant</div>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.accentInk, background: C.accentSoft, padding: "3px 8px", borderRadius: 6 }}>MCP</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: C.muted }}>New</div>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", color: C.muted, marginBottom: 8 }}>SERVE DOCBRO</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${serverOn > 0.5 ? C.accent : C.line2}`, marginBottom: 18, background: serverOn > 0.5 ? C.accentSoft : "transparent" }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, background: serverOn > 0.5 ? C.accentInk : C.muted }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>MCP server</div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>127.0.0.1:7425</div>
        </div>
        <Switch on={serverOn} />
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", color: C.muted, marginBottom: 10 }}>ACTIVITY</div>
      {frame >= readAt - 6 && <ToolCard name="read_document" args='{ "from": 0 }' done={frame > readAt + 10} appear={readCard} />}
      {frame >= editAt - 4 && (
        <ToolCard name="insert_content" args={`{ "after": "Summary", "markdown": "${INSERTED}" }`} done={frame > cue("ai", "watch") - 6} appear={editCard} />
      )}
    </div>
  );
};

export const Ai: React.FC = () => {
  const frame = useCurrentFrame();
  const win = useEnter(0, 18);
  const assistant = useRamp(cue("ai", "AI") - 4, cue("ai", "AI") + 16);
  const port = useEnter(cue("ai", "MCP") - 2, 12);
  const typeFrom = cue("ai", "edit") + 4;
  const typeTo = cue("ai", "watch");
  const typed = Math.round(interpolate(frame, [typeFrom, typeTo], [0, INSERTED.length], clamp));
  const flowing = frame >= cue("ai", "read") - 4;
  const live = useRamp(cue("ai", "live") - 6, cue("ai", "live") + 4);
  const vertical = useVertical();
  const L = vertical ? TALL : WIDE;

  return (
    <AbsoluteFill>
      <Backdrop glowX={L.glow[0]} glowY={L.glow[1]} />

      <div style={{ position: "absolute", left: L.text.left, top: L.text.top, width: L.text.width, textAlign: L.text.align }}>
        <Rise delay={cue("ai", "AI") - 4}>
          <div style={{ fontFamily: FONT, fontSize: 66, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, color: C.ink }}>
            Your AI is already <span style={{ color: C.accentInk }}>in the room.</span>
          </div>
        </Rise>
        <Rise delay={cue("ai", "MCP") - 2}>
          <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 500, color: C.ink3, marginTop: 22 }}>
            Built-in <span style={{ color: C.ink }}>MCP server</span>. Live edits, one undo each.
          </div>
        </Rise>
      </div>

      {/* connectors from each client to DocBro's MCP port */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        {CLIENTS.map((c, i) => {
          const at = cue("ai", c.word) - 4;
          const draw = interpolate(frame, [at + 4, at + 18], [0, 1], clamp);
          const [a, b, e, f] = L.wire(i);
          const d = `M ${a.x} ${a.y} C ${b.x} ${b.y}, ${e.x} ${e.y}, ${f.x} ${f.y}`;
          return <path key={c.name} d={d} fill="none" stroke={C.accent} strokeWidth={3} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - draw} opacity={0.8} />;
        })}
        {flowing &&
          CLIENTS.map((c, i) => {
            const [a, b, e, f] = L.wire(i);
            return [0, 0.33, 0.66].map((o) => {
              const t = ((frame - cue("ai", "read")) / 40 + o + i * 0.17) % 1;
              const u = 1 - t;
              // point on the same cubic Bézier as the connector
              const px = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * e.x + t ** 3 * f.x;
              const py = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * e.y + t ** 3 * f.y;
              return <circle key={`${c.name}${o}`} cx={px} cy={py} r={5} fill={C.accentInk} opacity={Math.sin(Math.PI * t)} />;
            });
          })}
      </svg>

      {CLIENTS.map((c, i) => {
        const p = useEnter(cue("ai", c.word) - 4, 13);
        return (
          <div
            key={c.name}
            style={{
              position: "absolute",
              left: L.chips[i].x,
              top: L.chips[i].y,
              width: CHIP.w,
              height: CHIP.h,
              borderRadius: 16,
              background: C.surface,
              border: `1px solid ${C.line2}`,
              boxShadow: "0 20px 50px #0009",
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "0 22px",
              fontFamily: FONT,
              fontSize: 28,
              fontWeight: 600,
              color: C.ink,
              opacity: p,
              transform: vertical ? `translateY(${(1 - p) * 60}px)` : `translateX(${(1 - p) * -60}px)`,
            }}
          >
            <span style={{ color: c.color, fontSize: 26 }}>{c.mark}</span>
            {c.name}
          </div>
        );
      })}

      <div
        style={{
          position: "absolute",
          left: L.win.x,
          top: L.win.y,
          transform: `translateY(${(1 - win) * 60}px) scale(${L.win.scale})`,
          transformOrigin: "top left",
          opacity: win,
        }}
      >
        <AppWindow assistant={assistant} assistantContent={<Assistant />} status={typed > 0 ? "Edited" : "Saved"} live={live} activeOutline={1} width={L.win.w} height={L.win.h} compact={L.win.compact}>
          <Doc
            afterSummary={
              typed > 0 ? (
                <p style={{ margin: "0 0 16px", fontFamily: SERIF, background: C.accentSoft, boxShadow: `inset 3px 0 0 ${C.accentInk}`, padding: "4px 10px", borderRadius: 4 }}>
                  {INSERTED.slice(0, typed)}
                  {typed < INSERTED.length && <span style={{ display: "inline-block", width: 2, height: "1.1em", background: C.accentInk, verticalAlign: "-0.15em" }} />}
                </p>
              ) : null
            }
          />
        </AppWindow>
      </div>

      {/* DocBro's MCP port on the window's edge */}
      <div
        style={{
          position: "absolute",
          left: L.port.x - 46,
          top: L.port.y - 46,
          width: 92,
          height: 92,
          borderRadius: 46,
          background: C.accent,
          border: `4px solid ${C.night}`,
          boxShadow: `0 0 0 ${8 + Math.sin(frame / 6) * 4}px ${C.accent}33`,
          display: "grid",
          placeItems: "center",
          fontFamily: FONT,
          fontWeight: 800,
          fontSize: 22,
          color: "#fff",
          transform: `scale(${port})`,
        }}
      >
        MCP
      </div>
    </AbsoluteFill>
  );
};
