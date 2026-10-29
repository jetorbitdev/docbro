import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, expect, test } from "vitest";
import { findAll, replaceAll, replaceOne, seedQuery } from "./find";
import { createHeadlessEditor } from "./headless";

type Mark = "bold" | "italic";

const t = (text: string, ...marks: Mark[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length && { marks: marks.map((type) => ({ type })) }),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const br: JSONContent = { type: "hardBreak" };
const docOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

let editors: Editor[] = [];
/** A mounted editor, so it has the undo history a window has. */
function make(...content: JSONContent[]): Editor {
  const editor = createHeadlessEditor(docOf(...content));
  editor.mount(document.createElement("div"));
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
});

/** The text of each textblock as runs of [text, marks], to compare words and their marks. */
function runs(editor: Editor): [string, string[]][][] {
  const out: [string, string[]][][] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isTextblock) return;
    const line: [string, string[]][] = [];
    node.forEach((child) => line.push([child.isText ? child.text! : `<${child.type.name}>`, child.marks.map((m) => m.type.name)]));
    out.push(line);
  });
  return out;
}
const lines = (editor: Editor) => runs(editor).map((r) => r.map(([text]) => text).join(""));
const found = (editor: Editor, query: string, opts?: Parameters<typeof findAll>[2]) =>
  findAll(editor.state.doc, query, opts).map((m) => editor.state.doc.textBetween(m.from, m.to, "|", "|"));
const apply = (editor: Editor, tr: ReturnType<typeof replaceAll>) => {
  expect(tr).not.toBeNull();
  editor.view.dispatch(tr!);
};

// ------------------------------------------------------------------ findAll

test("finds_across_mark_boundaries", () => {
  const editor = make(p(t("he"), t("llo", "bold"), t(" world")));
  expect(findAll(editor.state.doc, "hello")).toEqual([{ from: 1, to: 6 }]);
  expect(findAll(editor.state.doc, "o w")).toEqual([{ from: 5, to: 8 }]);
  // three runs with three different marks
  const mixed = make(p(t("a"), t("b", "bold"), t("c", "italic"), t("d", "bold", "italic")));
  expect(found(mixed, "abcd")).toEqual(["abcd"]);
});

test("does_not_match_across_paragraphs", () => {
  const editor = make(p(t("hel")), p(t("lo")));
  expect(findAll(editor.state.doc, "hello")).toEqual([]);
  expect(findAll(editor.state.doc, "lo")).toEqual([{ from: 7, to: 9 }]);
  // not through the end of one block and the start of the next, even with a space in the query
  expect(findAll(make(p(t("ab")), p(t("cd"))).state.doc, "b c")).toEqual([]);
  expect(findAll(make(p(t("ab")), p(t("cd"))).state.doc, "bc")).toEqual([]);
});

test("case_insensitive_option", () => {
  const editor = make(p(t("Hello HELLO hello")));
  expect(findAll(editor.state.doc, "hello")).toEqual([
    { from: 1, to: 6 },
    { from: 7, to: 12 },
    { from: 13, to: 18 },
  ]); // case is ignored unless asked for
  expect(findAll(editor.state.doc, "hello", { caseSensitive: false })).toHaveLength(3);
  expect(findAll(editor.state.doc, "hello", { caseSensitive: true })).toEqual([{ from: 13, to: 18 }]);
  expect(findAll(editor.state.doc, "Hello", { caseSensitive: true })).toEqual([{ from: 1, to: 6 }]);
});

test("replace_all_is_one_undo_step_and_keeps_bold", () => {
  const editor = make(p(t("a "), t("cat", "bold"), t(" and a cat")), p(t("the cat")));
  const before = editor.getJSON();
  apply(editor, replaceAll(editor.state, "cat", "dog"));
  expect(runs(editor)).toEqual([
    [["a ", []], ["dog", ["bold"]], [" and a dog", []]],
    [["the dog", []]],
  ]);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON()).toEqual(before);
  expect(editor.can().undo()).toBe(false); // that was the only step
  expect(editor.commands.redo()).toBe(true);
  expect(lines(editor)).toEqual(["a dog and a dog", "the dog"]);
});

