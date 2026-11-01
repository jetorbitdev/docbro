import type { ReactNode } from "react";
import type { AssistantStatus } from "../api";

/** What a form for one engine gets. */
export interface EngineFormProps {
  status: AssistantStatus;
  busy: boolean;
  /** the engine shown is not the one in use: saving picks it */
  pending: boolean;
  /** Saves; resolves to false when it failed (the section shows why). */
  save(p: Promise<AssistantStatus>): Promise<boolean>;
}

/** The Save button, with the reminder that saving is what switches the engine. */
export function SaveRow({ pending, disabled, onSave, children }: { pending: boolean; disabled: boolean; onSave(): void; children?: ReactNode }) {
  return (
    <div className="server-actions">
      {pending && <span className="mcp-note">Save to use this engine.</span>}
      <div className="spacer" />
      {children}
      <button className="line-btn primary" disabled={disabled} onClick={onSave}>
        Save
      </button>
    </div>
  );
}
