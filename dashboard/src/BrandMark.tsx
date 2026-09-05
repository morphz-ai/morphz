// Share the website's small-size electric-cyan mark with the browser tab.
// Keep the URL relative to the deployment <base>, including proxy prefixes.
export function BrandMark() {
  return (
    <img
      className="morphz-brand-mark"
      src="./favicon.svg?brand=cyan-butterfly"
      width={24}
      height={24}
      alt=""
      aria-hidden="true"
    />
  )
}
