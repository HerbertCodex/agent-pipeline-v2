import { type Infer } from '../domain/schema.js';
/** Default folder of validated mockups, relative to the repository root (`design.dir` overrides it). */
export declare const DEFAULT_DESIGN_DIR = "docs/design";
/** The `design` section of `.apv/config.json` (docs/DESIGN.md). */
export declare const designSchema: import("../domain/schema.js").Schema<{
    readonly dir: string | undefined;
}>;
export type DesignSection = Infer<typeof designSchema>;
/**
 * The validated-mockup folder of a `design` section: relative, inside the repository, without spaces,
 * normalized (no trailing slash). Throws a CONFIG error that names the faulty value.
 */
export declare function designDir(section: DesignSection | undefined): string;
