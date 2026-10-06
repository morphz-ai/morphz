import type { ReactNode } from "react";
import { ChevronDown, Link2, X } from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";
import "./composer-compact.css";

/** Explain the actual next-input scope; opening it never navigates or sends. */
export function ComposerScope({
  label,
  description,
  children,
  expandable = false,
  showPlainScope = true,
  dismissal,
  onOpenChange,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
  expandable?: boolean;
  /** An implicit personal desk is routing, not a visible association. */
  showPlainScope?: boolean;
  /** Only explicit local bindings are dismissible; never the implicit owner. */
  dismissal?: { label: string; disabled?: boolean; onRemove(): void };
  onOpenChange?(open: boolean): void;
}) {
  if (!expandable && !showPlainScope) return null;
  const summary = !expandable ? (
    <span
      className="composer-scope-label"
      title={description || label}
      aria-label={`输入关联：${description || label}`}
    >
      <Link2 aria-hidden="true" />
      <span>{label}</span>
    </span>
  ) : (
    <ComposerOptions
      label="输入关联"
      description={description || label}
      menuLabel="本次输入关联"
      triggerClassName="composer-scope-trigger"
      menuClassName="composer-scope-menu"
      triggerIcon={
        <>
          <Link2 />
          <span>{label}</span>
          <ChevronDown />
        </>
      }
      options={[]}
      header={<h3>本次输入关联</h3>}
      persistentContent={children || <p>{description || label}</p>}
      onOpenChange={onOpenChange}
    />
  );
  if (!dismissal) return summary;
  return (
    <div className="composer-scope-association">
      {summary}
      <button
        type="button"
        className="icon-button composer-scope-remove"
        aria-label={dismissal.label}
        title={dismissal.label}
        disabled={dismissal.disabled}
        onClick={dismissal.onRemove}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
