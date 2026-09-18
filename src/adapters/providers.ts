import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { agentSchema, type AgentConfig } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
export const nativeProviders = ['codex', 'claude'] as const;
export function providerProfile(name: string): AgentConfig {
  invariant(nativeProviders.includes(name as typeof nativeProviders[number]), 'PROVIDER', 'Choose codex or claude; for a generic worker use --agent FILE');
  return agentSchema.parse(name === 'claude'
    ? { type: 'claude', passEnv: ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] }
    : { type: 'codex', passEnv: ['HOME', 'CODEX_HOME', 'CODEX_API_KEY'] });
}
export function executableAvailability(agent: AgentConfig, cwd: string, pathEnv = process.env['PATH'] ?? '') {
  const executable = agent.command[0] ?? agent.type;
  const paths = isAbsolute(executable) || executable.includes('/') ? [resolve(cwd, executable)]
    : pathEnv.split(delimiter).map(p => resolve(p || cwd, executable));
  for (const path of paths) {
    try { accessSync(path, constants.X_OK); return { executable, available: true, path: realpathSync(path), authentication: 'not-checked' }; }
    catch { /* Presence check only, never spawn a provider or contact a service. */ }
  }
  return { executable, available: false, path: null, authentication: 'not-checked' };
}
export const providerSupport = [
  { id: 'codex', integration: 'native', roles: ['setup', 'product', 'implementer', 'qa'], contractTested: true, authenticatedPilot: 'not-run', permissionModel: 'Provider read-only/workspace-write mode; not verified as an OS sandbox here.' },
  { id: 'claude', integration: 'native', roles: ['setup', 'product', 'implementer', 'qa'], contractTested: true, authenticatedPilot: 'not-run', permissionModel: 'Read/Glob/Grep; Edit/Write only for Implementer. No Bash or subagents. Optional allowlisted MCP checks execute in the controller; final gates remain independent.' },
  { id: 'command', integration: 'protocol', roles: ['setup', 'product', 'implementer', 'qa'], contractTested: true, authenticatedPilot: 'operator-specific', permissionModel: 'Requires a compatible wrapper for both protocols. No sandbox provided.' },
];
