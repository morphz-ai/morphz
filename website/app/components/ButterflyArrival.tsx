"use client";

import { useEffect, useRef } from "react";
import type { Locale } from "@/lib/docs";
import { ARRIVAL_DELAY, ARRIVAL_DURATION, arrivalFrame, butterflyWingPath, cyanStop } from "@/lib/butterfly-motion";

// A full reload is a new visit. Client-side routes and Strict Mode remounts
// must not replay the welcome while someone is reading the site.
let playedInDocument = false;

export function ButterflyArrival({ locale }: { locale: Locale }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // There is one arrival per localized home page. Route-stable IDs also avoid
  // depending on SSR/client tree-generated IDs in the RSC router.
  const upperGradient = `home-butterfly-upper-${locale}`;
  const lowerGradient = `home-butterfly-lower-${locale}`;

  useEffect(() => {
    const root = rootRef.current;
    const target = document.querySelector<HTMLElement>(".site-header .brand__icon");
    const header = document.querySelector<HTMLElement>(".site-header");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!root || !target || !header || playedInDocument || motion.matches || document.hidden || window.scrollY > 24) return;

    const box = target.getBoundingClientRect();
    if (!box.width || box.bottom < 0) return;
    const narrow = window.innerWidth < 640;
    const wordmark = target.parentElement!.getBoundingClientRect();
    const geometry = {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      size: box.width,
      hoverX: narrow ? window.innerWidth - 64 : Math.min(wordmark.right + 100, window.innerWidth - 90),
      hoverY: header.getBoundingClientRect().bottom + (narrow ? 34 : 62),
      hoverSize: narrow ? 64 : 88,
      travel: narrow ? 110 : 235,
    };
    const wings = root.querySelectorAll<SVGGElement>("[data-arrival-wing]");
    const upperWings = root.querySelectorAll<SVGPathElement>("[data-arrival-upper]");
    const details = root.querySelectorAll<SVGElement>("[data-arrival-detail]");
    const lowerWings = root.querySelectorAll<SVGGElement>("[data-arrival-lower]");
    const stops = root.querySelectorAll<SVGStopElement>("[data-arrival-stop]");
    const colors = [[181, 247, 244], [86, 208, 222], [26, 166, 188]];
    const interactions = ["pointerdown", "wheel", "touchstart", "keydown", "scroll", "resize"] as const;
    let frame = 0;
    let started: number | undefined;
    let stopped = false;
    let failSafe = 0;

    const finish = (event?: Event) => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(failSafe);
      root.style.opacity = "0";
      root.dataset.arrivalState = "done";
      root.dataset.arrivalEnd = event?.type ?? "complete";
      interactions.forEach((event) => window.removeEventListener(event, finish));
      document.removeEventListener("visibilitychange", finish);
      motion.removeEventListener("change", finish);
    };

    const tick = (now: number) => {
      if (stopped) return;
      if (started === undefined) {
        started = now;
        playedInDocument = true;
      }
      const elapsed = now - started - ARRIVAL_DELAY;
      if (elapsed >= ARRIVAL_DURATION) { finish(); return; }
      if (elapsed >= 0) {
        const state = arrivalFrame(elapsed, geometry);
        root.dataset.arrivalState = state.phase;
        root.style.opacity = String(state.opacity);
        root.style.transform = `translate3d(${state.x - state.size / 2}px, ${state.y - state.size / 2}px, 0) rotate(${state.angle}deg) scale(${state.size / 256})`;
        upperWings.forEach((wing) => wing.setAttribute("d", state.path));
        wings.forEach((wing) => wing.setAttribute("transform", `translate(128 140) scale(${state.flutter} 1) translate(-128 -140)`));
        details.forEach((detail) => detail.setAttribute("opacity", String(state.detailOpacity)));
        lowerWings.forEach((wing) => wing.setAttribute("transform", `translate(128 140) scale(${state.lowerScale}) translate(-128 -140)`));
        stops.forEach((stop, index) => stop.setAttribute("stop-color", cyanStop(colors[index], state.morph)));
      }
      frame = window.requestAnimationFrame(tick);
    };

    interactions.forEach((event) => window.addEventListener(event, finish, { passive: true }));
    document.addEventListener("visibilitychange", finish);
    motion.addEventListener("change", finish);
    failSafe = window.setTimeout(finish, ARRIVAL_DELAY + ARRIVAL_DURATION + 1000);
    frame = window.requestAnimationFrame(tick);
    return finish;
  }, []);

  return (
    <div className="butterfly-arrival" ref={rootRef} aria-hidden="true" data-arrival-state="idle">
      <svg viewBox="0 0 256 256" width="256" height="256" focusable="false">
        <defs>
          <linearGradient id={upperGradient} x1="30" y1="29" x2="109" y2="151" gradientUnits="userSpaceOnUse">
            <stop data-arrival-stop="" stopColor="#b5f7f4" />
            <stop data-arrival-stop="" offset="0.48" stopColor="#56d0de" />
            <stop data-arrival-stop="" offset="1" stopColor="#1aa6bc" />
          </linearGradient>
          <linearGradient id={lowerGradient} x1="105" y1="150" x2="55" y2="228" gradientUnits="userSpaceOnUse">
            <stop stopColor="#72e4e8" /><stop offset="0.5" stopColor="#40c7d5" /><stop offset="1" stopColor="#158ea5" />
          </linearGradient>
        </defs>
        {[false, true].map((right) => (
          <g key={String(right)} transform={right ? "translate(256 0) scale(-1 1)" : undefined}>
            <g data-arrival-wing="">
              <path data-arrival-upper="" d={butterflyWingPath(0)} fill={`url(#${upperGradient})`} />
              <path data-arrival-detail="" d="M26 26C32 72 54 111 91 135C63 123 39 88 26 26Z" fill="#d0fffa" fillOpacity="0.3" />
              <g data-arrival-lower="" data-arrival-detail="">
                <path d="M116 156C95 147 68 151 56 171C43 192 47 215 61 231C87 220 109 194 120 167C122 162 120 158 116 156Z" fill={`url(#${lowerGradient})`} />
                <path d="M61 231C68 206 86 181 110 162C91 183 78 207 61 231Z" fill="#c8fff5" fillOpacity="0.2" />
              </g>
            </g>
          </g>
        ))}
        <g data-arrival-detail="" fill="#56d0de">
          <path d="M123 105C122 94 117 86 111 80M133 105C134 94 139 86 145 80" fill="none" stroke="#56d0de" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="128" cy="112" r="7" />
          <path d="M128 123C123 123 121 136 122 152C123 174 125 190 128 202C131 190 133 174 134 152C135 136 133 123 128 123Z" />
        </g>
      </svg>
    </div>
  );
}
