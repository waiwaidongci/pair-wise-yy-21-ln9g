import type {
  Bay,
  Container,
  Placement,
  Port,
  StowageConflict,
  StabilityResult,
  VesselSpec,
} from '../types/shipping';
import { stabilityFromMoments } from './stability';

export interface RecomputeStats {
  /** 参与本次结论的箱位总数 */
  total: number;
  /** 实际重新计算的箱位数 */
  recomputed: number;
  /** 沿用上一次结论的箱位数 */
  reused: number;
}

const ROW_TRANSVERSE_POSITION: Record<number, number> = {
  1: -8.4,
  2: -6.0,
  3: -3.6,
  4: -1.2,
  5: 1.2,
  6: 3.6,
  7: 6.0,
  8: 8.4,
};

interface PlacementContribution {
  signature: string;
  weight: number;
  lcgMoment: number;
  tcgMoment: number;
  vcgMoment: number;
  reefer: boolean;
}

/**
 * 稳性增量计算器：
 * - 箱位/箱重/贝位数据未变的箱直接沿用上一次力矩贡献；
 * - 只有签名变化（移动、换箱、删除、新增）的箱重新推导；
 * - 全船水动力结果恒由当前贡献汇总，保证牵连结论一起刷新。
 */
export class IncrementalStability {
  private cache = new Map<string, PlacementContribution>();
  private lastStats: RecomputeStats = { total: 0, recomputed: 0, reused: 0 };

  calculate(
    placements: Placement[],
    containers: Container[],
    bays: Bay[],
    vessel: VesselSpec,
  ): StabilityResult {
    const containerMap = new Map(containers.map((container) => [container.id, container]));
    const bayMap = new Map(bays.map((bay) => [bay.id, bay]));
    const nextCache = new Map<string, PlacementContribution>();
    let recomputed = 0;
    let reused = 0;

    let loadWeight = 0;
    let longitudinalMoment = 0;
    let transverseMoment = 0;
    let verticalMoment = 0;
    let reeferCount = 0;

    placements.forEach((placement) => {
      const container = containerMap.get(placement.containerId);
      const bay = bayMap.get(placement.bayId);
      if (!container || !bay) return;
      const signature = `${placement.id}|${placement.containerId}|${container.grossWeight}|${container.type}|${placement.bayId}|${placement.row}|${placement.tier}`;
      const cached = this.cache.get(placement.id);
      let contribution: PlacementContribution;
      if (cached && cached.signature === signature) {
        contribution = cached;
        reused += 1;
      } else {
        const vcg =
          4.15 + (placement.tier - 1) * 2.59 + (container.type.startsWith('40') ? 1.3 : 0.62);
        contribution = {
          signature,
          weight: container.grossWeight,
          lcgMoment: container.grossWeight * bay.longitudinalPosition,
          tcgMoment: container.grossWeight * (ROW_TRANSVERSE_POSITION[placement.row] ?? 0),
          vcgMoment: container.grossWeight * vcg,
          reefer: container.reefer,
        };
        recomputed += 1;
      }
      nextCache.set(placement.id, contribution);
      loadWeight += contribution.weight;
      longitudinalMoment += contribution.lcgMoment;
      transverseMoment += contribution.tcgMoment;
      verticalMoment += contribution.vcgMoment;
      if (contribution.reefer) reeferCount += 1;
    });
    this.cache = nextCache;
    this.lastStats = { total: placements.length, recomputed, reused };

    return stabilityFromMoments(vessel, {
      loadWeight,
      longitudinalMoment,
      transverseMoment,
      verticalMoment,
      reeferCount,
      placementCount: placements.length,
    });
  }

  stats(): RecomputeStats {
    return this.lastStats;
  }
}

interface ConflictCacheEntry {
  signature: string;
  conflict: StowageConflict | null;
}

