"use client";

import { useEffect } from "react";

export function LandingMotion() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("motion-ready");
    const elements = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.13, rootMargin: "0px 0px -8%" },
    );
    elements.forEach((element) => observer.observe(element));

    let frame = 0;
    const update = () => {
      frame = 0;
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      root.style.setProperty("--page-progress", String(Math.min(1, scrollY / max)));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      root.classList.remove("motion-ready");
      root.style.removeProperty("--page-progress");
    };
  }, []);

  return <span className="landing-progress" aria-hidden="true" />;
}
