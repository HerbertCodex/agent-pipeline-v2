import type { AgentConfig, ProcessResult } from '../domain/contracts.js';

/** Inspect only failed envelopes/messages, never classify successful generated code as an outage. */
export function providerStop(agent: AgentConfig, result: ProcessResult): { code: string; message: string } | null {
  if (result.status === 'cancelled') return null;
  if (result.status === 'timed_out') return { code: 'AGENT_TIMEOUT', message: 'The configured process deadline elapsed. Retained work must be inspected before resuming; this is not an account quota.' };
  if (agent.type === 'command') return null;
  let failed = result.status !== 'passed';
  const messages: string[] = [];
  for (const line of agent.type === 'claude' ? [result.stdout] : result.stdout.split('\n')) {
    try {
      const data = JSON.parse(line);
      const bad = data.is_error === true || data.type === 'error' || data.type === 'turn.failed' ||
        (data.type === 'result' && data.subtype !== 'success');
      if (!bad) continue;
      failed = true;
      messages.push(String(data.subtype ?? ''), typeof data.result === 'string' ? data.result : '',
        typeof data.error === 'string' ? data.error : String(data.error?.message ?? ''),
        String(data.error?.code ?? ''), String(data.error?.type ?? ''), String(data.message ?? ''));
    } catch { /* A partial response is not an executable diagnosis. */ }
  }
  if (!failed) return null;
  const text = `${messages.join('\n')}\n${result.stderr ?? ''}`.slice(-16000);
  if (/error_max_budget_usd|budget_exhausted|reached maximum budget/i.test(text))
    return { code: 'PROVIDER_BUDGET', message: 'The CLI stopped at the configured monetary ceiling. This does not establish that the subscription quota is exhausted. Review the usage mode and budget.' };
  if (/error_max_turns|maximum (?:number of )?turns|max turns exceeded/i.test(text))
    return { code: 'PROVIDER_TURNS', message: 'The CLI reached its configured turn limit. Inspect retained work and the attempt history before adjusting it.' };
  if (/usage_limit_reached|(?:hit|reached|exceeded) (?:your |the )?(?:session|weekly|daily|usage|plan) limit|quota.exceeded|insufficient_quota/i.test(text))
    return { code: 'PROVIDER_QUOTA', message: 'The provider reports an account usage limit. Retained work is available; resume after the account allowance is restored. No API, credit or model fallback was selected.' };
  if (/rate_limit_error|rate.limit.exceeded|too many requests|\b429\b/i.test(text))
    return { code: 'PROVIDER_RATE_LIMIT', message: 'The provider is limiting requests. Wait before resuming; this response does not identify a subscription reset time.' };
  if (/overloaded_error|service.unavailable|\b(?:502|503|529)\b/i.test(text))
    return { code: 'PROVIDER_UNAVAILABLE', message: 'The provider is temporarily unavailable. Inspect whether work was retained before retrying.' };
  return null;
}

export function stopAdvice(error: { code: string; message: string } | null) {
  if (!error) return null;
  const actions: Record<string, { category: string; action: string }> = {
    PROVIDER_QUOTA: { category: 'quota', action: 'Attendre le rétablissement du quota fournisseur, puis reprendre le travail conservé.' },
    PROVIDER_RATE_LIMIT: { category: 'rate-limit', action: 'Attendre avant de reprendre ; la date de rétablissement n’est pas connue du contrôleur.' },
    PROVIDER_UNAVAILABLE: { category: 'provider', action: 'Vérifier la disponibilité du fournisseur, puis reprendre.' },
    AGENT_TIMEOUT: { category: 'timeout', action: 'Inspecter le travail conservé et la durée de l’étape avant de reprendre ou d’ajuster le délai.' },
    BUDGET: { category: 'timeout', action: 'Le temps actif autorisé est épuisé. Examiner les durées et ajuster le délai si nécessaire.' },
    PROVIDER_TURNS: { category: 'turn-limit', action: 'Examiner la progression avant de relever le nombre de tours.' },
    PROVIDER_BUDGET: { category: 'money', action: 'Vérifier le mode abonnement et les plafonds monétaires configurés.' },
    COST_BUDGET: { category: 'money', action: 'Vérifier le mode d’usage et le plafond total avant de reprendre.' },
    QA_BUDGET: { category: 'money', action: 'Vérifier le mode d’usage et le plafond QA avant une nouvelle revue.' },
    REPAIR_NO_PROGRESS: { category: 'no-progress', action: 'Examiner les mêmes erreurs répétées ; corriger le périmètre ou le diagnostic avant une nouvelle tentative.' },
    REPAIR_NO_CHANGE: { category: 'no-progress', action: 'La réparation n’a pas modifié le candidat. Examiner le diagnostic avant une nouvelle tentative.' },
    GATES_FAILED: { category: 'checks', action: 'Lire les contrôles en échec et leurs diagnostics avant la réparation.' },
    QA_REJECTED: { category: 'qa', action: 'Traiter les constats QA ; un verdict négatif n’est pas une limite fournisseur.' },
    MODEL_SELECTION: { category: 'configuration', action: 'Renseigner explicitement les modèles et efforts des profils d’exécution et de QA.' },
    MODEL_AUTH: { category: 'authentication', action: 'Vérifier la connexion du CLI au compte prévu, puis reprendre.' },
    MODEL_UNAVAILABLE: { category: 'configuration', action: 'Vérifier l’accès au modèle choisi et préparer son remplacement explicite si nécessaire.' },
    MODEL_EFFORT: { category: 'configuration', action: 'Choisir un effort pris en charge par le modèle et le CLI configurés.' },
  };
  return { code: error.code, ...(actions[error.code] ?? { category: 'other', action: 'Consulter le diagnostic et l’action proposée par le contrôleur.' }), automaticRetry: false };
}
