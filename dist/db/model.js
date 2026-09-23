export function emptyModel() {
    return { tables: new Map(), foreignKeys: [], indexes: [], policies: [], functions: [], types: new Map(), notes: [] };
}
export const tableKey = (schema, name) => `${schema}.${name}`;
//# sourceMappingURL=model.js.map