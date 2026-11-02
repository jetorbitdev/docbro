import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GoogleStatus } from "../api";
import { GoogleSection } from "./GoogleSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENT = "1234-abc.apps.googleusercontent.com";

const none: GoogleStatus = {
  client_id: "", custom_client: false, built_in: false, secret_hint: null, connected: false, email: null, signing_in: false,
};
const ready: GoogleStatus = { ...none, client_id: CLIENT, custom_client: true, secret_hint: "lue1" };

let host: HTMLElement;
let root: Root;
let calls: { cmd: string; args: Record<string, unknown> }[];
let status: GoogleStatus;
// what google_connect answers with, settled by the test
let connecting: { resolve(s: GoogleStatus): void; reject(e: string): void } | null;

beforeEach(() => {
  mockWindows("main");
  calls = [];
  status = none;
  connecting = null;
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "google_status":
        return status;
      case "google_save_client":
        status = { ...ready, client_id: args.clientId as string };
        return status;
      case "google_connect":
        return new Promise((resolve, reject) => (connecting = { resolve, reject }));
      case "google_cancel":
        connecting?.reject("The sign-in was cancelled.");
        return null;
      case "google_open_console":
        return null;
      case "google_disconnect":
        status = ready;
        return status;
    }
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearMocks();
});

const render = async () => {
  await act(async () => root.render(<GoogleSection />));
};
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const type = (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const click = async (b: HTMLButtonElement) => {
  await act(async () => b.click());
};

test("with_no_oauth_client_connect_waits_for_one_and_the_client_form_is_open", async () => {
  await render();
  expect(button("Connect").disabled).toBe(true);
  const id = host.querySelector<HTMLInputElement>('input[aria-label="Client ID"]')!;
  const secret = host.querySelector<HTMLInputElement>('input[aria-label="Client secret"]')!;
  await act(async () => {
    type(id, ` ${CLIENT} `);
    type(secret, "GOCSPX-value1");
  });
  await click(button("Save"));
  expect(calls.find((c) => c.cmd === "google_save_client")?.args).toEqual({ clientId: CLIENT, clientSecret: "GOCSPX-value1" });
  // the form folds away for Connect, and opened again shows only the secret's last four characters
  expect(button("Connect").disabled).toBe(false);
  expect(host.querySelector('input[aria-label="Client secret"]')).toBeNull();
  await click(host.querySelector<HTMLButtonElement>(".google-client-toggle")!);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Client secret"]')!.value).toBe("");
  expect(host.textContent).toContain("•••• lue1");
  expect(host.innerHTML).not.toContain("GOCSPX-value1");
});

test("connecting_waits_for_the_browser_and_shows_the_account", async () => {
  status = ready;
  await render();
  await click(button("Connect"));
  expect(host.textContent).toContain("Waiting for you to sign in in the browser");
  await act(async () => connecting!.resolve({ ...ready, connected: true, email: "rina@example.com" }));
  expect(host.textContent).toContain("rina@example.com");
  expect(button("Disconnect")).toBeTruthy();

  await click(button("Disconnect"));
  expect(button("Connect")).toBeTruthy();
});

test("a_cancelled_sign_in_shows_no_error", async () => {
  status = ready;
  await render();
  await click(button("Connect"));
  await click(button("Cancel"));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("Connect")).toBeTruthy();
});

test("a_declined_sign_in_says_why", async () => {
  status = ready;
  await render();
  await click(button("Connect"));
  await act(async () => connecting!.reject("Google sign-in was declined, so DocBro is not connected."));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Google sign-in was declined, so DocBro is not connected.");
});

test("the_setup_steps_open_their_google_cloud_console_pages", async () => {
  await render();
  await click(button("turn on the Google Drive API"));
  await click(button("create an OAuth client ID"));
  expect(calls.filter((c) => c.cmd === "google_open_console").map((c) => c.args.page)).toEqual(["drive_api", "oauth_client"]);
});
