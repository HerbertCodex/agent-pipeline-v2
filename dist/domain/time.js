/**
 * Times shown to a human, in the local time zone of the machine (Intl, the zone of the system or of `TZ`),
 * with its offset from UTC. The files keep ISO dates in UTC (`Date#toISOString`): only the display changes.
 */
/** Offset of `date` in `timeZone`, as `UTC`, `UTC+2` or `UTC+5:30`. */
function offsetLabel(date, parts) {
    const asUtc = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']), Number(parts['minute']), Number(parts['second']));
    const minutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
    if (minutes === 0)
        return 'UTC';
    const sign = minutes > 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}
function partsOf(date, timeZone) {
    const format = new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        ...(timeZone ? { timeZone } : {}),
    });
    return Object.fromEntries(format.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
/**
 * A date (ISO text, milliseconds or Date) in local time: `2026-09-24 20:22 UTC+2`, or `20:22` with
 * `style: 'time'`. A value that is not a valid date is returned as it is (as text), never guessed.
 */
export function localTime(value, options = {}) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return String(value);
    const parts = partsOf(date, options.timeZone);
    const time = `${parts['hour']}:${parts['minute']}`;
    if (options.style === 'time')
        return time;
    return `${parts['year']}-${parts['month']}-${parts['day']} ${time} ${offsetLabel(date, parts)}`;
}
/** Name of the local time zone (`Europe/Paris`), for the help texts and the JSON outputs. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/**
 * The end of a pause as given by a human: `HH:MM` in local time (its next occurrence after `now`, tomorrow
 * when that time has passed today), or a full ISO date with its zone (`2026-09-24T18:30:00Z`,
 * `2026-09-24T20:30+02:00`). Null when the text is neither.
 */
export function parseUntil(text, now = new Date()) {
    const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
    if (clock) {
        const at = new Date(now.getTime());
        at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
        if (at.getTime() <= now.getTime())
            at.setDate(at.getDate() + 1);
        return at;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text.trim()))
        return null;
    const date = new Date(text.trim());
    return Number.isNaN(date.getTime()) ? null : date;
}
//# sourceMappingURL=time.js.map