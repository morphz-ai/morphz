import { useState, type CSSProperties, type SyntheticEvent } from "react";

/** Size a media dialog around the image, not around the short-form default. */
export function useImagePreviewSize() {
  const [size, setSize] = useState({ width: 960, height: 600 });
  return {
    style: {
      "--preview-image-width": `${size.width}px`,
      "--preview-image-ratio": size.width / size.height,
    } as CSSProperties,
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => {
      const { naturalWidth: width, naturalHeight: height } =
        event.currentTarget;
      if (width && height)
        setSize((old) =>
          old.width === width && old.height === height
            ? old
            : { width, height },
        );
    },
  };
}
