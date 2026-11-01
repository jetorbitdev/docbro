import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, MONO } from "./theme";

/** Spring from 0 to 1 that starts at `delay` frames. */
export function useEnter(delay: number, damping = 16, mass = 0.8): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping, mass, stiffness: 120 } });
}

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Eased 0→1 between two frames. */
export function useRamp(from: number, to: number): number {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [from, to], [0, 1], clamp);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export const Backdrop: React.FC<{ glow?: string; glowX?: number; glowY?: number }> = ({
  glow = C.brand,
  glowX = 50,
  glowY = 42,
}) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 70) * 3;
  return (
    <AbsoluteFill style={{ background: C.night }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1100px 760px at ${glowX + drift}% ${glowY}%, ${glow}55, transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.line}55 1px, transparent 1px), linear-gradient(90deg, ${C.line}55 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
          backgroundPosition: `${frame * 0.15}px ${frame * 0.1}px`,
          maskImage: "radial-gradient(900px 600px at 50% 50%, black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(900px 600px at 50% 50%, black, transparent 75%)",
        }}
      />
    </AbsoluteFill>
  );
};

/** The app icon (app-icon.svg). */
export const AppIcon: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <svg width={size} height={size} viewBox="100 100 824 824" style={style}>
    <rect x="100" y="100" width="824" height="824" rx="184" fill={C.brand} />
    <path
      d="M316 212 H594 L732 350 V764 A48 48 0 0 1 684 812 H316 A48 48 0 0 1 268 764 V260 A48 48 0 0 1 316 212 Z"
      fill="#ffffff"
    />
    <path d="M594 212 V302 A48 48 0 0 0 642 350 H732 Z" fill={C.brandLight} />
    <g fill={C.brand}>
      <rect x="340" y="430" width="240" height="30" rx="15" opacity="0.9" />
      <rect x="340" y="508" width="352" height="22" rx="11" opacity="0.45" />
      <rect x="340" y="574" width="352" height="22" rx="11" opacity="0.45" />
      <rect x="340" y="640" width="352" height="22" rx="11" opacity="0.45" />
      <rect x="340" y="706" width="220" height="22" rx="11" opacity="0.45" />
    </g>
  </svg>
);

/** A block that rises into place at `delay`. */
export const Rise: React.FC<{ delay: number; y?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({
  delay,
  y = 28,
  style,
  children,
}) => {
  const p = useEnter(delay);
  return (
    <div
      style={{
        opacity: interpolate(p, [0, 0.6], [0, 1], clamp),
        transform: `translateY(${(1 - p) * y}px)`,
        filter: `blur(${(1 - p) * 8}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** A headline whose words rise one by one, each at its own frame. */
export const Words: React.FC<{
  words: { text: string; at: number; color?: string }[];
  size: number;
  weight?: number;
  style?: React.CSSProperties;
}> = ({ words, size, weight = 700, style }) => (
  <div
    style={{
      fontFamily: FONT,
      fontSize: size,
      fontWeight: weight,
      letterSpacing: "-0.035em",
      lineHeight: 1.08,
      color: C.ink,
      display: "flex",
      flexWrap: "wrap",
      columnGap: size * 0.26,
      ...style,
    }}
  >
    {words.map((w, i) => (
      <Rise key={i} delay={w.at} y={size * 0.45} style={{ color: w.color }}>
        {w.text}
      </Rise>
    ))}
  </div>
);

export const Keycap: React.FC<{ label: string; size?: number; pressAt?: number; style?: React.CSSProperties }> = ({
  label,
  size = 120,
  pressAt,
  style,
}) => {
  const frame = useCurrentFrame();
  const press = pressAt === undefined ? 0 : interpolate(frame - pressAt, [0, 3, 10], [0, 1, 0], clamp);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.2,
        background: `linear-gradient(180deg, ${C.head}, ${C.surface})`,
        border: `1.5px solid ${C.line2}`,
        boxShadow: `0 ${10 - press * 8}px 0 ${C.night}, 0 ${18 - press * 10}px 40px #0008, inset 0 1px 0 #ffffff14`,
        transform: `translateY(${press * 8}px)`,
        display: "grid",
        placeItems: "center",
        fontFamily: FONT,
        fontWeight: 600,
        fontSize: size * 0.42,
        color: press > 0.2 ? C.accentInk : C.ink,
        ...style,
      }}
    >
      {label}
    </div>
  );
};

export const Pill: React.FC<{ children: React.ReactNode; color?: string; bg?: string; style?: React.CSSProperties }> = ({
  children,
  color = C.accentInk,
  bg = C.accentSoft,
  style,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 20px",
      borderRadius: 999,
      background: bg,
      color,
      fontFamily: FONT,
      fontWeight: 600,
      fontSize: 26,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Mono: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ fontFamily: MONO, ...style }}>{children}</span>
);

export const Check: React.FC<{ size?: number; color?: string }> = ({ size = 18, color = C.accentInk }) => (
  <svg width={size} height={size} viewBox="0 0 20 20">
    <path d="M4 10.5 L8.2 14.5 L16 5.5" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** True when rendering the portrait (Reels) cut. */
export function useVertical(): boolean {
  const { width, height } = useVideoConfig();
  return height > width;
}
