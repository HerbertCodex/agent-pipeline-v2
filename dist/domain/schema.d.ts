export type JsonSchema = Record<string, unknown>;
export interface Schema<T> {
    readonly json: JsonSchema;
    parse(value: unknown, path?: string): T;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;
export declare const s: {
    string(min?: number, max?: number, pattern?: RegExp): Schema<string>;
    number(min: number, max: number): Schema<number>;
    finite(min: number, max: number): Schema<number>;
    nullable<T>(schema: Schema<T>): Schema<T | null>;
    boolean(): Schema<boolean>;
    enum<const T extends readonly string[]>(values: T): Schema<T[number]>;
    literal<const T extends number | string>(value: T): Schema<T>;
    array<T>(item: Schema<T>, min?: number, max?: number): Schema<T[]>;
    default<T>(schema: Schema<T>, value: T): Schema<T>;
    object<const T extends Record<string, Schema<unknown>>>(shape: T): Schema<{ [K in keyof T]: Infer<T[K]>; }>;
};
export declare function parseJson(text: string): unknown;
