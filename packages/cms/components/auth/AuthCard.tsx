"use client";

import type { ReactNode } from "react";
import { useApi } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { data } = useApi<{ logoUrl: string }>(apiPath("/auth-config"));
  return (
    <div className="cms-auth-page">
      <div className="cms-auth-panel">
        <div className="cms-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- an administrator's path, whose size next/image can't know */}
          {data?.logoUrl && <img src={data.logoUrl} alt="" className="cms-auth-logo" />}
          <h1 className="cms-auth-title">{title}</h1>
          {subtitle && <p className="cms-mt-2 cms-text-sm cms-soft">{subtitle}</p>}
        </div>
        <div className="cms-panel cms-p-6 cms-stack-4">{children}</div>
      </div>
    </div>
  );
}
