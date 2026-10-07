import type { Bay, Container, Placement } from '../types/shipping';
import { baySocketCapacity, findPoweredSlot } from './reeferPower';

export interface AutoStowResult {
  placements: Placement[];
  /** 插口容量不足、自动配载放不下的冷藏箱（交供电引擎排队） */
  unpoweredReeferIds: string[];
}

/**
 * 自动配载：
 * 1. 冷藏箱优先，只能落「有空插口贝位 + 1—3 低层」，集中占用各排低层，
 *    避免被后放入的普货抢占层位而无法接插；
 * 2. 普货随后填充其余格位，自动避开已被冷箱占用的低层排；
 * 3. 放不下的冷箱进入待供电队列。
 */
export function findAutoStowPlacements(
  containers: Container[],
  existingPlacements: Placement[],
  bays: Bay[],
): AutoStowResult {
  const placedIds = new Set(existingPlacements.map((placement) => placement.containerId));
  const occupied = new Set(
    existingPlacements.map((placement) => `${placement.bayId}:${placement.row}:${placement.tier}`),
  );
  const pendingCandidates = containers.filter((container) => !placedIds.has(container.id));
  const reeferCandidates = pendingCandidates
    .filter((container) => container.reefer)
    .sort((a, b) => b.grossWeight - a.grossWeight);
  const normalCandidates = pendingCandidates
    .filter((container) => !container.reefer)
    .sort((a, b) => {
      if (a.hazardClass !== 'none' && b.hazardClass === 'none') return 1;
      return b.grossWeight - a.grossWeight;
    });

  const capacities = new Map<number, number>(bays.map((bay) => [bay.id, baySocketCapacity(bay)]));
  const socketUsage = new Map<number, number>();
  existingPlacements.forEach((placement) => {
    const container = containers.find((candidate) => candidate.id === placement.containerId);
    if (container?.reefer) socketUsage.set(placement.bayId, (socketUsage.get(placement.bayId) ?? 0) + 1);
  });

  const result: Placement[] = [];
  const assigned = [...existingPlacements];
  const unpoweredReeferIds: string[] = [];
  const now = new Date().toISOString();
  let reeferIndex = 0;

  const commit = (container: Container, slot: { bayId: number; row: number; tier: number }, reefer: boolean) => {
    occupied.add(`${slot.bayId}:${slot.row}:${slot.tier}`);
    const placement: Placement = {
      ...slot,
      id: reefer
        ? `AUTO-RF-${reeferIndex}-${container.id}`
        : `AUTO-${Date.now()}-${container.id}`,
      containerId: container.id,
      placedAt: now,
    };
    result.push(placement);
    assigned.push(placement);
    if (reefer) {
      socketUsage.set(slot.bayId, (socketUsage.get(slot.bayId) ?? 0) + 1);
      reeferIndex += 1;
    }
  };

  // 先放冷箱：带供电的低层格位
  for (const container of reeferCandidates) {
    const slot = findPoweredSlot(container, bays, capacities, socketUsage, occupied, assigned);
    if (slot) commit(container, slot, true);
    else unpoweredReeferIds.push(container.id);
  }

  // 再放普货：避开已放冷箱占用的格位（含其上方不允许悬空的位置）
  for (const container of normalCandidates) {
    const slot = findNormalSlot(container, bays, occupied, assigned);
    if (slot) commit(container, slot, false);
  }

  return { placements: result, unpoweredReeferIds };
}

function findNormalSlot(
  container: Container,
  bays: Bay[],
  occupied: Set<string>,
  assigned: Placement[],
): { bayId: number; row: number; tier: number } | null {
  const preferredBays = [...bays].sort((a, b) => {
    const aBias =
      Math.abs(a.longitudinalPosition) * 0.01 +
      (container.grossWeight > 22 ? Math.abs(a.longitudinalPosition) * 0.004 : 0);
    const bBias =
      Math.abs(b.longitudinalPosition) * 0.01 +
      (container.grossWeight > 22 ? Math.abs(b.longitudinalPosition) * 0.004 : 0);
    return aBias - bBias;
  });
  for (const bay of preferredBays) {
    for (let tier = 1; tier <= bay.tiers; tier += 1) {
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