test("replacement_containing_the_query_does_not_loop", () => {
  const editor = make(p(t("a b a")));
  apply(editor, replaceAll(editor.state, "a", "aa"));
  expect(lines(editor)).toEqual(["aa b aa"]);

  const words = make(p(t("cat")), p(t("a cat, the cat")));
  apply(words, replaceAll(words.state, "cat", "cat cat cat"));
  expect(lines(words)).toEqual(["cat cat cat", "a cat cat cat, the cat cat cat"]);

  const one = make(p(t("x x")));
  const first = findAll(one.state.doc, "x")[0];
  const tr = replaceOne(one.state, first, "xx");
  one.view.dispatch(tr);
  expect(lines(one)).toEqual(["xx x"]);
});

// ------------------------------------------------------------------ findAll: edge cases

test("an_empty_query_finds_nothing", () => {
  const editor = make(p(t("hello")));
  expect(findAll(editor.state.doc, "")).toEqual([]);
  expect(replaceAll(editor.state, "", "x")).toBeNull();
});

test("regex_characters_in_the_query_are_literal", () => {
  const editor = make(p(t("a.b a*b (c) [d] a+b \\w $1 ^x| ? {2} aab")));
  expect(found(editor, "a.b")).toEqual(["a.b"]); // not "a" + any character + "b"
  expect(found(editor, "a*b")).toEqual(["a*b"]);
  expect(found(editor, "a+b")).toEqual(["a+b"]);
  expect(found(editor, "(c)")).toEqual(["(c)"]);
  expect(found(editor, "[d]")).toEqual(["[d]"]);
  expect(found(editor, "\\w")).toEqual(["\\w"]);
  expect(found(editor, "$1")).toEqual(["$1"]);
  expect(found(editor, "^x|")).toEqual(["^x|"]);
  expect(found(editor, "?")).toEqual(["?"]);
  expect(found(editor, "{2}")).toEqual(["{2}"]);
  expect(found(editor, "(")).toEqual(["("]);
  expect(found(editor, "\\")).toEqual(["\\"]);
  expect(found(editor, ".*")).toEqual([]);
});

test("a_replacement_is_literal_text_not_a_pattern", () => {
  const editor = make(p(t("price: a")));
  apply(editor, replaceAll(editor.state, "a", "$& $1 $$ \\n"));
  expect(lines(editor)).toEqual(["price: $& $1 $$ \\n"]);
});

test("overlapping_candidates_give_non_overlapping_matches_from_the_left", () => {
  const editor = make(p(t("aaaa")));
  expect(findAll(editor.state.doc, "aa")).toEqual([
    { from: 1, to: 3 },
    { from: 3, to: 5 },
  ]);
  const odd = make(p(t("aaaaa")));
  expect(findAll(odd.state.doc, "aa")).toEqual([
    { from: 1, to: 3 },
    { from: 3, to: 5 },
  ]);
  const abab = make(p(t("ababa")));
  expect(found(abab, "aba")).toEqual(["aba"]); // the second "aba" overlaps the first
});

test("a_match_at_the_very_start_or_end_of_a_block", () => {
  const editor = make(p(t("hi there hi")), p(t("hi")));
  expect(findAll(editor.state.doc, "hi")).toEqual([
    { from: 1, to: 3 },
    { from: 10, to: 12 },
    { from: 14, to: 16 },
  ]);
  apply(editor, replaceAll(editor.state, "hi", "yo"));
  expect(lines(editor)).toEqual(["yo there yo", "yo"]);
  // the whole block is the match
  const whole = make(p(t("only")));
  expect(findAll(whole.state.doc, "only")).toEqual([{ from: 1, to: 5 }]);
  apply(whole, replaceAll(whole.state, "only", "x"));
  expect(lines(whole)).toEqual(["x"]);
});

test("a_query_longer_than_the_text_or_missing_finds_nothing", () => {
  const editor = make(p(t("ab")), p());
  expect(findAll(editor.state.doc, "abc")).toEqual([]);
  expect(findAll(editor.state.doc, "zzz")).toEqual([]);
  expect(replaceAll(editor.state, "zzz", "x")).toBeNull();
  expect(findAll(createHeadlessEditor().state.doc, "a")).toEqual([]); // an empty document
});

