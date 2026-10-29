import { afterEach, expect, test, vi } from "vitest";
import { applyTheme, initialTheme, toggleTheme } from "./theme";

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

test("a_stored_choice_wins_over_the_system_setting", () => {
  expect(initialTheme("light", true)).toBe("light");
  expect(initialTheme("dark", false)).toBe("dark");
  expect(initialTheme(null, true)).toBe("dark");
  expect(initialTheme(null, false)).toBe("light");
  expect(initialTheme("garbage", false)).toBe("light");
});

test("applying_a_theme_sets_the_attribute_and_remembers_it", () => {
  applyTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("docbro-theme")).toBe("dark");
});

test("toggling_flips_the_theme", () => {
  applyTheme("light");
  expect(toggleTheme()).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(toggleTheme()).toBe("light");
  expect(localStorage.getItem("docbro-theme")).toBe("light");
});

test("toggling_survives_storage_that_throws", () => {
  document.documentElement.dataset.theme = "light";
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  expect(toggleTheme()).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});
