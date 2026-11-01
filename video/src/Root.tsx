import React from "react";
import { Composition } from "remotion";
import { Teaser } from "./Teaser";
import { DURATION, FPS, HEIGHT, WIDTH } from "./timeline";

// The same cut twice: landscape, and portrait for Reels, Shorts and TikTok.
// Each scene picks its layout from the frame's shape (useVertical).
export const Root: React.FC = () => (
  <>
    <Composition id="DocBroTeaser" component={Teaser} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
    <Composition id="DocBroReel" component={Teaser} durationInFrames={DURATION} fps={FPS} width={HEIGHT} height={WIDTH} />
  </>
);
