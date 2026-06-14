import type { EdgeRoute } from "./types";

export interface CanvasPoint {
  x: number;
  y: number;
}

export function createConnectorPath(from: CanvasPoint, to: CanvasPoint, route: EdgeRoute = "curve", waypoints: CanvasPoint[] = []): string {
  const points = [from, ...waypoints, to];
  if (waypoints.length > 0) return createWaypointPath(points, route);
  if (route === "straight") return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  if (route === "elbow") {
    const midX = (from.x + to.x) / 2;
    return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sign = Math.sign(dx || 1);
    const curve = Math.max(42, Math.min(180, Math.abs(dx) * 0.52));
    return `M ${from.x} ${from.y} C ${from.x + sign * curve} ${from.y}, ${to.x - sign * curve} ${to.y}, ${to.x} ${to.y}`;
  }

  const sign = Math.sign(dy || 1);
  const curve = Math.max(42, Math.min(180, Math.abs(dy) * 0.52));
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + sign * curve}, ${to.x} ${to.y - sign * curve}, ${to.x} ${to.y}`;
}

export function getConnectorLabelPoint(from: CanvasPoint, to: CanvasPoint, waypoints: CanvasPoint[] = [], offsetX = 0, offsetY = 0): CanvasPoint {
  const midpoint = getPolylineMiddlePoint([from, ...waypoints, to]);
  return { x: midpoint.x + offsetX, y: midpoint.y - 8 + offsetY };
}

export function getPolylineMiddlePoint(points: CanvasPoint[]): CanvasPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0] ?? { x: 0, y: 0 };

  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) continue;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    lengths.push(length);
    total += length;
  }

  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index] ?? 0;
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) continue;
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = length === 0 ? 0 : remaining / length;
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    }
    remaining -= length;
  }

  return points[Math.floor(points.length / 2)] ?? points[0] ?? { x: 0, y: 0 };
}

function createWaypointPath(points: CanvasPoint[], route: EdgeRoute): string {
  const [first, ...rest] = points;
  if (!first) return "";
  if (route === "curve" && points.length > 2) {
    const commands = [`M ${first.x} ${first.y}`];
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const point = points[index];
      if (!previous || !point) continue;
      const midX = (previous.x + point.x) / 2;
      const midY = (previous.y + point.y) / 2;
      commands.push(`Q ${previous.x} ${previous.y} ${midX} ${midY}`);
      if (index === points.length - 1) commands.push(`T ${point.x} ${point.y}`);
    }
    return commands.join(" ");
  }
  return [`M ${first.x} ${first.y}`, ...rest.map((point) => `L ${point.x} ${point.y}`)].join(" ");
}