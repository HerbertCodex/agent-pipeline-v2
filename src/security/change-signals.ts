/** Infrastructure mentions are not changes: retain affirmative clauses and direct paths separately. */
export function changeLanguage(text: string): string {
  return text
    .replace(/(?:\.?[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.[\]-]+/g, ' ')
    .split(/\n|[;!?]|\.(?=\s|$)|\b(?:but|however|mais|cependant)\b/iu)
    .filter(clause => !/\b(?:no|never|without|avoid|unchanged|do not|don't|must not|aucun(?:e)?|sans|inchang\w*|ne\b[^,;]*\bpas|hors p[eé]rim[eè]tre)\b/iu.test(clause))
    .join('\n');
}

/** Only explicit task paths can assert infrastructure changes, never a repository search result. */
export function pathsMentioned(request: string, tracked: string[]): string[] {
  return tracked.filter(path => request.includes(path) && changeLanguage(request.replaceAll(path, 'TARGETPATH')).includes('TARGETPATH'));
}

/** Exclude explicit non-change instructions, never negative security obligations
 * such as "do not bypass authentication" or "never leak passwords". Paths are
 * classified separately from prose so an auth directory is not a login request.
 */
export function securityScopeText(text: string): string {
  return text
    .replace(/(?:\.?[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.[\]-]+/g, ' ')
    .split(/\n|[;!?]|\.(?=\s|$)|\b(?:but|however|mais|cependant)\b/iu)
    .filter(clause => {
      // Ambiguous mixed clauses remain conservative; do not discard a second action.
      if (/\b(?:and|et)\s+(?:add|implement|create|change|fix|ajouter|creer|modifier|corriger)\b/iu.test(clause)) return true;
      return !/^\s*(?:(?:do not|don't|never)\s+(?:add|introduce|implement|create|change|modify|touch|rewrite)|ne\s+pas\s+(?:ajouter|introduire|implementer|implémenter|creer|créer|modifier|changer|toucher))\b/iu.test(clause);
    })
    .join('\n');
}
