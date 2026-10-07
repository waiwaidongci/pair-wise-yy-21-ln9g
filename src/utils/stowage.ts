import type { Bay, Container, Placement } from '../types/shipping';
import { REEFER_LOW_TIER_MAX } from './reeferPower';

export function findAutoStowPlacements(
  containers: Container[],
  existingPlacements: Placement[],
  bays: Bay[],
): Placement[] {
  const placedIds = new Set(existingPlacements.map((placement) => placement.containerId));
  const occupied = new Set(
    existingPlacements.map((placement) => `${placement.bayId}:${placement.row}:${placement.tier}`),
  );
  // 每个贝位当前低层冷藏箱占用数（决定是否还有可用插口）
  const reeferCountByBay = new Map<number, number>();
  const containerMap = new Map(containers.map((container) => [container.id, container]));
  for (const placement of existingPlacements) {
    const container = containerMap.get(placement.containerId);
    if (container?.reefer && placement.tier <= REEFER_LOW_TIER_MAX) {
      reeferCountByBay.set(placement.bayId, (reeferCountByBay.get(placement.bayId) ?? 0) + 1);
    }
  }
  const candidates = containers
    .filter((container) => !placedIds.has(container.id))
    .sort((a, b) => {
      if (a.reefer !== b.reefer) return a.reefer ? -1 : 1;
      if (a.hazardClass !== 'none' && b.hazardClass === 'none') return 1;
      return b.grossWeight - a.grossWeight;
    });
  const result: Placement[] = [];
  for (const container of candidates) {
    const slot = findSlot(container, bays, occupied, result, reeferCountByBay);
    if (!slot) continue;
    occupied.add(`${slot.bayId}:${slot.row}:${slot.tier}`);
    if (container.reefer && slot.tier <= REEFER_LOW_TIER_MAX) {
      reeferCountByBay.set(slot.bayId, (reeferCountByBay.get(slot.bayId) ?? 0) + 1);
    }
    result.push({
      ...slot,
      id: `AUTO-${Date.now()}-${container.id}`,
      containerId: container.id,
      placedAt: new Date().toISOString(),
    });
  }
  return result;
}

function findSlot(
  container: Container,
  bays: Bay[],
  occupied: Set<string>,
  assigned: Placement[],
  reeferCountByBay: Map<number, number>,
): { bayId: number; row: number; tier: number } | null {
  const availableSockets = (bay: Bay): number =>
    Math.max(0, bay.powerSockets - bay.powerSocketsOutOfService);
  const preferredBays = [...bays].sort((a, b) => {
    const aBias = Math.abs(a.longitudinalPosition) * 0.01 + (container.grossWeight > 22 ? Math.abs(a.longitudinalPosition) * 0.004 : 0);
    const bBias = Math.abs(b.longitudinalPosition) * 0.01 + (container.grossWeight > 22 ? Math.abs(b.longitudinalPosition) * 0.004 : 0);
    // 冷藏箱优先选还有可用插口的贝位，避免塞进后供不上电
    if (container.reefer) {
      const aFree = availableSockets(a) - (reeferCountByBay.get(a.id) ?? 0);
      const bFree = availableSockets(b) - (reeferCountByBay.get(b.id) ?? 0);
      if (aFree > 0 !== bFree > 0) return aFree > 0 ? -1 : 1;
    }
    return aBias - bBias;
  });
  const tiers = container.reefer ? [1, 2, 3] : [1, 2, 3, 4, 5, 6];
  for (const bay of preferredBays) {
    for (const tier of tiers) {
      for (let row = 1; row <= bay.rows; row += 1) {
        const key = `${bay.id}:${row}:${tier}`;
        if (occupied.has(key)) continue;
        if (tier > 1 && !occupied.has(`${bay.id}:${row}:${tier - 1}`)) continue;
        if (!isRuleCompatible(container, bay.id, row, tier, assigned)) continue;
        return { bayId: bay.id, row, tier };
      }
    }
  }
  return null;
}

function isRuleCompatible(
  container: Container,
  bayId: number,
  row: number,
  tier: number,
  assigned: Placement[],
): boolean {
  if (container.hazardClass === 'none') return true;
  return !assigned.some((placement) => {
    if (Math.abs(placement.bayId - bayId) + Math.abs(placement.row - row) > 3) return false;
    return Math.abs(placement.tier - tier) <= 2;
  });
}
