/** Schema model rebuilt from the migrations, in order. Names are stored lowercased (unquoted) or as written (quoted). */
export interface Location { file: string; line: number }

export interface Column extends Location {
  name: string;
  type: string;
  /** True when the name was written between double quotes (case kept). */
  quoted: boolean;
}

export interface Table extends Location {
  schema: string;
  name: string;
  quoted: boolean;
  temporary: boolean;
  columns: Map<string, Column>;
  rlsEnabled: boolean;
  rlsForced: boolean;
}

export interface ForeignKey extends Location {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export type IndexKind = 'index' | 'primary' | 'unique';

export interface Index extends Location {
  name: string;
  table: string;
  kind: IndexKind;
  unique: boolean;
  /** Column names; expressions are kept as `(expr)`. */
  columns: string[];
  partial: boolean;
  /** `where` clause of a partial index. */
  predicate: string | null;
}

export interface Policy extends Location {
  name: string;
  table: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}

export interface Grant extends Location { role: string }

export interface DbFunction extends Location {
  schema: string;
  name: string;
  quoted: boolean;
  argCount: number;
  argTypes: string;
  returns: string;
  securityDefiner: boolean;
  /** `set search_path` items (unquoted schema names, `''` gives one empty item), or null when not set. */
  searchPath: string[] | null;
  /** Roles holding EXECUTE, with the location that granted it (default privileges use the function location). */
  executeGrants: Map<string, Grant & { explicit: boolean }>;
}

export interface DbType extends Location { schema: string; name: string; quoted: boolean; kind: string }

export interface SchemaModel {
  tables: Map<string, Table>;
  foreignKeys: ForeignKey[];
  indexes: Index[];
  policies: Policy[];
  functions: DbFunction[];
  types: Map<string, DbType>;
  /** Problems met while reading the migrations (unterminated strings, unknown shapes). */
  notes: { file: string; line: number; message: string }[];
}

export function emptyModel(): SchemaModel {
  return { tables: new Map(), foreignKeys: [], indexes: [], policies: [], functions: [], types: new Map(), notes: [] };
}

export const tableKey = (schema: string, name: string): string => `${schema}.${name}`;
