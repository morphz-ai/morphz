import type { ReactNode } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";
import "./composer-compact.css";

/** Explain the actual next-input scope; opening it never navigates or sends. */
export function ComposerScope({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
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
    />
  );
}
