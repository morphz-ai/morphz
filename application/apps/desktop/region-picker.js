const shade = document.getElementById("shade");
const box = document.getElementById("selection");
const size = document.getElementById("size");
const cancel = document.getElementById("cancel");
let start = null;
let rectangle = null;
let completed = false;
function draw() {
  const outside = `M0 0H${innerWidth}V${innerHeight}H0Z`;
  shade.setAttribute(
    "d",
    rectangle
      ? `${outside} M${rectangle.x} ${rectangle.y}h${rectangle.width}v${rectangle.height}h${-rectangle.width}Z`
      : outside,
  );
  box.hidden = size.hidden = !rectangle;
  if (!rectangle) return;
  Object.assign(box.style, {
    left: `${rectangle.x}px`,
    top: `${rectangle.y}px`,
    width: `${rectangle.width}px`,
    height: `${rectangle.height}px`,
  });
  size.textContent = `${Math.round(rectangle.width)} × ${Math.round(rectangle.height)}`;
  size.style.left = `${Math.min(innerWidth - 120, Math.max(8, rectangle.x + rectangle.width - 100))}px`;
  size.style.top = `${Math.min(innerHeight - 36, rectangle.y + rectangle.height + 9)}px`;
}
function update(event) {
  const x = Math.max(0, Math.min(innerWidth, event.clientX));
  const y = Math.max(0, Math.min(innerHeight, event.clientY));
  rectangle = {
    x: Math.min(start.x, x),
    y: Math.min(start.y, y),
    width: Math.abs(x - start.x),
    height: Math.abs(y - start.y),
  };
  draw();
}
addEventListener("pointerdown", (event) => {
  if (
    !event.isTrusted ||
    completed ||
    event.button !== 0 ||
    event.target.closest("button")
  )
    return;
  start = { x: event.clientX, y: event.clientY };
  document.body.dataset.dragging = "true";
  document.body.setPointerCapture(event.pointerId);
  update(event);
});
addEventListener("pointermove", (event) => {
  if (start && !completed) update(event);
});
addEventListener("pointerup", (event) => {
  if (!event.isTrusted || !start || completed) return;
  update(event);
  start = null;
  delete document.body.dataset.dragging;
  if (rectangle.width >= 8 && rectangle.height >= 8) {
    completed = true;
    window.regionPicker.select(rectangle);
  } else {
    rectangle = null;
    draw();
  }
});
addEventListener("pointercancel", () => {
  start = rectangle = null;
  delete document.body.dataset.dragging;
  draw();
});
function stop() {
  if (!completed) {
    completed = true;
    window.regionPicker.cancel();
  }
}
cancel.addEventListener("click", (event) => {
  if (event.isTrusted) stop();
});
addEventListener("keydown", (event) => {
  if (event.isTrusted && event.key === "Escape") stop();
});
addEventListener("contextmenu", (event) => event.preventDefault());
addEventListener("resize", draw);
draw();
