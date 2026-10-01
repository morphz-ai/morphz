import { useId } from "react";

/** Shared silhouette of the Morphz mark, using the active Dashboard accent. */
export function BrandMark({ lively = false }: { lively?: boolean } = {}) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="brand-mark" viewBox="0 0 96 96" aria-hidden="true">
      <path
        id={lively ? `${id}-shape` : undefined}
        fill="currentColor"
        stroke="none"
        d="M8 4 48 40 38 40 38 70 8 92Z M88 4 48 40 58 40 58 70 88 92Z"
      />
      {lively && (
        <>
          <defs>
            <clipPath id={`${id}-clip`}>
              <use href={`#${id}-shape`} />
            </clipPath>
            <linearGradient id={`${id}-light`}>
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="0.5" stopColor="white" stopOpacity="0.65" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g clipPath={`url(#${id}-clip)`}>
            <rect
              className="brand-mark-glint"
              x="-48"
              y="0"
              width="48"
              height="96"
              fill={`url(#${id}-light)`}
            />
          </g>
        </>
      )}
    </svg>
  );
}
