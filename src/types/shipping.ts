export type ContainerType = '20GP' | '40GP' | '40HQ' | '20RF';
export type HazardClass = 'none' | '1.1' | '2.1' | '3' | '4.1' | '5.1' | '6.1' | '8';
export type PlanStatus = 'trial' | 'final';

export interface Port {
  code: string;
  name: string;
  country: string;
  sequence: number;
  color: string;
}

export interface Container {
  id: string;
  number: string;
  type: ContainerType;
  grossWeight: number;
  tareWeight: number;
  payload: number;
  portCode: string;
  hazardClass: HazardClass;
  unNumber?: string;
  reefer: boolean;
  cargo: string;
}

export interface Bay {
  id: number;
  name: string;
  longitudinalPosition: number;
  rows: number;
  tiers: number;
  maxStackWeight: number;
  /** 贝位冷藏箱供电插口总数 */
  reeferSocketTotal: number;
  /** 检修停用的插口数量 */
  reeferSocketOutage: number;
}

/** 待供电队列中的冷藏箱：插口腾退后按卸货港顺序自动补位 */
export interface PendingReefer {
  containerId: string;
  /** 单调递增的入队序号，同时作为同港序时的决胜依据 */
  enqueuedAt: number;
}

export interface Slot {
  bayId: number;
  row: number;
  tier: number;
}

export interface Placement extends Slot {
  id: string;
  containerId: string;
  placedAt: string;
}

export interface StowagePlan {
  id: string;
  name: string;
  status: PlanStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
  placements: Placement[];
  /** 等待可用供电插口的冷藏箱队列（已按卸货港/入队序排好） */
  pendingReefers: PendingReefer[];
}

export interface VesselSpec {
  name: string;
  imo: string;
  voyage: string;
  flag: string;
  lengthOverall: number;
  breadth: number;
  lightshipWeight: number;
  lightshipLcg: number;
  lightshipVcg: number;
  maxDraft: number;
  minDraft: number;
  maxTrim: number;
  maxHeel: number;
  minGm: number;
  hydrostaticTable: HydrostaticRow[];
}

export interface HydrostaticRow {
  draft: number;
  displacement: number;
  km: number;
  lcb: number;
  mct: number;
}

export interface StabilityResult {
  displacement: number;
  loadWeight: number;
  meanDraft: number;
  draftFore: number;
  draftAft: number;
  trim: number;
  heel: number;
  gm: number;
  kg: number;
  lcg: number;
  tcg: number;
  vcg: number;
  lcb: number;
  status: 'stable' | 'warning' | 'danger';
  issues: StabilityIssue[];
}

export interface StabilityIssue {
  metric: 'draft' | 'trim' | 'heel' | 'gm';
  severity: 'warning' | 'danger';
  message: string;
}

export type StowageConflictType =
  | 'overweight'
  | 'wrong-port'
  | 'top-heavy'
  | 'segregation'
  | 'stack-limit'
  | 'stability'
  | 'reefer-power'
  | 'reefer-tier';

export interface StowageConflict {
  id: string;
  type: StowageConflictType;
  severity: 'warning' | 'danger';
  slot: Slot;
  containerIds: string[];
  title: string;
  detail: string;
  suggestion: string;
}

export interface PlannerState {
  vessel: VesselSpec;
  ports: Port[];
  bays: Bay[];
  containers: Container[];
  plans: StowagePlan[];
  activePlanId: string;
  selectedContainerId: string | null;
  selectedSlot: Slot | null;
  highlightedConflictId: string | null;
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  notice: string | null;
}

/** 撤销/重做快照：方案与贝位插口状态一起回滚 */
export interface HistorySnapshot {
  plans: StowagePlan[];
  bays: Bay[];
}
