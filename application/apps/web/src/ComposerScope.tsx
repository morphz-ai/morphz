import type { ReactNode } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";
import "./composer-compact.css";

/** Explain the actual next-input scope; opening it never navigates or sends. */
export function ComposerScope({
  label,
  description,
  children,
  expandable = false,
  showPlainScope = true,
  onOpenChange,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
  expandable?: boolean;
  /** An implicit personal desk is routing, not a visible association. */
  showPlainScope?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  if (!expandable && !showPlainScope) return null;
  if (!expandable)
    return (
      <span
        className="composer-scope-label"
        title={description || label}
        aria-label={`输入关联：${description || label}`}
      >
        <Link2 aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  return (
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
}
