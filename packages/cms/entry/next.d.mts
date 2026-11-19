import type { NextConfig } from "next";

export interface CmsRoutes { admin?: string; api?: string }
export function resolveRoutes(routes?: CmsRoutes): Required<CmsRoutes>;
export function withCms(nextConfig?: NextConfig, options?: { routes?: CmsRoutes; cwd?: string }): NextConfig;
