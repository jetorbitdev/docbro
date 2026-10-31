import { beforeEach, expect, test, vi } from "vitest";
import { activity } from "./activity";

beforeEach(() => activity.clear());

test("keeps_the_newest_50", () => {
  for (let i = 1; i <= 60; i++) activity.begin("document_info", { n: i });
  const list = activity.list();
  expect(list).toHaveLength(50);
  // oldest first, as the panel shows them
  expect(list[0].args).toBe('{"n":11}');
  expect(list[49].args).toBe('{"n":60}');
});

test("cuts_long_args_with_an_ellipsis", () => {
  activity.begin("insert_content", { markdown: "x".repeat(500) });
  const { args } = activity.list()[0];
  expect(args).toHaveLength(200);
  expect(args.endsWith("…")).toBe(true);
  expect(args.startsWith('{"markdown":"xxx')).toBe(true);
  // short ones stay whole
  activity.begin("read_document", { from: 1, to: 3 });
  expect(activity.list()[1].args).toBe('{"from":1,"to":3}');
});

test("finish_marks_done_or_error_and_notifies_subscribers", () => {
  const seen = vi.fn();
  const stop = activity.subscribe(seen);
  const a = activity.begin("undo", {});
  const b = activity.begin("delete_blocks", { from: 9 });
  expect(activity.list().map((e) => e.state)).toEqual(["running", "running"]);
  expect(seen).toHaveBeenCalledTimes(2);

  const before = activity.list();
  activity.finish(a, true, "Undone.");
  activity.finish(b, false, "There is no block 9.");
  expect(activity.list()).toMatchObject([
    { id: a, tool: "undo", state: "done", message: "Undone." },
    { id: b, tool: "delete_blocks", state: "error", message: "There is no block 9." },
  ]);
  // a new list each change, so a React snapshot sees it changed
  expect(activity.list()).not.toBe(before);
  expect(seen).toHaveBeenCalledTimes(4);

  stop();
  activity.begin("redo", {});
  expect(seen).toHaveBeenCalledTimes(4);
});

test("clear_empties_the_list", () => {
  const seen = vi.fn();
  const stop = activity.subscribe(seen);
  const id = activity.begin("document_info", {});
  activity.clear();
  expect(activity.list()).toEqual([]);
  expect(seen).toHaveBeenCalledTimes(2);
  // a call that was running when the feed was cleared finishes quietly
  activity.finish(id, true, "{}");
  expect(activity.list()).toEqual([]);
  stop();
});