/**
 * 规则增量计算器：
 * - 按栈（贝+排）缓存单箱规则与堆重/港序结论，栈内无箱位变化则整栈沿用；
 * - 危品两两校核仍只覆盖受影响箱所在的配对（结果由当前箱位签名驱动，失效即重算）；
 * - 输入签名包含箱重/港序/危品类等，箱数据一变相关结论立即失效。
 */
export class IncrementalStowageRules {
  private stackCache = new Map<string, ConflictCacheEntry[]>();
  private stackSignature = new Map<string, string>();
  private lastStats: RecomputeStats = { total: 0, recomputed: 0, reused: 0 };

  validate(
    placements: Placement[],
    containers: Container[],
    bays: Bay[],
    ports: Port[],
    stability: StabilityResult,
  ): StowageConflict[] {
    const containerMap = new Map(containers.map((container) => [container.id, container]));
    const bayMap = new Map(bays.map((bay) => [bay.id, bay]));
    const portMap = new Map(ports.map((port) => [port.code, port]));
    const conflicts: StowageConflict[] = [];

    const stacks = new Map<string, Placement[]>();
    placements.forEach((placement) => {
      const key = `${placement.bayId}:${placement.row}`;
      stacks.set(key, [...(stacks.get(key) ?? []), placement]);
    });

    let recomputedBoxes = 0;
    let reusedBoxes = 0;
    const nextStackCache = new Map<string, ConflictCacheEntry[]>();
    const nextStackSignature = new Map<string, string>();

    stacks.forEach((stack, stackKey) => {
      const bay = bayMap.get(stack[0].bayId);
      const signature = stack
        .map((placement) => {
          const container = containerMap.get(placement.containerId);
          return `${placement.id}:${placement.containerId}:${placement.tier}:${
            container ? `${container.grossWeight}:${container.reefer}:${container.hazardClass}:${container.portCode}` : 'x'
          }`;
        })
        .join('|');
      const ordered = [...stack].sort((a, b) => a.tier - b.tier);
      let entries: ConflictCacheEntry[];
      if (this.stackSignature.get(stackKey) === signature && this.stackCache.has(stackKey)) {
        entries = this.stackCache.get(stackKey)!;
        reusedBoxes += stack.length;
      } else {
        entries = evaluateStack(ordered, bay, containerMap, portMap);
        recomputedBoxes += stack.length;
      }
      nextStackCache.set(stackKey, entries);
      nextStackSignature.set(stackKey, signature);
      entries.forEach((entry) => entry.conflict && conflicts.push(entry.conflict));
    });
    this.stackCache = nextStackCache;
    this.stackSignature = nextStackSignature;

    // 危品两两校核：只遍历危品箱（受影响箱签名变化后结论自然重算）
    const dangerous = placements.filter(
      (placement) => (containerMap.get(placement.containerId)?.hazardClass ?? 'none') !== 'none',
    );
    for (let i = 0; i < dangerous.length; i += 1) {
      for (let j = i + 1; j < dangerous.length; j += 1) {
        const first = dangerous[i];
        const second = dangerous[j];
        const firstContainer = containerMap.get(first.containerId);
        const secondContainer = containerMap.get(second.containerId);
        if (!firstContainer || !secondContainer) continue;
        const conflict = evaluateSegregationPair(first, firstContainer, second, secondContainer);
        if (conflict) conflicts.push(conflict);
      }
    }

    if (stability.status === 'danger') {
      const dangerIssue = stability.issues.find((issue) => issue.severity === 'danger');
      if (dangerIssue) {
        conflicts.push({
          id: `stability:${dangerIssue.metric}`,
          type: 'stability',
          severity: 'danger',
          slot: { bayId: bays[0]?.id ?? 0, row: 1, tier: 1 },
          containerIds: [],
          title: `稳性指标异常：${dangerIssue.metric.toUpperCase()}`,
          detail: dangerIssue.message,
          suggestion: '先暂停新增装载，按稳性面板提示调整重量纵向或横向分布。',
        });
      }
    }

    this.lastStats = {
      total: placements.length,
      recomputed: recomputedBoxes,
      reused: reusedBoxes,
    };
    return dedupeConflicts(conflicts);
  }

