import type {
  Container,
  Port,
  StowagePlan,
  StabilityResult,
} from '../types/shipping';
import { buildManifestCsv } from './manifestCsv';
import type { ManifestPowerData } from './manifestCsv';

export function downloadPlanPng(canvas: HTMLCanvasElement, plan: StowagePlan): void {
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${plan.name.replaceAll(' ', '_')}_配载图.png`;
  link.click();
}

export function downloadManifest(
  plan: StowagePlan,
  containers: Container[],
  ports: Port[],
  stability: StabilityResult,
  power: ManifestPowerData,
): string {
  const csv = buildManifestCsv(plan, containers, ports, stability, power);
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${plan.name.replaceAll(' ', '_')}_配载清单.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  return csv;
}

export type { ManifestPowerData };
