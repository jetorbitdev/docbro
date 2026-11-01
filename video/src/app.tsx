import React from "react";
import { interpolate } from "remotion";
import { C, FONT, MONO, SERIF } from "./theme";
import { clamp } from "./ui";

export const WIN_W = 1440;
export const WIN_H = 860;
const ASSISTANT_W = 380;

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ width: 12, height: 12, borderRadius: 6, background: color }} />
);

const MenuItem: React.FC<{ icon: string; label: string; iconColor?: string }> = ({ icon, label, iconColor = C.muted }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 10px", height: 28, fontSize: 14, fontWeight: 500, color: C.ink2 }}>
    <span style={{ color: iconColor, fontSize: 13 }}>{icon}</span>
    {label}
    <span style={{ fontSize: 8, color: C.muted }}>▼</span>
  </div>
);

export interface AppWindowProps {
  file?: string;
  folder?: string;
  status?: "Saved" | "Edited";
  savePulse?: number;
  /** 0 = Assistant closed, 1 = open. */
  assistant?: number;
  assistantContent?: React.ReactNode;
  outline?: string[];
  activeOutline?: number;
  live?: number;
  width?: number;
  height?: number;
  /** A narrow window drops the outline and the menu search, as the app does. */
  compact?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

/** The DocBro window in its dark theme, laid out like the app. */
export const AppWindow: React.FC<AppWindowProps> = ({
  file = "Launch brief.docx",
  folder = "Field Notes",
  status = "Saved",
  savePulse = 0,
  assistant = 0,
  assistantContent,
  outline = ["Launch brief: Field Notes 2.0", "Summary", "Milestones", "Owners"],
  activeOutline = 0,
  live = 0,
  width = WIN_W,
  height = WIN_H,
  compact = false,
  children,
  style,
}) => {
  const room = width - (compact ? 0 : 210) - assistant * ASSISTANT_W - 48;
  return (
  <div
    style={{
      width,
      height,
      borderRadius: 14,
      overflow: "hidden",
      background: C.bg,
      border: `1px solid ${C.line2}`,
      boxShadow: "0 50px 120px #000a, 0 0 0 1px #0006",
      display: "flex",
      flexDirection: "column",
      fontFamily: FONT,
      color: C.ink,
      ...style,
    }}
  >
    {/* top bar */}
    <div style={{ height: 52, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", borderBottom: `1px solid ${C.line}`, background: C.surface2 }}>
      <div style={{ display: "flex", gap: 8, marginRight: 10 }}>
        <Dot color="#ff5f57" />
        <Dot color="#febc2e" />
        <Dot color="#28c840" />
      </div>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: C.accent, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 15, color: "#fff" }}>
        D
      </div>
      <div style={{ fontSize: 14, color: C.muted }}>{folder}</div>
      <div style={{ fontSize: 14, color: C.line2 }}>/</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{file}</div>
      <div style={{ fontSize: 13, color: status === "Saved" ? C.muted : C.amber }}>{status}</div>
      {live > 0 && (
        <div
          style={{
            opacity: live,
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "3px 10px",
            borderRadius: 99,
            background: C.accentSoft,
            color: C.accentInk,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          <div style={{ width: 7, height: 7, borderRadius: 4, background: C.accentInk }} />
          LIVE
        </div>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ display: compact ? "none" : "flex", alignItems: "center", gap: 8, height: 32, padding: "0 12px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 13, color: C.muted }}>
        ⌕ Search menus <span style={{ fontFamily: MONO, fontSize: 11 }}>⌘K</span>
      </div>
      <div
        style={{
          height: 32,
          padding: "0 16px",
          borderRadius: 8,
          background: C.accent,
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          display: "grid",
          placeItems: "center",
          transform: `scale(${1 + savePulse * 0.12})`,
          boxShadow: `0 0 0 ${savePulse * 8}px ${C.accent}44`,
        }}
      >
        Save
      </div>
      <div style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", color: assistant > 0.5 ? C.accentInk : C.muted, background: assistant > 0.5 ? C.accentSoft : "transparent", fontSize: 15 }}>
        ✦
      </div>
    </div>

    {/* menu bar */}
    <div style={{ height: 36, display: "flex", alignItems: "center", gap: 2, padding: "0 10px", borderBottom: `1px solid ${C.line}`, background: C.surface2 }}>
      <MenuItem icon="▤" label="File" />
      <MenuItem icon="✎" label="Edit" />
      <MenuItem icon="◉" label="View" iconColor={C.accentInk} />
      <MenuItem icon="+" label="Insert" iconColor={C.accentInk} />
      <MenuItem icon="Aa" label="Format" iconColor={C.accentInk} />
    </div>

    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* outline */}
      <div style={{ display: compact ? "none" : "flex", width: 210, borderRight: `1px solid ${C.line}`, background: C.surface2, flexDirection: "column", padding: "14px 10px" }}>
        <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.1em", color: C.muted, padding: "0 8px 10px" }}>OUTLINE</div>
        {outline.map((h, i) => (
          <div
            key={h}
            style={{
              fontSize: 13,
              padding: "4px 8px",
              paddingLeft: i === 0 ? 8 : 18,
              borderRadius: 6,
              marginBottom: 2,
              color: i === activeOutline ? C.accentInk : C.ink2,
              fontWeight: i === activeOutline ? 600 : 400,
              background: i === activeOutline ? C.accentSoft : "transparent",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {h}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: C.muted, padding: "0 8px 10px" }}>
          <b style={{ color: C.ink }}>312</b> words &nbsp; <b style={{ color: C.ink }}>2 min</b> read
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line2}` }}>
          <div style={{ width: 20, height: 20, borderRadius: 5, background: C.blueBg, color: C.blue, fontSize: 9, fontWeight: 700, display: "grid", placeItems: "center" }}>W</div>
          <div style={{ fontSize: 12, color: C.ink2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file}</div>
        </div>
      </div>

      {/* paper */}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", justifyContent: "center", paddingTop: 34 }}>
        <div
          style={{
            width: Math.min(860, room),
            borderRadius: 6,
            background: C.surface,
            border: `1px solid ${C.line}`,
            padding: "56px 64px",
            height: 1200,
          }}
        >
          {children}
        </div>
      </div>

      {/* assistant */}
      <div style={{ width: assistant * ASSISTANT_W, overflow: "hidden", borderLeft: assistant > 0 ? `1px solid ${C.line}` : "none", background: C.surface2 }}>
        <div style={{ width: ASSISTANT_W, height: "100%" }}>{assistantContent}</div>
      </div>
    </div>
  </div>
  );
};

/** The sample document, typeset like the app's paper. */
export const Doc: React.FC<{
  scale?: number;
  table?: number;
  guides?: number;
  extra?: React.ReactNode;
  afterSummary?: React.ReactNode;
}> = ({ scale = 1, table = 1, guides = 0, extra, afterSummary }) => (
  <div style={{ fontFamily: SERIF, color: C.ink, fontSize: 17 * scale, lineHeight: 1.72 }}>
    <div style={{ fontFamily: FONT, fontSize: 34 * scale, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.12, marginBottom: 18 * scale }}>
      Launch brief: Field Notes 2.0
    </div>
    <p style={{ margin: `0 0 ${16 * scale}px` }}>
      This brief covers the spring launch of Field Notes 2.0: what ships, who owns each part, and the dates we hold ourselves to.
    </p>
    <div style={{ fontFamily: FONT, fontSize: 22 * scale, fontWeight: 600, letterSpacing: "-0.015em", margin: `${26 * scale}px 0 ${8 * scale}px` }}>Summary</div>
    <p style={{ margin: `0 0 ${16 * scale}px` }}>
      The release centres on offline sync and a faster editor.{" "}
      <span style={{ background: C.hl, boxShadow: `inset 0 -2px 0 ${C.hlLine}` }}>Beta testers opened it daily</span>, and support tickets fell by a
      third.
    </p>
    {afterSummary}
    <div style={{ fontFamily: FONT, fontSize: 22 * scale, fontWeight: 600, letterSpacing: "-0.015em", margin: `${26 * scale}px 0 ${10 * scale}px` }}>
      Milestones
    </div>
    {table > 0 && <MilestoneTable scale={scale} reveal={table} guides={guides} />}
    {extra}
  </div>
);

const ROWS = [
  ["Feature freeze", "Rina", "Mar 3"],
  ["Beta to 2,000 users", "Dimas", "Mar 17"],
  ["Public launch", "Sari", "Apr 8"],
];

const COLUMNS = [0.52, 0.24, 0.24];

export const MilestoneTable: React.FC<{ scale?: number; reveal?: number; guides?: number }> = ({ scale = 1, reveal = 1, guides = 0 }) => {
  const cell: React.CSSProperties = { border: `1px solid ${C.line}`, padding: `${8 * scale}px ${10 * scale}px`, textAlign: "left" };
  const edges = COLUMNS.reduce<number[]>((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
  return (
    <div style={{ position: "relative" }}>
    {/* column guides: the widths came from the file and are written back unchanged */}
    {guides > 0 &&
      edges.map((x) => (
        <div
          key={x}
          style={{
            position: "absolute",
            left: `calc(${x * 100}% - 1px)`,
            top: -18,
            height: `calc(${guides * 100}% + 36px)`,
            borderLeft: `2px dashed ${C.accentInk}`,
            opacity: guides,
          }}
        />
      ))}
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT, fontSize: 13.5 * scale, lineHeight: 1.4 }}>
      <thead>
        <tr>
          {["Milestone", "Owner", "Date"].map((h, i) => (
            <th key={h} style={{ ...cell, width: `${COLUMNS[i] * 100}%`, background: C.head, color: C.muted, fontSize: 12 * scale, fontWeight: 600 }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((r, i) => (
          <tr key={r[0]} style={{ opacity: interpolate(reveal, [i / 3, (i + 1) / 3], [0, 1], clamp) }}>
            {r.map((c) => (
              <td key={c} style={cell}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
};
