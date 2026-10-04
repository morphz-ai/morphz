import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModal } from "../../useModal.js";

export function StudioDialog({
  title,
  children,
  onClose,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModal(dialog);
  return (
    <dialog
      ref={dialog}
      className={`create-dialog script-dialog${compact ? " script-dialog-compact" : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {children}
    </dialog>
  );
}
