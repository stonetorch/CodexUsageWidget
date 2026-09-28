export function toolbarPlacement({ composerRect, controlRects, normalWidth, compactWidth = 150, viewportWidth, rowTolerance = 14 }) {
  const controls = controlRects
    .filter((rect) => rect.width > 0 && rect.height > 0 && rect.left < composerRect.right && rect.right > composerRect.left
      && (rect.top + rect.bottom) / 2 >= composerRect.top + (composerRect.bottom - composerRect.top) * 0.45)
    .map((rect) => ({ ...rect, centerY: (rect.top + rect.bottom) / 2 }));
  if (!controls.length) return { ok: false, reason: "no-controls" };
  const bottomY = Math.max(...controls.map((rect) => rect.centerY));
  const row = controls.filter((rect) => Math.abs(rect.centerY - bottomY) <= rowTolerance)
    .sort((a, b) => a.left - b.left);
  const edgeLeft = Math.max(8, composerRect.left + 8);
  const edgeRight = Math.min(viewportWidth - 8, composerRect.right - 8);
  const slots = [];
  let cursor = edgeLeft;
  for (const rect of row) {
    if (rect.left - 8 > cursor) slots.push({ left: cursor, right: rect.left - 8 });
    cursor = Math.max(cursor, rect.right + 8);
  }
  if (edgeRight > cursor) slots.push({ left: cursor, right: edgeRight });
  const usable = slots.filter((slot) => slot.right - slot.left >= compactWidth)
    .sort((a, b) => (b.right - b.left) - (a.right - a.left));
  if (!usable.length) return { ok: false, reason: "insufficient-width" };
  const slot = usable[0];
  const width = Math.min(normalWidth, slot.right - slot.left);
  return {
    ok: true,
    left: slot.left,
    topCenter: bottomY,
    maxWidth: slot.right - slot.left,
    width,
    compact: slot.right - slot.left < normalWidth,
    row,
  };
}

export function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
