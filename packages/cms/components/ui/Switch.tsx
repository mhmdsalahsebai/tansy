import { Switch as HeadlessSwitch } from "@headlessui/react";
import { cn } from "../../lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
}

export function Switch({ checked, onChange, label, description }: SwitchProps) {
  return (
    <HeadlessSwitch.Group>
      <div className="cms-row cms-gap-3">
        <HeadlessSwitch
          checked={checked}
          onChange={onChange}
          className={cn("cms-switch", checked && "cms-switch-on")}
        >
          <span className="cms-switch-thumb" />
        </HeadlessSwitch>
        {(label || description) && (
          <div className="cms-flex cms-col">
            {label && (
              <HeadlessSwitch.Label className="cms-label">
                {label}
              </HeadlessSwitch.Label>
            )}
            {description && (
              <HeadlessSwitch.Description className="cms-hint">
                {description}
              </HeadlessSwitch.Description>
            )}
          </div>
        )}
      </div>
    </HeadlessSwitch.Group>
  );
}