test("letters_match_without_regard_to_case_beyond_ascii", () => {
  const editor = make(p(t("École école ÉCOLE")));
  expect(found(editor, "école")).toEqual(["École", "école", "ÉCOLE"]);
  expect(found(editor, "É", { caseSensitive: true })).toEqual(["É", "É"]);
  expect(found(editor, "é", { caseSensitive: true })).toEqual(["é"]);
  expect(found(editor, "É")).toHaveLength(6); // É é É é … every é and É
  // Greek and Cyrillic fold too, and a letter whose uppercase is longer does not move the positions
  const other = make(p(t("ΣΑΣ привет ПРИВЕТ straße STRASSE")));
  expect(found(other, "σασ")).toEqual(["ΣΑΣ"]);
  expect(found(other, "привет")).toEqual(["привет", "ПРИВЕТ"]);
  expect(found(other, "STRASSE")).toEqual(["STRASSE"]); // ß is not "ss": no match for "straße"
  expect(found(other, "straße")).toEqual(["straße"]);
});

test("a_dotted_capital_i_cannot_shift_later_positions", () => {
  // "İ".toLowerCase() is two code units, which would move every match after it
  const editor = make(p(t("İİİ cat")));
  expect(findAll(editor.state.doc, "cat")).toEqual([{ from: 5, to: 8 }]);
  apply(editor, replaceAll(editor.state, "cat", "dog"));
  expect(lines(editor)).toEqual(["İİİ dog"]);
});

test("emoji_keep_positions_right_and_are_never_split", () => {
  const editor = make(p(t("😀 hi 😀 hi 👨‍👩‍👧")));
  const matches = findAll(editor.state.doc, "hi");
  expect(matches).toEqual([
    { from: 4, to: 6 },
    { from: 10, to: 12 },
  ]); // a smiley is two UTF-16 units, as ProseMirror counts them
  expect(found(editor, "hi")).toEqual(["hi", "hi"]);
  expect(found(editor, "😀")).toEqual(["😀", "😀"]);
  expect(findAll(editor.state.doc, "😀")[0]).toEqual({ from: 1, to: 3 });
  // half of a surrogate pair is not a character in the text
  expect(findAll(editor.state.doc, "\uDE00")).toEqual([]);
  expect(findAll(editor.state.doc, "\uD83D")).toEqual([]);
  // a family emoji is joined by invisible characters; searching for the whole thing finds it once
  expect(found(editor, "👨‍👩‍👧")).toEqual(["👨‍👩‍👧"]);

  apply(editor, replaceAll(editor.state, "hi", "😀😀"));
  expect(lines(editor)).toEqual(["😀 😀😀 😀 😀😀 👨‍👩‍👧"]);
  apply(editor, replaceAll(editor.state, "😀", "x"));
  expect(lines(editor)).toEqual(["x xx x x xx 👨‍👩‍👧"]);
});

test("an_emoji_split_over_two_marked_runs_is_still_whole_in_the_match", () => {
  const editor = make(p(t("a😀", "bold"), t("b")));
  expect(found(editor, "😀b")).toEqual(["😀b"]);
  apply(editor, replaceAll(editor.state, "😀b", "-"));
  expect(runs(editor)).toEqual([[["a", ["bold"]], ["-", ["bold"]]]]); // the first character's marks (the emoji's)
});

test("a_hard_break_ends_a_match_and_a_query_cannot_contain_one", () => {
  // Rule: matching works on each uninterrupted run of text; a hard break is a boundary, as a block end is.
  const editor = make(p(t("hello"), br, t("world"), br, t("hello")));
  expect(found(editor, "hello")).toEqual(["hello", "hello"]);
  expect(findAll(editor.state.doc, "helloworld")).toEqual([]);
  expect(findAll(editor.state.doc, "hello world")).toEqual([]);
  expect(findAll(editor.state.doc, "hello\nworld")).toEqual([]);
  expect(findAll(editor.state.doc, "o\nw")).toEqual([]);
  expect(findAll(editor.state.doc, "\n")).toEqual([]);
  expect(findAll(editor.state.doc, "world")).toEqual([{ from: 7, to: 12 }]);
});

