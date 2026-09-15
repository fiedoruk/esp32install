import { InstallError } from './errors.js';

/**
 * Releases are listed newest-first across all channels in catalog.json; we keep that order and do not
 * parse versions. Without `v`, `channel: 'pre'` takes the newest release whatever its channel, which
 * may be a stable one; any other channel takes the newest release whose channel is stable.
 */
export function pickRelease(catalog, { fw, v, channel } = {}) {
  const systems = Array.isArray(catalog?.systems) ? catalog.systems : [];
  if (!fw) return { systems };
  const system = systems.find((s) => s.id === fw);
  if (!system) throw new InstallError('catalog.unknownSystem', { fw });
  const releases = Array.isArray(system.releases) ? system.releases : [];
  let release;
  if (v) release = releases.find((r) => r.version === v);
  else if (channel === 'pre') release = releases[0];
  else release = releases.find((r) => (r.channel ?? 'stable') === 'stable');
  if (!release) throw new InstallError('catalog.unknownVersion', { fw, v: v ?? '' });
  return { system, release };
}
