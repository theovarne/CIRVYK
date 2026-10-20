/** Display-only US Eastern time. Stored epochs and ISO data remain unchanged. */
export const DISPLAY_TIME_ZONE = 'America/New_York';
export const DISPLAY_TIME_LABEL = 'US Eastern';
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});
const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIME_ZONE, timeZoneName: 'longOffset' });

function parts(value) {
  if (value == null || value === '') return null;
  // Strings must identify an instant. Do not interpret timezone-less text in the host zone.
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return false;
  if (!(typeof value === 'number' || typeof value === 'string' || value instanceof Date)) return false;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const result = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const offset = offsetFormatter.formatToParts(date).find(part => part.type === 'timeZoneName').value.replace('GMT', 'UTC');
  return { date: `${result.year}-${result.month}-${result.day}`, clock: `${result.hour}:${result.minute}:${result.second}`, zone: result.timeZoneName, offset };
}
const missing = value => value === null ? '—' : 'Invalid timestamp';

export function easternZone(value, { offset = false } = {}) {
  const p = parts(value);
  return p ? `${p.zone}${offset ? ` (${p.offset})` : ''}` : missing(p);
}

export function formatEasternTime(value, { zone = true, offset = false } = {}) {
  const p = parts(value);
  return p ? `${p.clock}${zone ? ` ${p.zone}` : ''}${offset ? ` (${p.offset})` : ''}` : missing(p);
}

export function formatEasternDateTime(value, { offset = false } = {}) {
  const p = parts(value);
  return p ? `${p.date} ${p.clock} ${p.zone}${offset ? ` (${p.offset})` : ''}` : missing(p);
}

export function formatEasternRange(start, end, { offset = true } = {}) {
  const a = parts(start), b = parts(end);
  if (!a || !b) return `${formatEasternDateTime(start)} – ${formatEasternDateTime(end)}`;
  const first = `${a.date} ${a.clock} ${a.zone}`;
  const last = `${a.date === b.date ? '' : `${b.date} `}${b.clock} ${b.zone}`;
  if (!offset) return `${first} – ${last}`;
  return a.offset === b.offset ? `${first} – ${last} (${a.offset})` : `${first} (${a.offset}) – ${last} (${b.offset})`;
}

/** Engine descriptions retain their stored wording; only presentation terminology changes. */
export function displayTimeDescription(value) {
  return String(value ?? '').replace(/UTC-aligned/g, 'epoch-aligned').replace(/UTC window/g, 'processing window').replace(/UTC check time/g, 'check timestamp');
}
