/** What the person asked to see. Whether there is room for it is `viewportLayout`'s call. */
export interface UiState {
  focus: boolean;
  hideOutline: boolean;
  forceOutline: boolean;
  hideComments: boolean;
  assistantOpen: boolean;
  menuBar: boolean;
  largerText: boolean;
  sansFont: boolean;
}

export interface LayoutFlags {
  assistantOpen: boolean;
  assistantWidth: "320px" | "380px";
  showOutline: boolean;
  outlineRail: boolean;
  showComments: boolean;
  showMenuBar: boolean;
}

/** Which panels fit in a window `width` px wide (mock 656–663, 723). */
export function viewportLayout(width: number, ui: UiState): LayoutFlags {
  const assistantOpen = ui.assistantOpen && width >= 760;
  const showOutline =
    !ui.focus && !ui.hideOutline && (ui.forceOutline ? width >= 760 : width >= (assistantOpen ? 1240 : 900));
  return {
    assistantOpen,
    assistantWidth: width < 1100 ? "320px" : "380px",
    showOutline,
    outlineRail: !showOutline && !ui.focus && width >= 760,
    showComments: !ui.focus && !ui.hideComments && width >= (assistantOpen ? 1560 : 1200),
    showMenuBar: !ui.focus && ui.menuBar,
  };
}

/** Hides an outline that is showing; shows a hidden one even where the width rule would hide it. */
export function toggleOutline(shown: boolean): Partial<UiState> {
  return shown ? { hideOutline: true, forceOutline: false } : { hideOutline: false, forceOutline: true };
}
