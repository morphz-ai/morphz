"use client";

export function ThemeToggle({ label }: { label: string }) {
  function toggleTheme() {
    const root = document.documentElement;
    const current = root.dataset.theme
      ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";

    root.dataset.theme = next;
    root.style.colorScheme = next;
    window.localStorage.setItem("morphz-theme", next);
  }

  return (
    <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={label} title={label}>
      <svg className="theme-toggle__moon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M15.6 12.7A6.4 6.4 0 0 1 7.3 4.4 6.2 6.2 0 1 0 15.6 12.7Z" />
      </svg>
      <svg className="theme-toggle__sun" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.2" />
        <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4" />
      </svg>
    </button>
  );
}