test("matches_inside_table_cells_and_list_items", () => {
  const cell = (...content: JSONContent[]): JSONContent => ({ type: "tableCell", content: [p(...content)] });
  const header = (...content: JSONContent[]): JSONContent => ({ type: "tableHeader", content: [p(...content)] });
  const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content: [p(...content)] });
  const editor = make(
    p(t("one foo")),
    { type: "table", content: [
      { type: "tableRow", content: [header(t("Foo")), header(t("bar"))] },
      { type: "tableRow", content: [cell(t("a foo", "bold")), cell(t("foofoo"))] },
    ] },
    { type: "bulletList", content: [li(t("a foo")), li(t("b"))] },
    { type: "orderedList", attrs: { start: 1 }, content: [li(t("c FOO"))] },
    { type: "blockquote", content: [p(t("a "), t("fo", "italic"), t("o"))] },
  );
  expect(found(editor, "foo")).toEqual(["foo", "Foo", "foo", "foo", "foo", "foo", "FOO", "foo"]);
  apply(editor, replaceAll(editor.state, "foo", "quux"));
  expect(lines(editor)).toEqual(["one quux", "quux", "bar", "a quux", "quuxquux", "a quux", "b", "c quux", "a quux"]);
  // "a foo" in the cell was bold, and the bold survives; so does italic in the quote, from the first letter
  expect(runs(editor)[3]).toEqual([["a ", ["bold"]], ["quux", ["bold"]]].reduce<[string, string[]][]>((acc, r) => [...acc, r as [string, string[]]], []).slice(0, 0).concat([["a quux", ["bold"]]]));
  expect(runs(editor)[8]).toEqual([["a ", []], ["quux", ["italic"]]]);
  expect(editor.commands.undo()).toBe(true);
  expect(lines(editor)).toEqual(["one foo", "Foo", "bar", "a foo", "foofoo", "a foo", "b", "c FOO", "a foo"]);
});

test("find_all_stays_inside_the_given_range", () => {
  const editor = make(p(t("aa aa aa")), p(t("aa")));
  // "aa aa aa" is positions 1–9; the second paragraph's text is 11–13
  expect(findAll(editor.state.doc, "aa", { from: 4, to: 9 })).toEqual([
    { from: 4, to: 6 },
    { from: 7, to: 9 },
  ]);
  // a match that sticks out of the range is not a match
  expect(findAll(editor.state.doc, "aa", { from: 5, to: 9 })).toEqual([{ from: 7, to: 9 }]);
  expect(findAll(editor.state.doc, "aa", { from: 1, to: 8 })).toEqual([
    { from: 1, to: 3 },
    { from: 4, to: 6 },
  ]);
  // the range is the text searched: overlapping candidates start at its left edge
  expect(found(make(p(t("aaaa"))), "aa", { from: 2, to: 5 })).toEqual(["aa"]);
  expect(findAll(make(p(t("aaaa"))).state.doc, "aa", { from: 2, to: 5 })).toEqual([{ from: 2, to: 4 }]);
  // a range over several blocks
  expect(findAll(editor.state.doc, "aa", { from: 7, to: 13 })).toEqual([
    { from: 7, to: 9 },
    { from: 11, to: 13 },
  ]);
  // from only, to only, empty and reversed
  expect(findAll(editor.state.doc, "aa", { from: 11 })).toEqual([{ from: 11, to: 13 }]);
  expect(findAll(editor.state.doc, "aa", { to: 3 })).toEqual([{ from: 1, to: 3 }]);
  expect(findAll(editor.state.doc, "aa", { from: 5, to: 5 })).toEqual([]);
  expect(findAll(editor.state.doc, "aa", { from: 9, to: 2 })).toEqual([]);
  // out-of-document bounds are clamped, not an error
  expect(findAll(editor.state.doc, "aa", { from: -10, to: 9999 })).toHaveLength(4);
});

// ------------------------------------------------------------------ replace

test("replace_all_keeps_the_marks_of_the_first_character_of_each_match", () => {
  const editor = make(p(t("**"), t("he", "bold"), t("llo"), t(" "), t("he"), t("llo", "italic")));
  apply(editor, replaceAll(editor.state, "hello", "yo"));
  expect(runs(editor)).toEqual([[["**", []], ["yo", ["bold"]], [" ", []], ["yo", []]]]);
});

