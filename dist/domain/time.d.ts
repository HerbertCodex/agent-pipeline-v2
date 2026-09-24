/**
 * Times shown to a human, in the local time zone of the machine (Intl, the zone of the system or of `TZ`),
 * with its offset from UTC. The files keep ISO dates in UTC (`Date#toISOString`): only the display changes.
 */
export interface LocalTimeOptions {
    /** IANA zone; absent: the zone of the system (tests pass one to stay deterministic). */
    timeZone?: string;
    /** `datetime` (default): `2026-09-24 20:22 UTC+2`; `time`: `20:22`. */
    style?: 'datetime' | 'time';
}
/**
 * A date (ISO text, milliseconds or Date) in local time: `2026-09-24 20:22 UTC+2`, or `20:22` with
 * `style: 'time'`. A value that is not a valid date is returned as it is (as text), never guessed.
 */
export declare function localTime(value: string | number | Date, options?: LocalTimeOptions): string;
/** Name of the local time zone (`Europe/Paris`), for the help texts and the JSON outputs. */
export declare const localTimeZone: () => string;
/**
 * The end of a pause as given by a human: `HH:MM` in local time (its next occurrence after `now`, tomorrow
 * when that time has passed today), or a full ISO date with its zone (`2026-09-24T18:30:00Z`,
 * `2026-09-24T20:30+02:00`). Null when the text is neither.
 */
export declare function parseUntil(text: string, now?: Date): Date | null;
