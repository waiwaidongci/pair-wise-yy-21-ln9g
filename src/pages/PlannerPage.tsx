import {
  Button,
  Dialog,
  Divider,
  EditableText,
  Intent,
  Tag,
  Tooltip,
} from '@blueprintjs/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BayCanvas } from '../components/BayCanvas';
import type { BayCanvasHandle } from '../components/BayCanvas';
import { CargoPool } from '../components/CargoPool';
import { ConflictList } from '../components/ConflictList';
import { StabilityDashboard } from '../components/StabilityDashboard';
import { ReeferPowerPanel, gateMessage } from '../components/ReeferPowerPanel';
import { SaveIndicator } from '../components/SaveIndicator';
import { plannerActions } from '../stores/plannerSlice';
import { useAppDispatch, useAppSelector } from '../stores/hooks';
import type { Placement, Slot, StowageConflict } from '../types/shipping';
import { downloadManifest } from '../utils/exporters';
import { findAutoStowPlacements } from '../utils/stowage';
import { IncrementalStability, IncrementalStowageRules } from '../utils/incremental';

export function PlannerPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const planner = useAppSelector((state) => state.planner);
  const canvasRef = useRef<BayCanvasHandle>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 放行对话框打开时生成的操作号：重复点击确认只提交一次 */
  const confirmOpId = useRef<string | null>(null);
  const activePlan = planner.plans.find((plan) => plan.id === planner.activePlanId) ?? planner.plans[0];

  const stabilityCalc = useRef(new IncrementalStability());
  const rulesCalc = useRef(new IncrementalStowageRules());
  // 切换方案后缓存按方案隔离
  const cachedPlanId = useRef<string | null>(null);

  const stability = useMemo(() => {
    if (!activePlan) return null;
    if (cachedPlanId.current !== activePlan.id) {
      stabilityCalc.current = new IncrementalStability();
      rulesCalc.current = new IncrementalStowageRules();
      cachedPlanId.current = activePlan.id;
    }
    return stabilityCalc.current.calculate(
      activePlan.placements,
      planner.containers,
      planner.bays,
      planner.vessel,
    );
  }, [activePlan, planner.containers, planner.bays, planner.vessel]);

  const conflicts = useMemo(() => {
    if (!activePlan || !stability) return [];
    return rulesCalc.current.validate(
      activePlan.placements,
      planner.containers,
      planner.bays,
      planner.ports,
      stability,
    );
  }, [activePlan, planner.containers, planner.bays, planner.ports, stability]);

  const stabilityStats = stabilityCalc.current.stats();
  const rulesStats = rulesCalc.current.stats();

  const selectedPlacement = useMemo(() => {
    if (!activePlan || !planner.selectedContainerId) return null;
    return activePlan.placements.find((placement) => placement.containerId === planner.selectedContainerId) ?? null;
  }, [activePlan, planner.selectedContainerId]);
  const unplacedCount = activePlan
    ? planner.containers.length - activePlan.placements.length - activePlan.pendingReefers.length
    : planner.containers.length;
  const pendingCount = activePlan?.pendingReefers.length ?? 0;
  const blockedByPower = pendingCount > 0;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, [contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) dispatch(plannerActions.redo());
        else dispatch(plannerActions.undo());
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPlacement) {
        dispatch(plannerActions.removePlacement(selectedPlacement.id));
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch, selectedPlacement]);

  if (!activePlan || !stability) {
    return <div className="page-loading">正在读取配载方案…</div>;
  }

  function assignContainer(containerId: string, slot: Slot) {
    dispatch(plannerActions.assignContainer({ containerId, slot }));
  }

  function selectPlacement(placement: Placement) {
    dispatch(plannerActions.selectContainer(placement.containerId));
    dispatch(
      plannerActions.selectSlot({
        bayId: placement.bayId,
        row: placement.row,
        tier: placement.tier,
      }),
    );
  }

  function handleAutoStow() {
    const result = findAutoStowPlacements(
      planner.containers,
      activePlan.placements,
      planner.bays,
    );
    dispatch(
      plannerActions.autoStow({
        placements: result.placements,
        unpoweredReeferIds: result.unpoweredReeferIds,
      }),
    );
  }

  function focusConflict(conflict: StowageConflict) {
    dispatch(plannerActions.setHighlightedConflict(conflict.id));
    if (conflict.containerIds[0]) {
      dispatch(plannerActions.selectContainer(conflict.containerIds[0]));
    }
    dispatch(plannerActions.selectSlot(conflict.slot));
  }

  function focusPending(containerId: string) {
    dispatch(plannerActions.selectContainer(containerId));
    const firstBay = planner.bays[0];
    if (firstBay) dispatch(plannerActions.selectSlot({ bayId: firstBay.id, row: 1, tier: 1 }));
    dispatch(plannerActions.setNotice('该冷箱在待供电队列中，插口腾退时会自动补进低层格位'));
  }

  function exportManifest() {
    downloadManifest(activePlan, planner.containers, planner.ports, stability!, {
      bays: planner.bays,
      pendingReefers: activePlan.pendingReefers,
    });
  }

  function openConfirm() {
    if (blockedByPower) return;
    // 操作号在打开对话框时生成，确认动作重复提交只认一次
    confirmOpId.current = `CONFIRM-${activePlan.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setConfirmOpen(true);
  }

  const conflictIntent: Intent =
    conflicts.some((conflict) => conflict.severity === 'danger')
      ? 'danger'
      : conflicts.length
        ? 'warning'
        : 'success';

  const incrementalHint =
    stabilityStats.total > 0
      ? `增量重算：稳性沿用 ${stabilityStats.reused} 箱、重算 ${stabilityStats.recomputed} 箱；规则沿用 ${rulesStats.reused} 箱、重算 ${rulesStats.recomputed} 箱`
      : '';

  return (
    <div className="planner-page">
      <div className="planner-toolbar">
        <div className="vessel-summary">
          <span className="eyebrow">当前船舶 / 航次</span>
          <strong>
            {planner.vessel.name}
            <small>{planner.vessel.voyage}</small>
          </strong>
          <span>
            {planner.vessel.lengthOverall.toFixed(1)} m · {planner.vessel.breadth.toFixed(1)} m · {planner.vessel.imo}
          </span>
        </div>
        <div className="toolbar-stat">
          <small>已配箱</small>
          <strong>{activePlan.placements.length}</strong>
          <span>/ {planner.containers.length}</span>
        </div>
        <div className="toolbar-stat">
          <small>待供电</small>
          <strong className={blockedByPower ? 'text-danger' : ''}>{pendingCount}</strong>
        </div>
        <div className="toolbar-stat">
          <small>未配箱</small>
          <strong>{unplacedCount}</strong>
        </div>
        <div className="toolbar-stat">
          <small>异常项</small>
          <strong className={conflictIntent === 'danger' ? 'text-danger' : ''}>{conflicts.length}</strong>
        </div>
        <div className="toolbar-spacer" />
        <Tooltip content="撤销上一步（⌘Z）" compact>
          <Button
            icon="undo"
            minimal
            disabled={planner.past.length === 0}
            onClick={() => dispatch(plannerActions.undo())}
          />
        </Tooltip>
        <Tooltip content="重做（⇧⌘Z）" compact>
          <Button
            icon="redo"
            minimal
            disabled={planner.future.length === 0}
            onClick={() => dispatch(plannerActions.redo())}
          />
        </Tooltip>
        <Divider />
        <Button icon="automatic-updates" onClick={handleAutoStow}>
          自动配载
        </Button>
        <Button
          icon="duplicate"
          outlined
          onClick={() => dispatch(plannerActions.duplicatePlan(activePlan.id))}
        >
          新建试算
        </Button>
        <Button icon="comparison" outlined onClick={() => navigate('/compare')}>
          方案对比
        </Button>
      </div>

      <div className="plan-tabs">
        <span className="plan-tabs__label">配载方案</span>
        {planner.plans.map((plan) => (
          <button
            key={plan.id}
            type="button"
            className={`plan-tab ${plan.id === planner.activePlanId ? 'is-active' : ''}`}
            onClick={() => dispatch(plannerActions.setActivePlan(plan.id))}
          >
            <span>
              <strong>{plan.name}</strong>
              <small>
                {plan.placements.length} 箱
                {plan.pendingReefers.length > 0 && (
                  <em className="plan-tab__pending"> · 待供电 {plan.pendingReefers.length}</em>
                )}
              </small>
            </span>
            <Tag minimal intent={plan.status === 'final' ? 'success' : 'none'}>
              {plan.status === 'final' ? '最终' : '试算'}
            </Tag>
          </button>
        ))}
        <div className="plan-tabs__spacer" />
        <SaveIndicator />
      </div>

      <main className="planner-workspace">
        <CargoPool
          containers={planner.containers}
          placements={activePlan.placements}
          ports={planner.ports}
          selectedContainerId={planner.selectedContainerId}
          pendingReeferIds={activePlan.pendingReefers.map((item) => item.containerId)}
          onSelect={(containerId) => dispatch(plannerActions.selectContainer(containerId))}
          onAutoStow={handleAutoStow}
        />

        <section className="panel bay-panel">
          <header className="panel-heading bay-panel__heading">
            <div>
              <span className="eyebrow">Canvas 贝位图</span>
              <h2>货物格位分配</h2>
            </div>
            <div className="bay-actions">
              <EditableText
                value={activePlan.name}
                onChange={(name) => dispatch(plannerActions.renamePlan({ planId: activePlan.id, name }))}
                selectAllOnFocus
              />
              <Button
                icon="trash"
                minimal
                intent="danger"
                onClick={() => dispatch(plannerActions.clearPlan())}
              >
                清空
              </Button>
            </div>
          </header>
          <div className="bay-instructions">
            <span>
              <i className="legend-box legend-box--selected" />
              当前选择
            </span>
            <span>
              <i className="legend-box legend-box--danger" />
              严重异常
            </span>
            <span>
              <i className="legend-box legend-box--warning" />
              规则提醒
            </span>
            <span>
              <i className="legend-box legend-box--power" />
              冷箱已接插供电
            </span>
            <span>
              拖动左侧集装箱到格位，或先选箱再点击空格位
            </span>
          </div>
          <BayCanvas
            ref={canvasRef}
            bays={planner.bays}
            placements={activePlan.placements}
            containers={planner.containers}
            ports={planner.ports}
            conflicts={conflicts}
            selectedContainerId={planner.selectedContainerId}
            selectedSlot={planner.selectedSlot}
            highlightedConflictId={planner.highlightedConflictId}
            onSlotAssigned={assignContainer}
            onSlotSelected={(slot) => dispatch(plannerActions.selectSlot(slot))}
            onPlacementSelected={selectPlacement}
            onPlacementRemoved={(placementId) => dispatch(plannerActions.removePlacement(placementId))}
          />
          <footer className="bay-footer">
            <div className="bay-footer__selection">
              <strong>当前格位</strong>
              <span>
                {planner.selectedSlot
                  ? `贝 ${planner.selectedSlot.bayId} / ${String(planner.selectedSlot.row).padStart(2, '0')} 排 / ${planner.selectedSlot.tier} 层`
                  : '未选择'}
              </span>
            </div>
            <div className="bay-footer__notice">
              <span className={`notice-dot notice-dot--${stability.status}`} />
              <Tooltip content={incrementalHint} compact disabled={!incrementalHint}>
                <span>{planner.notice ?? '所有调整都会立即重算稳性、隔离、插口占用与排队规则'}</span>
              </Tooltip>
            </div>
            <div className="bay-export-actions">
              <Tooltip
                content={gateMessage(pendingCount) ?? '导出当前配载图 PNG'}
                compact
                disabled={!blockedByPower}
              >
                <Button
                  icon="media"
                  disabled={blockedByPower}
                  onClick={() => canvasRef.current?.downloadPng()}
                >
                  导出配载图
                </Button>
              </Tooltip>
              <Button icon="th" onClick={exportManifest}>
                导出配载清单
              </Button>
              <Tooltip
                content={gateMessage(pendingCount) ?? '待供电队列清空后可定为最终方案'}
                compact
                disabled={!blockedByPower}
              >
                <Button
                  intent="primary"
                  icon="endorsed"
                  disabled={blockedByPower}
                  onClick={openConfirm}
                >
                  定为最终方案
                </Button>
              </Tooltip>
            </div>
          </footer>
        </section>

        <section className="planner-right">
          <ReeferPowerPanel
            bays={planner.bays}
            containers={planner.containers}
            ports={planner.ports}
            placements={activePlan.placements}
            pendingReefers={activePlan.pendingReefers}
            onBaySocketsChange={(payload) => dispatch(plannerActions.setBaySockets(payload))}
            onPendingClick={focusPending}
          />
          <StabilityDashboard stability={stability} />
          <ConflictList
            conflicts={conflicts}
            containers={planner.containers}
            highlightedConflictId={planner.highlightedConflictId}
            onSelectConflict={focusConflict}
          />
        </section>
      </main>

      <Dialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认最终配载方案"
        icon="endorsed"
        className="confirm-dialog"
      >
        <div className="dialog-body">
          <p>
            将把 <strong>{activePlan.name}</strong> 标记为最终方案。当前共配载
            <strong> {activePlan.placements.length} </strong>个集装箱，剩余{unplacedCount}个未配箱。
          </p>
          <div className="dialog-summary">
            <div>
              <span>平均吃水</span>
              <strong>{stability.meanDraft.toFixed(3)} m</strong>
            </div>
            <div>
              <span>横倾 / 纵倾</span>
              <strong>
                {stability.heel.toFixed(2)}° / {stability.trim.toFixed(2)} m
              </strong>
            </div>
            <div>
              <span>GM</span>
              <strong>{stability.gm.toFixed(3)} m</strong>
            </div>
            <div>
              <span>严重异常</span>
              <strong>{conflicts.filter((conflict) => conflict.severity === 'danger').length} 项</strong>
            </div>
          </div>
          {conflicts.some((conflict) => conflict.severity === 'danger') && (
            <div className="dialog-warning">
              当前仍存在严重配载异常。确认后会保留异常记录供后续审核，请确认已获配载主管授权。
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <Button onClick={() => setConfirmOpen(false)}>返回调整</Button>
          <Button
            intent="primary"
            icon="tick"
            onClick={() => {
              if (confirmOpId.current) {
                dispatch(
                  plannerActions.confirmPlan({
                    planId: activePlan.id,
                    opId: confirmOpId.current,
                  }),
                );
              }
              confirmOpId.current = null;
              setConfirmOpen(false);
            }}
          >
            确认最终方案
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
