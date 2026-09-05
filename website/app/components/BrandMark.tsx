import Image from "next/image";

export function BrandMark() {
  return (
    <span className="brand__icon" aria-hidden="true">
      <Image className="brand__mark" src="/brand/morphz-mark-cyan.svg" width={28} height={28} alt="" unoptimized />
      <svg className="brand__wings" viewBox="0 0 96 96" width="28" height="28" focusable="false">
        <path className="brand__wing brand__wing--left" d="M8 4 48 40 38 40 38 70 8 92Z" />
        <path className="brand__wing brand__wing--right" d="M88 4 48 40 58 40 58 70 88 92Z" />
      </svg>
    </span>
  );
}
