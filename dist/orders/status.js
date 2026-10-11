import { loadConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { operatorOrdersLine } from './config.js';
export function operatorOrdersStatus(repo) {
    try {
        const settings = loadConfig(repo).config.rules?.operatorOrders ?? null;
        return { settings, error: null, line: operatorOrdersLine(settings) };
    }
    catch (error) {
        return { settings: null, error: errorMessage(error).split('\n')[0] ?? 'configuration illisible', line: operatorOrdersLine(null, 'illisible') };
    }
}
//# sourceMappingURL=status.js.map