test("replacing_with_an_empty_string_deletes_the_matches", () => {
  const editor = make(p(t("a "), t("foo", "bold"), t(" b foo c")), p(t("foo")));
  apply(editor, replaceAll(editor.state, "foo", ""));
  expect(runs(editor)).toEqual([[["a  b  c", []]], []]);
  expect(editor.commands.undo()).toBe(true);
  expect(lines(editor)).toEqual(["a foo b foo c", "foo"]);

  const one = make(p(t("xfoox")));
  one.view.dispatch(replaceOne(one.state, { from: 2, to: 5 }, ""));
  expect(lines(one)).toEqual(["xx"]);
});

test("a_replacement_longer_than_the_match_leaves_later_matches_in_place", () => {
  const editor = make(p(t("a-a-a")), p(t("a")));
  apply(editor, replaceAll(editor.state, "a", "[long replacement]"));
  expect(lines(editor)).toEqual(["[long replacement]-[long replacement]-[long replacement]", "[long replacement]"]);
  const shorter = make(p(t("long long long")));
  apply(shorter, replaceAll(shorter.state, "long", "s"));
  expect(lines(shorter)).toEqual(["s s s"]);
});

test("replace_all_respects_the_options_and_the_range", () => {
  const editor = make(p(t("Cat cat CAT")));
  apply(editor, replaceAll(editor.state, "cat", "dog", { caseSensitive: true }));
  expect(lines(editor)).toEqual(["Cat dog CAT"]);
  const range = make(p(t("a a a a")));
  apply(range, replaceAll(range.state, "a", "b", { from: 3, to: 6 }));
  expect(lines(range)).toEqual(["a b b a"]);
});

test("replace_all_is_null_when_there_is_nothing_to_replace", () => {
  const editor = make(p(t("hello")));
  expect(replaceAll(editor.state, "world", "x")).toBeNull();
  expect(replaceAll(editor.state, "hello", "x", { from: 3, to: 4 })).toBeNull();
});

test("replace_all_keeps_the_selection_where_the_text_moved_it", () => {
  const editor = make(p(t("foo bar foo baz")));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 13)));
  expect(editor.state.doc.textBetween(13, 16)).toBe("baz");
  apply(editor, replaceAll(editor.state, "foo", "x"));
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.from + 3)).toBe("baz");
});

test("replace_one_replaces_just_that_match_and_keeps_its_marks", () => {
  const editor = make(p(t("a "), t("foo", "bold"), t(" foo")));
  const [first, second] = findAll(editor.state.doc, "foo");
  editor.view.dispatch(replaceOne(editor.state, second, "bar"));
  expect(runs(editor)).toEqual([[["a ", []], ["foo", ["bold"]], [" bar", []]]]);
  editor.view.dispatch(replaceOne(editor.state, first, "baz"));
  expect(runs(editor)).toEqual([[["a ", []], ["baz", ["bold"]], [" bar", []]]]);
});

test("a_newline_in_the_replacement_becomes_a_hard_break", () => {
  const editor = make(p(t("a-b", "bold")));
  apply(editor, replaceAll(editor.state, "-", "x\ny\r\nz"));
  expect(runs(editor)).toEqual([[
    ["a", ["bold"]], ["x", ["bold"]], ["<hardBreak>", ["bold"]], ["y", ["bold"]], ["<hardBreak>", ["bold"]], ["z", ["bold"]], ["b", ["bold"]],
  ]]);
  // and it is not a match for what was just put in
  expect(findAll(editor.state.doc, "x y")).toEqual([]);
});

// ------------------------------------------------------------------ seedQuery

test("the_selected_text_seeds_the_find_field", () => {
  const editor = make(p(t("hello "), t("brave", "bold"), t(" world")), p(t("next")));
  const select = (from: number, to: number) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  select(3, 3);
  expect(seedQuery(editor.state)).toBe(""); // a caret selects nothing
  select(1, 6);
  expect(seedQuery(editor.state)).toBe("hello");
  select(1, 17);
  expect(seedQuery(editor.state)).toBe("hello brave world"); // across marks
  select(1, 22);
  expect(seedQuery(editor.state)).toBe(""); // not across blocks
});

test("a_selection_with_a_hard_break_or_too_long_does_not_seed", () => {
  const editor = make(p(t("a"), br, t("b")), p(t("x".repeat(500))));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 4)));
  expect(seedQuery(editor.state)).toBe("");
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7, 507)));
  expect(seedQuery(editor.state)).toBe("");
});
