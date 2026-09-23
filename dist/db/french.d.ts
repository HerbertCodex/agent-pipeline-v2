export declare function foldAccents(text: string): string;
/**
 * French words found in an identifier, or [] when it reads as English.
 * `allow` lists words or whole identifiers the project accepts.
 */
export declare function frenchWords(identifier: string, allow?: readonly string[]): string[];
export declare const SNAKE_CASE: RegExp;
