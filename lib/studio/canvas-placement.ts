type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };

/** Place a new card near the viewport anchor without covering existing cards. */
export function placeCanvasCard(anchor: Point, occupied: Bounds[], size = { width: 264, height: 440 }): Point {
  const gap = 32;
  const free = (point: Point) => occupied.every(rect =>
    point.x + size.width + gap <= rect.x || rect.x + rect.width + gap <= point.x ||
    point.y + size.height + gap <= rect.y || rect.y + rect.height + gap <= point.y);
  if (free(anchor)) return anchor;
  // Search nearby rows/columns first; unusually large cards use the safe fallback below.
  const limit = Math.ceil(Math.sqrt(occupied.length + 1)) + 1;
  for (let radius = 1; radius <= limit; radius++) {
    const candidates: Point[] = [];
    for (let offset = -radius; offset <= radius; offset++) {
      candidates.push({ x: radius, y: offset }, { x: -radius, y: offset });
      if (Math.abs(offset) !== radius) candidates.push({ x: offset, y: radius }, { x: offset, y: -radius });
    }
    candidates.sort((a, b) => a.x ** 2 + a.y ** 2 - b.x ** 2 - b.y ** 2);
    for (const cell of candidates) {
      const point = { x: anchor.x + cell.x * (size.width + gap), y: anchor.y + cell.y * (size.height + gap) };
      if (free(point)) return point;
    }
  }
  return { x: Math.max(anchor.x, ...occupied.map(rect => rect.x + rect.width + gap)), y: anchor.y };
}
