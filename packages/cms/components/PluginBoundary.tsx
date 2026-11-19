"use client";

import { Component, type ReactNode } from "react";
import { useT } from "./i18n";

interface State { failed: boolean }

/** Redirects and not-found are how Next.js navigates. They aren't failures, and have to keep going up. */
const isNavigation = (error: unknown) => /^NEXT_(REDIRECT|HTTP_ERROR_FALLBACK|NOT_FOUND)/.test(String((error as { digest?: unknown } | null)?.digest ?? ""));

function Failed({ plugin }: { plugin: string }) {
  const { t } = useT();
  return <span className="cms-hint" role="alert">{t("pluginErrors.couldntShow", { plugin })}</span>;
}

/** Around everything a plugin renders, so a broken plugin costs its own slot and not the page. */
export class PluginBoundary extends Component<{ plugin: string; children: ReactNode; /** Shown instead of the usual notice when the plugin fails. */ fallback?: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State {
    if (isNavigation(error)) throw error;
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[plugin:${this.props.plugin}]`, error);
  }

  render() {
    if (this.state.failed && this.props.fallback !== undefined) return this.props.fallback;
    return this.state.failed ? <Failed plugin={this.props.plugin} /> : this.props.children;
  }
}

/** Runs a plugin's button. A failure is reported, with words from `pluginErrors.couldntFinish`, and never escapes into the page. */
export async function runPluginAction(plugin: string, work: () => void | Promise<void>, onFail: () => void) {
  try {
    await work();
  } catch (error) {
    console.error(`[plugin:${plugin}]`, error);
    onFail();
  }
}
