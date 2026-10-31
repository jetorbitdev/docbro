import { useEffect, useRef } from "react";
import type { DocMeta } from "../doc/meta";
import { pageLabel } from "./pages";

interface FieldProps {
  value: string;
  label: string;
  onChange(value: string): void;
}

/** One editable line: plain text only, and Enter puts the page back in charge. */
function Field({ value, label, onChange }: FieldProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== value) el.textContent = value;
  }, [value]);

  return (
    <div
      ref={ref}
      className="hf-line"
      contentEditable
      role="textbox"
      aria-label={`${label} text`}
      data-placeholder={`${label} text`}
      spellCheck={false}
      onInput={(e) => onChange(e.currentTarget.textContent ?? "")}
      onBlur={(e) => onChange((e.currentTarget.textContent ?? "").trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

interface HeaderProps {
  text: string | null;
  onChange(patch: Partial<DocMeta>): void;
}

/** Mock 134–144: an off header is a hover strip; an on one is a dashed line above the page. */
export function HeaderZone({ text, onChange }: HeaderProps) {
  if (text === null)
    return (
      <button className="hf-add hf-add-header" onClick={() => onChange({ header: "" })}>
        + Add header
      </button>
    );

  return (
    <div className="hf-zone hf-header">
      <span className="hf-tag">HEADER</span>
      <Field value={text} label="Header" onChange={(header) => onChange({ header })} />
      <button className="hf-btn" onClick={() => onChange({ header: null })}>
        Remove
      </button>
    </div>
  );
}

interface FooterProps extends HeaderProps {
  pageNumbers: boolean;
  pages: number;
}

/** Mock 145–155: the footer also carries the page-number toggle. */
export function FooterZone({ text, pageNumbers, pages, onChange }: FooterProps) {
  if (text === null)
    return (
      <button className="hf-add hf-add-footer" onClick={() => onChange({ footer: "" })}>
        + Add footer
      </button>
    );

  return (
    <div className="hf-zone hf-footer">
      <span className="hf-tag">FOOTER</span>
      <Field value={text} label="Footer" onChange={(footer) => onChange({ footer })} />
      <button
        className={`hf-page${pageNumbers ? " on" : ""}`}
        title="Toggle page numbers"
        onClick={() => onChange({ pageNumbers: !pageNumbers })}
      >
        {pageLabel(pageNumbers, pages)}
      </button>
      <button className="hf-btn" onClick={() => onChange({ footer: null, pageNumbers: false })}>
        Remove
      </button>
    </div>
  );
}
