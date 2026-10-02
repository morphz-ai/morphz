import { useRef, useState, type DetailsHTMLAttributes } from "react";
import { scopedStorage } from "./local-preferences.js";

type Props = Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  "open" | "onToggle"
> & {
  storageScope?: string;
  preferenceKey: string;
};

/** Only presentation state: never Profile data or an execution binding. */
export function PersistentDetails(props: Props) {
  return (
    <ScopedDetails
      key={JSON.stringify([props.storageScope, props.preferenceKey])}
      {...props}
    />
  );
}

function ScopedDetails({ storageScope, preferenceKey, ...props }: Props) {
  const [storage] = useState(() =>
    storageScope ? scopedStorage(storageScope) : undefined,
  );
  const key = `disclosure:${preferenceKey}`;
  const [open, setOpen] = useState(
    () => storage?.readLocal<unknown>(key, false) === true,
  );
  const current = useRef(open);
  return (
    <details
      {...props}
      open={open}
      onToggle={(event) => {
        // A nested disclosure must never overwrite its parent's choice.
        if (event.target !== event.currentTarget) return;
        const next = event.currentTarget.open;
        if (next === current.current) return;
        current.current = next;
        setOpen(next);
        try {
          storage?.writeLocal(key, next);
        } catch {
          // Unavailable client storage must not disable the live control.
        }
      }}
    />
  );
}
