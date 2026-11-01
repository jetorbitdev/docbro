import { expect, test } from "vitest";
import { toggleOutline, viewportLayout, type UiState } from "./viewport";

const BASE_UI: UiState = {
  focus: false,
  hideOutline: false,
  forceOutline: false,
  hideComments: false,
  assistantOpen: false,
  menuBar: true,
  largerText: false,
  sansFont: false,
};

test.each([
  [1600, { assistantOpen: true }, { showOutline: true, showComments: true, assistantWidth: "380px" }],
  [1400, { assistantOpen: true }, { showOutline: true, showComments: false, assistantWidth: "380px" }],
  [1300, { assistantOpen: false }, { showOutline: true, showComments: true, assistantWidth: "380px" }],
  [1100, { assistantOpen: true }, { showOutline: false, showComments: false, assistantWidth: "380px" }],
  [1000, { assistantOpen: true }, { showOutline: false, outlineRail: true, assistantWidth: "320px" }],
  [800, { assistantOpen: false }, { showOutline: false, outlineRail: true, showComments: false }],
  [700, { assistantOpen: true }, { assistantOpen: false }],
  [1600, { focus: true }, { showOutline: false, showComments: false, showMenuBar: false, outlineRail: false }],
  [1600, { focus: true, assistantOpen: true }, { assistantOpen: false }],
])("viewportLayout at %ipx", (w, ui, want) => {
  expect(viewportLayout(w, { ...BASE_UI, ...ui })).toMatchObject(want);
});

test("hidden_panels_and_the_menu_bar_setting_are_respected", () => {
  expect(viewportLayout(1600, { ...BASE_UI, hideOutline: true, hideComments: true })).toMatchObject({
    showOutline: false,
    outlineRail: true,
    showComments: false,
  });
  expect(viewportLayout(1600, { ...BASE_UI, menuBar: false }).showMenuBar).toBe(false);
  // a narrow window has no room for the rail either
  expect(viewportLayout(700, BASE_UI)).toMatchObject({ showOutline: false, outlineRail: false });
});

test("forcing_the_outline_shows_it_down_to_760px", () => {
  expect(viewportLayout(800, { ...BASE_UI, forceOutline: true }).showOutline).toBe(true);
  expect(viewportLayout(1000, { ...BASE_UI, forceOutline: true, assistantOpen: true }).showOutline).toBe(true);
  expect(viewportLayout(700, { ...BASE_UI, forceOutline: true }).showOutline).toBe(false);
});

test("toggling_the_outline_hides_a_shown_one_and_forces_a_hidden_one", () => {
  expect(toggleOutline(true)).toEqual({ hideOutline: true, forceOutline: false });
  expect(toggleOutline(false)).toEqual({ hideOutline: false, forceOutline: true });
});
