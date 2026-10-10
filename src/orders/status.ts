import { loadConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { operatorOrdersLine, type OperatorOrdersSettings } from './config.js';

/** The operator orders as the working tree declares them (`apv status`); the merge on order reads them at the base. */
export interface OperatorOrdersStatus { settings: OperatorOrdersSettings | null; error: string | null; line: string }

export function operatorOrdersStatus(repo: string): OperatorOrdersStatus {
  try {
    const settings = loadConfig(repo).config.rules?.operatorOrders ?? null;
    return { settings, error: null, line: operatorOrdersLine(settings) };
  } catch (error) {
    return { settings: null, error: errorMessage(error).split('\n')[0] ?? 'configuration illisible', line: operatorOrdersLine(null, 'illisible') };
  }
}
