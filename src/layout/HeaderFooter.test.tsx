import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FooterZone, HeaderZone } from "./HeaderFooter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("the_text_zones_still_offer_to_add_and_edit_a_header_and_a_footer", () => {
  act(() => root.render(<><HeaderZone text={null} kept={false} onChange={() => {}} /><FooterZone text="" pageNumbers={false} pages={1} kept={false} onChange={() => {}} /></>));
  expect(host.querySelector(".hf-add-header")).not.toBeNull();
  expect(host.querySelector(".hf-footer")).not.toBeNull();
});

test("a_header_or_footer_kept_from_the_file_leaves_the_text_zones_out_of_the_way", () => {
  act(() => root.render(<><HeaderZone text={null} kept onChange={() => {}} /><FooterZone text={null} pageNumbers={false} pages={1} kept onChange={() => {}} /></>));
  expect(host.innerHTML).toBe("");
});
