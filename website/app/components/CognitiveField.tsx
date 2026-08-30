"use client";

import { useEffect, useRef } from "react";

type Particle = {
  angle: number;
  radius: number;
  speed: number;
  size: number;
  alpha: number;
  layer: number;
};

/**
 * The hero's kinetic context field. It is deliberately a semantic scene rather
 * than ambient particle decoration: observations travel toward a Context core,
 * orbit as selected structures, then leave as a committed state.
 */
export function CognitiveField() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const particles: Particle[] = Array.from({ length: 58 }, (_, index) => ({
      angle: (index / 58) * Math.PI * 2 + Math.random() * 0.3,
      radius: 0.18 + Math.random() * 0.42,
      speed: 0.000035 + Math.random() * 0.000075,
      size: 0.7 + Math.random() * 1.8,
      alpha: 0.16 + Math.random() * 0.58,
      layer: index % 3,
    }));

    let width = 1;
    let height = 1;
    let dpr = 1;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let targetX = 0;
    let targetY = 0;
    let scroll = 0;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onPointer = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      targetX = (event.clientX - rect.left) / rect.width - 0.5;
      targetY = (event.clientY - rect.top) / rect.height - 0.5;
    };
    const onLeave = () => {
      targetX = 0;
      targetY = 0;
    };
    const onScroll = () => {
      const rect = host.getBoundingClientRect();
      scroll = Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height)));
    };

    const draw = (time: number) => {
      pointerX += (targetX - pointerX) * 0.035;
      pointerY += (targetY - pointerY) * 0.035;
      context.clearRect(0, 0, width, height);

      const cx = width * (width < 820 ? 0.69 : 0.72) + pointerX * 26;
      const cy = height * (width < 820 ? 0.32 : 0.44) + pointerY * 22 - scroll * 28;
      const scale = Math.min(width, height);

      const haze = context.createRadialGradient(cx, cy, 0, cx, cy, scale * 0.42);
      haze.addColorStop(0, "rgba(91, 128, 255, .18)");
      haze.addColorStop(0.28, "rgba(91, 128, 255, .055)");
      haze.addColorStop(1, "rgba(91, 128, 255, 0)");
      context.fillStyle = haze;
      context.fillRect(0, 0, width, height);

      context.save();
      context.translate(pointerX * -12, pointerY * -10);
      for (let ring = 0; ring < 5; ring += 1) {
        const radiusX = scale * (0.105 + ring * 0.054);
        const radiusY = radiusX * (0.45 + ring * 0.025);
        context.beginPath();
        context.ellipse(cx, cy, radiusX, radiusY, -0.28 + ring * 0.11, 0, Math.PI * 2);
        context.strokeStyle = `rgba(143, 164, 255, ${0.13 - ring * 0.015})`;
        context.lineWidth = 0.8;
        context.stroke();
      }
      context.restore();

      particles.forEach((particle, index) => {
        const motion = reduceMotion ? 0 : time * particle.speed;
        const angle = particle.angle + motion + scroll * (0.8 + particle.layer * 0.3);
        const radius = particle.radius * scale;
        const px = cx + Math.cos(angle) * radius * (1.22 + particle.layer * 0.13) + pointerX * (8 + particle.layer * 9);
        const py = cy + Math.sin(angle) * radius * 0.53 + pointerY * (8 + particle.layer * 7);
        const nearCore = index % 5 === 0;

        if (nearCore) {
          context.beginPath();
          context.moveTo(px, py);
          context.quadraticCurveTo(
            (px + cx) / 2 + Math.sin(angle) * 45,
            (py + cy) / 2 - Math.cos(angle) * 35,
            cx,
            cy,
          );
          context.strokeStyle = `rgba(118, 145, 255, ${particle.alpha * 0.16})`;
          context.lineWidth = 0.7;
          context.stroke();
        }

        context.beginPath();
        context.arc(px, py, particle.size, 0, Math.PI * 2);
        context.fillStyle = index % 11 === 0
          ? `rgba(255, 142, 116, ${particle.alpha})`
          : `rgba(178, 193, 255, ${particle.alpha})`;
        context.fill();
      });

      const pulse = reduceMotion ? 0.5 : (Math.sin(time * 0.0022) + 1) / 2;
      const core = context.createRadialGradient(cx, cy, 0, cx, cy, 46 + pulse * 12);
      core.addColorStop(0, "rgba(245, 248, 255, .98)");
      core.addColorStop(0.08, "rgba(170, 190, 255, .9)");
      core.addColorStop(0.24, "rgba(82, 116, 255, .35)");
      core.addColorStop(1, "rgba(63, 96, 230, 0)");
      context.fillStyle = core;
      context.beginPath();
      context.arc(cx, cy, 58 + pulse * 8, 0, Math.PI * 2);
      context.fill();

      if (!reduceMotion) frame = requestAnimationFrame(draw);
    };

    host.addEventListener("pointermove", onPointer);
    host.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    resize();
    onScroll();
    draw(performance.now());

    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("pointermove", onPointer);
      host.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div ref={hostRef} className="cognitive-field" aria-hidden="true">
      <canvas ref={canvasRef} />
      <div className="cognitive-field__grid" />
      <div className="cognitive-field__glyph cognitive-field__glyph--open">(</div>
      <div className="cognitive-field__glyph cognitive-field__glyph--close">)</div>
    </div>
  );
}