  stats(): RecomputeStats {
    return this.lastStats;
  }
}

function evaluateStack(
  ordered: Placement[],
  bay: Bay | undefined,
  containerMap: Map<string, Container>,
  portMap: Map<string, Port>,
): ConflictCacheEntry[] {
  const entries: ConflictCacheEntry[] = [];
  if (!bay) return entries;
  let stackWeight = 0;
  ordered.forEach((placement) => {
    const container = containerMap.get(placement.containerId);
    if (container) stackWeight += container.grossWeight;
    entries.push({
      signature: `${placement.id}:${placement.tier}:${container?.grossWeight ?? 0}:${container?.reefer ?? false}`,
      conflict: evaluateSingleBox(placement, container),
    });
  });
  if (stackWeight > bay.maxStackWeight) {
    const top = ordered[ordered.length - 1];
    entries.push({
      signature: `stack:${bay.maxStackWeight}:${stackWeight.toFixed(1)}`,
      conflict: {
        id: `stack:${top.id}`,
        type: 'stack-limit',
        severity: 'danger',
        slot: { bayId: top.bayId, row: top.row, tier: top.tier },
        containerIds: ordered.map((placement) => placement.containerId),
        title: `贝位 ${bay.name} 排 ${top.row} 堆重超限`,
        detail: `该栈实际堆重 ${stackWeight.toFixed(1)} t，超过允许值 ${bay.maxStackWeight} t。`,
        suggestion: `至少卸载 ${(stackWeight - bay.maxStackWeight).toFixed(1)} t 或移至相邻低负荷排。`,
      },
    });
  }
  for (let lowerIndex = 0; lowerIndex < ordered.length - 1; lowerIndex += 1) {
    const lower = ordered[lowerIndex];
    const lowerContainer = containerMap.get(lower.containerId);
    if (!lowerContainer) continue;
    for (let upperIndex = lowerIndex + 1; upperIndex < ordered.length; upperIndex += 1) {
      const upper = ordered[upperIndex];
      const upperContainer = containerMap.get(upper.containerId);
      if (!upperContainer) continue;
      if (lowerContainer.grossWeight < upperContainer.grossWeight) {
        entries.push({
          signature: `top-heavy:${lower.id}:${upper.id}:${lowerContainer.grossWeight}:${upperContainer.grossWeight}`,
          conflict: {
            id: `top-heavy:${lower.id}:${upper.id}`,
            type: 'top-heavy',
            severity: 'warning',
            slot: { bayId: upper.bayId, row: upper.row, tier: upper.tier },
            containerIds: [lowerContainer.id, upperContainer.id],
            title: `贝位 ${bay.name} 第 ${upper.row} 排上重下轻`,
            detail: `${lowerContainer.number}（${lowerContainer.grossWeight.toFixed(1)} t）位于 ${upperContainer.number}（${upperContainer.grossWeight.toFixed(1)} t）下方。`,
            suggestion: '重箱下移、轻箱上移，使重量沿层高递减。',
          },
        });
      }
      const lowerPort = portMap.get(lowerContainer.portCode);
      const upperPort = portMap.get(upperContainer.portCode);
      if (lowerPort && upperPort && lowerPort.sequence < upperPort.sequence) {
        entries.push({
          signature: `port:${lower.id}:${upper.id}:${lowerPort.sequence}:${upperPort.sequence}`,
          conflict: {
            id: `port:${lower.id}:${upper.id}`,
            type: 'wrong-port',
            severity: 'warning',
            slot: { bayId: upper.bayId, row: upper.row, tier: upper.tier },
            containerIds: [lowerContainer.id, upperContainer.id],
            title: `${upperContainer.number} 遮挡先卸港货物`,
            detail: `上层箱卸港为${upperPort.name}，但下层 ${lowerContainer.number} 属于更早的${lowerPort.name}港。`,
            suggestion: '将先卸港重箱置于上层，或调整该栈港序。',
          },
        });
      }
    }
  }
  return entries;
}

