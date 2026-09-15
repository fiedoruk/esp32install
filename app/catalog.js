import { InstallError } from './errors.js';

const channelOf = (release) => release.channel ?? 'stable';

/**
 * Releases are listed newest-first per channel in catalog.json; we keep that order and do not parse
 * versions. Without `v`, `channel: 'pre'` opts into the newest pre-release and falls back to the
 * newest stable one when the system publishes none; any other channel selects the newest stable.
 */
export function pickRelease(catalog, { fw, v, channel } = {}) {
  const systems = Array.isArray(catalog?.systems) ? catalog.systems : [];
  if (!fw) return { systems };
  const system = systems.find((s) => s.id === fw);
  if (!system) throw new InstallError('catalog.unknownSystem', { fw });
  const releases = Array.isArray(system.releases) ? system.releases : [];
  const newestStable = () => releases.find((r) => channelOf(r) === 'stable');
  let release;
  if (v) release = releases.find((r) => r.version === v);
  else if (channel === 'pre') release = releases.find((r) => channelOf(r) === 'pre') ?? newestStable();
  else release = newestStable();
  if (!release) throw new InstallError('catalog.unknownVersion', { fw, v: v ?? '' });
  return { system, release };
}
