import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { cue } from "../timeline";
import { AppIcon, clamp, Rise, useEnter, useVertical } from "../ui";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const icon = useEnter(cue("outro", "DocBro") - 8, 11, 0.9);
  const sweep = interpolate(frame, [0, 40], [0, 1], clamp);
  const lineAt = cue("outro", "not") + 26;
  const vertical = useVertical();

  return (
    <AbsoluteFill style={{ background: C.brand, overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(1200px 800px at 50% ${30 + sweep * 10}%, #2f8f68, ${C.brand} 55%, #14472f)` }} />
      {/* a soft ring opening out from the icon */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: 600 + frame * 9,
            height: 600 + frame * 9,
            borderRadius: "50%",
            border: "2px solid #ffffff22",
            opacity: interpolate(frame, [0, 90], [0.9, 0], clamp),
            transform: "translateY(-90px)",
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", fontFamily: FONT, color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 36, transform: `scale(${0.9 + icon * 0.1})`, opacity: icon }}>
          <AppIcon size={170} style={{ filter: "drop-shadow(0 24px 50px #0006)", outline: "2px solid #ffffff30", outlineOffset: -2, borderRadius: 40 }} />
          <div style={{ fontSize: 150, fontWeight: 800, letterSpacing: "-0.05em" }}>DocBro</div>
        </div>
        <Rise delay={cue("outro", "Write") - 4} style={{ marginTop: 48 }}>
          <div style={{ fontSize: vertical ? 72 : 60, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.15, color: "#e7f1ec", textAlign: "center" }}>
            Write <span style={{ color: "#fff", fontWeight: 700 }}>with</span> your AI,{vertical ? <br /> : " "}
            <Rise delay={cue("outro", "not") - 4} style={{ display: "inline-block" }}>
              <span style={{ color: C.brandLight, fontStyle: "italic" }}>not around it.</span>
            </Rise>
          </div>
        </Rise>
        <Rise delay={lineAt} style={{ marginTop: 70 }}>
          <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: 18, fontSize: vertical ? 30 : 24, fontWeight: 500, color: "#d6e8de" }}>
            {["Word & Markdown", "Built-in MCP", "macOS · Windows · Linux"].map((t) => (
              <div key={t} style={{ padding: "10px 22px", borderRadius: 999, border: "1.5px solid #ffffff40", background: "#ffffff10" }}>
                {t}
              </div>
            ))}
          </div>
        </Rise>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
