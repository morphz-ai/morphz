import type {
  ReadingPosition,
  ReadingReference,
} from "../../../packages/core/src/reader.js";

export type ReadingFocus =
  | { reference: ReadingReference; selected: true }
  | { reference: ReadingPosition; selected: false };
export type ReadingSurface = {
  key: string;
  artifactId: string;
  revision: number;
  focus: ReadingFocus | null;
  capture: () => ReadingFocus | null;
};
export type ReadingContextChange = (
  key: string,
  surface: ReadingSurface | null,
) => void;
