// Data validation for the authored world atlas and timeline clock.
export const LOCATION_KINDS=Object.freeze(['region','town','neighborhood','building','room','outdoor','other']);
export const ENTITY_KINDS=Object.freeze(['character','faction','organization','object','concept']);

export function bounded(value, label, max=2000) {
  if(typeof value!=='string'||value.length>max)throw new TypeError(`Invalid ${label}`);
  return value.trim();
}

export function worldZone(zone='UTC') {
  if(typeof zone!=='string'||zone.length>100)throw new TypeError('Invalid time zone');
  try { new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(new Date()); }
  catch { throw new TypeError('Unknown IANA time zone'); }
  return zone;
}

export function worldInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new TypeError('Time must be an ISO 8601 instant with a time-zone offset');
  const ms=Date.parse(value);
  if(!Number.isFinite(ms) || ms < Date.UTC(1800,0,1) || ms > Date.UTC(2200,0,1))throw new TypeError('World time outside supported range');
  return ms;
}
