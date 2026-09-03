"use client";

import { useEffect } from "react";

const revealSelector = [
  ".home-hero__copy > *",
  ".home-hero__preview",
  ".home-section-heading > *",
  ".home-capability-domain",
  ".home-capability-domain__intro > *",
  ".home-capability-domain__points > section",
  ".home-mechanism__copy > *",
  ".home-mechanism__steps > article",
  ".home-cognitive-os > *",
  ".home-cognitive-os__conclusion > *",
  ".home-run__copy > *",
  ".home-run__command",
  ".home-evidence__links > a",
  ".home-docs > h2",
  ".home-docs > div > a",
  ".blog-index__header > *",
  ".blog-card",
  ".blog-article__header > *",
  ".blog-article__layout",
  ".project-page__header > *",
  ".project-page__statement > *",
  ".project-page__section > .project-page__label",
  ".project-page__rows > article",
  ".platform-grid > article",
  ".platform-note",
  ".project-page__closing > *",
  ".docs-index > .eyebrow",
  ".docs-index > h1",
  ".docs-index > .docs-index__lead",
  ".docs-index__start",
  ".docs-index__section > h2",
  ".docs-index__grid > a",
  ".doc-article > .doc-article__meta",
  ".doc-article > h1",
  ".doc-article > .doc-article__description",
  ".doc-prose > *",
  ".doc-article__footer",
  ".site-footer > *",
].join(",");

const parallaxSelector = [
  ".home-hero__preview",
  ".home-capability-domain__signature",
  ".home-capability-domain__points > section",
  ".home-mechanism__steps",
  ".home-cognitive-os__proof",
  ".project-page__statement",
  ".doc-prose h2",
].join(",");

function siblingOrder(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return 0;
  return Math.min(Array.from(parent.children).indexOf(element), 7);
}

export function SiteMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (reducedMotion.matches) {
      root.classList.add("motion-reduced");
      return () => root.classList.remove("motion-reduced");
    }

    const observed = new WeakSet<Element>();
    const parallaxElements = new Set<HTMLElement>();
    let frame = 0;

    const intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        intersection.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -7%", threshold: 0.08 });

    const updateMotion = () => {
      frame = 0;
      const viewportHeight = window.innerHeight || 1;
      const scrollable = Math.max(document.documentElement.scrollHeight - viewportHeight, 1);
      root.style.setProperty("--page-scroll-progress", String(Math.min(window.scrollY / scrollable, 1)));
      root.classList.toggle("site-has-scrolled", window.scrollY > 12);

      for (const element of parallaxElements) {
        if (!element.isConnected) {
          parallaxElements.delete(element);
          continue;
        }
        const bounds = element.getBoundingClientRect();
        const progress = Math.max(0, Math.min(1, (viewportHeight - bounds.top) / (viewportHeight + bounds.height)));
        const visibleProgress = Math.max(0, Math.min(1, (viewportHeight - bounds.top) / Math.max(bounds.height * 0.8, 1)));
        const motionProgress = element.matches(".home-mechanism__steps") ? visibleProgress : progress;
        const shift = (1 - progress) * 54;
        const signatureSpread = (1 - progress) * Math.min(72, window.innerWidth * 0.075);
        element.style.setProperty("--motion-progress", motionProgress.toFixed(4));
        element.style.setProperty("--motion-shift", `${shift.toFixed(2)}px`);
        element.style.setProperty("--motion-y", `${((progress - 0.5) * -18).toFixed(2)}px`);

        if (element.matches(".home-capability-domain__signature")) {
          const domain = element.closest<HTMLElement>(".home-capability-domain");
          const rawSignatureProgress = Math.max(0, Math.min(1, (progress - 0.03) / 0.44));
          const signatureProgress = rawSignatureProgress * rawSignatureProgress * (3 - 2 * rawSignatureProgress);
          element.style.setProperty("--signature-progress", signatureProgress.toFixed(4));

          if (domain?.classList.contains("home-capability-domain--maintenance")) {
            element.style.setProperty("--signature-left-x", `${(-signatureSpread).toFixed(2)}px`);
            element.style.setProperty("--signature-right-x", `${signatureSpread.toFixed(2)}px`);
            element.style.setProperty("--signature-left-y", "0px");
            element.style.setProperty("--signature-right-y", "0px");
          }
        }

        if (element.matches(".home-capability-domain__points > section")) {
          const order = siblingOrder(element);
          const direction = order % 2 === 0 ? -1 : 1;
          const drift = (progress - 0.5) * 14 * direction;
          const accentScale = Math.min(progress * 1.8, 1);
          element.style.setProperty("--card-drift", `${drift.toFixed(2)}px`);
          element.style.setProperty("--card-accent-scale", accentScale.toFixed(4));
        }
      }
    };

    const requestUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateMotion);
    };

    const register = () => {
      document.querySelectorAll<HTMLElement>(revealSelector).forEach((element) => {
        if (observed.has(element)) return;
        observed.add(element);
        element.classList.add("motion-reveal");
        element.style.setProperty("--reveal-order", String(siblingOrder(element)));
        intersection.observe(element);
      });

      document.querySelectorAll<HTMLElement>(".home-capability-domain__signature").forEach((element) => {
        if (observed.has(element)) return;
        observed.add(element);
        intersection.observe(element);
      });

      document.querySelectorAll<HTMLElement>(parallaxSelector).forEach((element) => {
        parallaxElements.add(element);
      });

      root.classList.add("motion-ready");
      requestUpdate();
    };

    const mutations = new MutationObserver(() => window.requestAnimationFrame(register));
    mutations.observe(document.body, { childList: true, subtree: true });
    register();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      intersection.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      if (frame) window.cancelAnimationFrame(frame);
      root.classList.remove("motion-ready", "site-has-scrolled");
      root.style.removeProperty("--page-scroll-progress");
    };
  }, []);

  return null;
}
