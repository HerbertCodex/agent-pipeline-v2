import { type OperatorOrdersSettings } from './config.js';
/** The operator orders as the working tree declares them (`apv status`); the merge on order reads them at the base. */
export interface OperatorOrdersStatus {
    settings: OperatorOrdersSettings | null;
    error: string | null;
    line: string;
}
export declare function operatorOrdersStatus(repo: string): OperatorOrdersStatus;
