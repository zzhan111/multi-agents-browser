/**
 * Automatic healing for generated news packages. When a `site_run` of a
 * generated adapter fails, the daemon re-probes the package (same zero-token
 * heal as `site heal`) and, if it was regenerated, retries the run once.
 *
 * Loop guards: one heal per package at a time (concurrent failures share it),
 * and a cooldown after every attempt so a site that stays broken is not
 * re-probed on each run.
 */

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { LOCAL_SITES_DIR, healNewsPackage, readNewsManifest, type Fetcher, type HealResult, type SiteAdapter } from "@ma-browser/shared";

export const AUTOHEAL_COOLDOWN_MS = 60_000;

export interface AutoHealer {
  /** Base URL of the generated package an adapter belongs to, if any. */
  generatedBase(adapter: SiteAdapter): string | undefined;
  /**
   * Heal the adapter's package; undefined when it is not generated or is
   * cooling down. `fetcher` (the browser session) is used by the run that
   * starts the heal; concurrent callers share that run.
   */
  heal(adapter: SiteAdapter, fetcher?: Fetcher): Promise<HealResult | undefined>;
}

export function createAutoHealer(opts: {
  sitesDir?: string;
  heal?: typeof healNewsPackage;
  now?: () => number;
  cooldownMs?: number;
} = {}): AutoHealer {
  const sitesDir = opts.sitesDir ?? LOCAL_SITES_DIR;
  const heal = opts.heal ?? healNewsPackage;
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? AUTOHEAL_COOLDOWN_MS;
  const inFlight = new Map<string, Promise<HealResult>>();
  const lastAttempt = new Map<string, number>();

  /** `<sitesDir>/<pkg>/<command>.js` with `<sitesDir>/<pkg>/_package.json` → pkg. */
  const packageOf = (adapter: SiteAdapter): string | undefined => {
    if (adapter.source !== "local") return undefined;
    const parts = relative(sitesDir, adapter.filePath).split(sep);
    if (parts.length !== 2 || parts[0] === ".." || !existsSync(join(sitesDir, parts[0], "_package.json"))) return undefined;
    return parts[0];
  };

  return {
    generatedBase(adapter) {
      const pkg = packageOf(adapter);
      try { return pkg ? readNewsManifest(sitesDir, pkg)?.base : undefined; } catch { return undefined; }
    },
    async heal(adapter, fetcher) {
      const pkg = packageOf(adapter);
      if (!pkg) return undefined;
      const running = inFlight.get(pkg);
      if (running) return running;
      const last = lastAttempt.get(pkg);
      if (last !== undefined && now() - last < cooldownMs) return undefined;
      lastAttempt.set(pkg, now());
      const attempt = heal({ name: pkg, sitesDir, fetcher })
        .catch((e): HealResult => ({ status: "broken", reason: e instanceof Error ? e.message : String(e) }))
        .finally(() => inFlight.delete(pkg));
      inFlight.set(pkg, attempt);
      return attempt;
    },
  };
}
