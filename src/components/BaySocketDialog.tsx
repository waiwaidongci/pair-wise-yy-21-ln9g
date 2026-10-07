import { Button, Dialog, FormGroup, InputGroup, Intent } from '@blueprintjs/core';
import { useEffect, useState } from 'react';
import type { Bay } from '../types/shipping';

interface BaySocketDialogProps {
  open: boolean;
  bay: Bay | null;
  onClose: () => void;
  onSave: (bayId: number, powerSockets: number, powerSocketsOutOfService: number) => void;
}

export function BaySocketDialog({ open, bay, onClose, onSave }: BaySocketDialogProps) {
  const [total, setTotal] = useState(0);
  const [oos, setOos] = useState(0);

  useEffect(() => {
    if (bay) {
      setTotal(bay.powerSockets);
      setOos(bay.powerSocketsOutOfService);
    }
  }, [bay]);

  if (!bay) return null;

  const available = Math.max(0, total - Math.min(oos, total));
  const overLimit = oos > total;

  return (
    <Dialog
      isOpen={open}
      onClose={onClose}
      title={`贝位 ${bay.name} · 供电插口设置`}
      icon="power"
      className="socket-dialog"
    >
      <div className="dialog-body">
        <p className="socket-dialog__hint">
          登记该贝位的供电插口总数与检修停用数。冷藏箱落在低层格位（1—3 层）且有可用插口才能接电；
          插口不足时按卸货港先后排队。
        </p>
        <div className="socket-dialog__grid">
          <FormGroup label="插口总数" labelFor="socket-total">
            <InputGroup
              id="socket-total"
              type="number"
              min={0}
              max={20}
              value={String(total)}
              onValueChange={(value) => setTotal(Math.max(0, Math.floor(Number(value) || 0)))}
            />
          </FormGroup>
          <FormGroup label="检修停用数" labelFor="socket-oos">
            <InputGroup
              id="socket-oos"
              type="number"
              min={0}
              max={total}
              intent={overLimit ? Intent.DANGER : Intent.NONE}
              value={String(oos)}
              onValueChange={(value) => setOos(Math.max(0, Math.floor(Number(value) || 0)))}
            />
          </FormGroup>
        </div>
        <div className="socket-dialog__summary">
          <span>
            可用插口 <strong>{available}</strong> / {total}
          </span>
          {overLimit && <span className="socket-dialog__warn">检修停用数不能超过插口总数</span>}
        </div>
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose}>取消</Button>
        <Button
          intent="primary"
          icon="tick"
          disabled={overLimit}
          onClick={() => onSave(bay.id, total, oos)}
        >
          保存并重算供电
        </Button>
      </div>
    </Dialog>
  );
}