function evaluateSingleBox(
  placement: Placement,
  container: Container | undefined,
): StowageConflict | null {
  if (!container) return null;
  if (container.grossWeight > 30.48) {
    return {
      id: `overweight:${placement.id}`,
      type: 'overweight',
      severity: 'danger',
      slot: { bayId: placement.bayId, row: placement.row, tier: placement.tier },
      containerIds: [container.id],
      title: `${container.number} 超过 30.48 t 限重`,
      detail: `贝位 ${placement.bayId} / 排 ${placement.row} / 层 ${placement.tier} 的箱重为 ${container.grossWeight.toFixed(2)} t。`,
      suggestion: '将重箱调至下层或更换轻箱，并复核局部甲板强度。',
    };
  }
  if (container.reefer && placement.tier > 3) {
    return {
      id: `reefer:${placement.id}`,
      type: 'reefer-tier',
      severity: 'warning',
      slot: { bayId: placement.bayId, row: placement.row, tier: placement.tier },
      containerIds: [container.id],
      title: `${container.number} 冷藏箱层位过高`,
      detail: '冷藏箱应布置在具备供电和检修通道的低层格位（1—3 层）。',
      suggestion: '将冷藏箱调整至 1—3 层，并确认插座与检修面可用。',
    };
  }
  return null;
}

const INCOMPATIBLE: Record<string, string[]> = {
  '1.1': ['1.1', '2.1', '3', '4.1', '5.1', '6.1', '8'],
  '2.1': ['1.1', '5.1'],
  '3': ['1.1', '5.1', '8'],
  '4.1': ['1.1', '8'],
  '5.1': ['1.1', '2.1', '3', '6.1'],
  '6.1': ['1.1', '5.1'],
  '8': ['1.1', '3', '4.1'],
};

function evaluateSegregationPair(
  first: Placement,
  firstContainer: Container,
  second: Placement,
  secondContainer: Container,
): StowageConflict | null {
  const horizontalDistance = Math.abs(first.bayId - second.bayId) + Math.abs(first.row - second.row);
  const verticalDistance = Math.abs(first.tier - second.tier);
  const incompatible =
    INCOMPATIBLE[firstContainer.hazardClass]?.includes(secondContainer.hazardClass) ||
    INCOMPATIBLE[secondContainer.hazardClass]?.includes(firstContainer.hazardClass);
  if (incompatible && horizontalDistance <= 2 && verticalDistance <= 2) {
    return {
      id: `segregation:${first.id}:${second.id}`,
      type: 'segregation',
      severity: firstContainer.hazardClass === '1.1' || secondContainer.hazardClass === '1.1' ? 'danger' : 'warning',
      slot: { bayId: second.bayId, row: second.row, tier: second.tier },
      containerIds: [firstContainer.id, secondContainer.id],
      title: `危险品 ${firstContainer.hazardClass} / ${secondContainer.hazardClass} 隔离不足`,
      detail: `${firstContainer.number} 与 ${secondContainer.number} 位于相邻贝排层，不满足简化隔离矩阵要求。`,
      suggestion: '至少错开一个贝位、两排或两层，并复核 IMDG 隔离表。',
    };
  }
  return null;
}

function dedupeConflicts(conflicts: StowageConflict[]): StowageConflict[] {
  const map = new Map<string, StowageConflict>();
  conflicts.forEach((conflict) => {
    const canonical = conflict.id.split(':').sort().join(':');
    if (!map.has(canonical)) map.set(canonical, conflict);
  });
  return [...map.values()];
}
