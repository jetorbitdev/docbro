export type Theme = "light" | "dark";

const KEY = "docbro-theme";

/** The theme a window starts with: the one the person chose last, else the system's. */
export function initialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/** Shows `t` and remembers it as the person's choice. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // storage can be full or blocked; the theme still applies to this window
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function toggleTheme(): Theme {
  const t: Theme = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(t);
  return t;
}

/** Shows the starting theme without storing it, so a window keeps following the system until the person picks one. */
export function startTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // no storage: follow the system
  }
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = initialTheme(stored, prefersDark);
}
