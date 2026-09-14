import { s, type Infer } from '../domain/schema.js';

export const owaspTopicIds = [
  'threat-modeling','authentication','password-storage','session-management','authorization','input-validation','injection-prevention','xss','csrf','content-security-policy','file-upload','ssrf','rest-security','data-protection','secrets-management','logging-monitoring','software-supply-chain','github-actions','ai-agent-security','llm-prompt-injection','secure-coding-with-ai','mcp-security',
] as const;
export type OwaspTopicId = typeof owaspTopicIds[number];

export interface OwaspTopic { id: OwaspTopicId; title: string; url: string; purpose: string; }
export const owaspCatalog: readonly OwaspTopic[] = [
  { id:'threat-modeling', title:'Threat Modeling', url:'https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html', purpose:'Model assets, data flows, trust boundaries, threats, mitigations and review.' },
  { id:'authentication', title:'Authentication', url:'https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html', purpose:'Identity, login, re-authentication and authentication failure handling.' },
  { id:'password-storage', title:'Password Storage', url:'https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html', purpose:'Password hashing, salts, work factors and migration.' },
  { id:'session-management', title:'Session Management', url:'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html', purpose:'Session identifiers, cookies, rotation, expiry and invalidation.' },
  { id:'authorization', title:'Authorization', url:'https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html', purpose:'Object, tenant and action-level access control with deny-by-default behavior.' },
  { id:'input-validation', title:'Input Validation', url:'https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html', purpose:'Syntactic and semantic validation at trust boundaries.' },
  { id:'injection-prevention', title:'Injection Prevention', url:'https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html', purpose:'Parameterized operations and context-safe handling of untrusted input.' },
  { id:'xss', title:'Cross Site Scripting Prevention', url:'https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html', purpose:'Context-aware output encoding, safe sinks and framework escape boundaries.' },
  { id:'csrf', title:'Cross-Site Request Forgery Prevention', url:'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html', purpose:'Protect state-changing browser requests against forged origins.' },
  { id:'content-security-policy', title:'Content Security Policy', url:'https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html', purpose:'Use CSP as defense in depth for browser-delivered applications.' },
  { id:'file-upload', title:'File Upload', url:'https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html', purpose:'Constrain file type, size, names, storage and downstream processing.' },
  { id:'ssrf', title:'Server-Side Request Forgery Prevention', url:'https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html', purpose:'Constrain server-side outbound requests and untrusted destinations.' },
  { id:'rest-security', title:'REST Security', url:'https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html', purpose:'Endpoint-level access control, transport, tokens and API error behavior.' },
  { id:'data-protection', title:'Cryptographic Storage / Data Protection', url:'https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html', purpose:'Protect sensitive data at rest and manage cryptographic choices explicitly.' },
  { id:'secrets-management', title:'Secrets Management', url:'https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html', purpose:'Keep credentials out of source, logs and broad process environments.' },
  { id:'logging-monitoring', title:'Logging', url:'https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html', purpose:'Record security-relevant events without leaking sensitive data.' },
  { id:'software-supply-chain', title:'Software Supply Chain Security', url:'https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html', purpose:'Review dependencies, provenance, lockfiles and build integrity.' },
  { id:'github-actions', title:'GitHub Actions Security', url:'https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html', purpose:'Minimize workflow permissions, protect secrets and avoid untrusted workflow execution.' },
  { id:'ai-agent-security', title:'AI Agent Security', url:'https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html', purpose:'Constrain tools, memory, privileges, data flows and human approval boundaries.' },
  { id:'llm-prompt-injection', title:'LLM Prompt Injection Prevention', url:'https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html', purpose:'Treat external and repository content as untrusted data, not authority.' },
  { id:'secure-coding-with-ai', title:'Secure Coding with AI', url:'https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html', purpose:'Review AI-suggested dependencies, tests, CI changes, context leakage and agent privileges.' },
  { id:'mcp-security', title:'MCP Security', url:'https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html', purpose:'Constrain MCP servers, tool descriptions, arguments, credentials and trust.' },
] as const;

const exposureValues = ['unknown','local','internal','internet'] as const;
export const securityProfileSchema = s.object({
  exposure: s.default(s.enum(exposureValues), 'unknown'), authentication: s.default(s.boolean(), false), authorization: s.default(s.boolean(), false), sensitiveData: s.default(s.boolean(), false), sessionState: s.default(s.boolean(), false), fileUploads: s.default(s.boolean(), false), externalRequests: s.default(s.boolean(), false), database: s.default(s.boolean(), false), multiTenant: s.default(s.boolean(), false), secrets: s.default(s.boolean(), false), api: s.default(s.boolean(), false), webUi: s.default(s.boolean(), false), ciCd: s.default(s.boolean(), false), dependencyChange: s.default(s.boolean(), false), aiAgent: s.default(s.boolean(), false), mcp: s.default(s.boolean(), false),
});
export type SecurityProfile = Infer<typeof securityProfileSchema>;
type MutableSecurityProfile = { -readonly [K in keyof SecurityProfile]: SecurityProfile[K] };
const topicSchema = s.object({ id: s.enum(owaspTopicIds), reason: s.string(1, 2000), sourceUrl: s.string(1, 1000) });
export const securityContextSchema = s.object({
  profile: securityProfileSchema, topics: s.array(topicSchema, 0, owaspTopicIds.length), requiresThreatModel: s.boolean(), negativeTestsRequired: s.boolean(), minimumLane: s.enum(['fast','standard','high'] as const), untrustedContext: s.boolean(), signals: s.array(s.string(1, 300), 0, 100), note: s.string(1, 4000),
});
export type SecurityContext = Infer<typeof securityContextSchema>;

export function neutralSecurityContext(): SecurityContext {
  return securityContextSchema.parse({ profile: {}, topics: [], requiresThreatModel: false, negativeTestsRequired: false, minimumLane: 'fast', untrustedContext: true, signals: [], note: 'No material security surface was detected deterministically. Product still owns application-specific security analysis.' });
}
function normalized(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function hit(text: string, re: RegExp): boolean { return re.test(text); }
function topic(id: OwaspTopicId, reason: string): { id: OwaspTopicId; reason: string; sourceUrl: string } { const found=owaspCatalog.find(x=>x.id===id)!; return { id, reason, sourceUrl: found.url }; }

export function assessSecurity(input: { text: string; projectType?: string; files?: string[] }): SecurityContext {
  const text=normalized(input.text); const fileText=normalized((input.files??[]).join(' ')); const projectType=input.projectType??'unknown';
  const profile={...securityProfileSchema.parse({})} as MutableSecurityProfile; const signals:string[]=[];
  const mark=(key: keyof Omit<SecurityProfile,'exposure'>, reason:string):void=>{ profile[key]=true; signals.push(reason); };
  if(hit(text,/\b(public|internet|internet-facing|public-facing|accessible publiquement)\b/)) profile.exposure='internet';
  else if(hit(text,/\b(internal|intranet|enterprise-only|interne)\b/)) profile.exposure='internal';
  else if(hit(text,/\b(local|localhost|developpement local|development local)\b/)) profile.exposure='local';
  const auth=hit(text,/\b(auth|authentication|authenticate|login|log in|sign[ -]?in|connexion|mot de passe|password|oauth|oidc|sso|passkey|mfa|2fa)\b/); if(auth) mark('authentication','authentication or credential flow');
  const password=hit(text,/\b(password|mot de passe|passphrase|credential)\b/); const session=auth||hit(text,/\b(session|cookie|jwt|refresh token|access token|remember me)\b/); if(session) mark('sessionState','authenticated/session state');
  if(hit(text,/\b(authori[sz]ation|permission|role|rbac|acl|access control|admin|administrator|staff|privilege|tenant|bibliothecaire|librarian)\b/)) mark('authorization','authorization, role or object-access rules');
  if(hit(text,/\b(pii|personal data|donnees personnelles|sensitive data|medical|health|financial|payment|card|iban|email|phone|address|credential|password|secret)\b/)) mark('sensitiveData','sensitive or personal data');
  if(hit(text,/\b(file upload|upload file|upload|attachment|piece jointe|multipart|avatar upload|document upload|image upload|import file)\b/)) mark('fileUploads','untrusted file upload/import');
  if(hit(text,/\b(ssrf|webhook|callback url|remote url|user[- ]supplied url|external api|third[- ]party api|http client|fetch url|download from|scrap(?:e|ing))\b/)) mark('externalRequests','server-side outbound request or external integration');
  if(hit(text,/\b(database|postgres(?:ql)?|mysql|mariadb|sqlite|mongo(?:db)?|dynamodb|sql|orm|prisma|hibernate|repository|persistence|persist)\b/)) mark('database','persistent data store');
  if(hit(text,/\b(multi[- ]tenant|multitenant|tenant isolation|multi[- ]site|multisite|plusieurs sites)\b/)) mark('multiTenant','tenant/site isolation');
  if(hit(text,/\b(secret|api key|private key|credential|vault|kms|token storage|access key)\b/)||/(?:^|\/)(?:\.env|secrets?|credentials?)(?:[./]|$)/.test(fileText)) mark('secrets','secret or credential handling');
  if(hit(text,/\b(api|rest|graphql|endpoint|webhook|json api|rpc)\b/)) mark('api','API endpoint or service boundary');
  if(hit(text,/\b(ui|interface|screen|page|form|dashboard|browser|frontend|web app|application web|ecran|formulaire)\b/)&&['frontend','fullstack','mobile'].includes(projectType)) mark('webUi','user-facing interface');
  if(hit(text,/\b(ci|cd|ci\/cd|github actions|workflow|pipeline|deployment|deploy)\b/)||/(?:^|\/)\.github\/workflows\//.test(fileText)) mark('ciCd','CI/CD or workflow configuration');
  if(hit(text,/\b(dependenc|package|library upgrade|upgrade package|install package|npm install|pnpm add|pip install|cargo add|go get|lockfile)\b/)||/(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^ ]*\.txt|pyproject\.toml|cargo\.toml|cargo\.lock|go\.mod|go\.sum)/.test(fileText)) mark('dependencyChange','dependency or software-supply-chain change');
  if(hit(text,/\b(ai agent|agentic|coding agent|llm|prompt injection|codex|claude code|tool calling|memory poisoning|model context)\b/)||/(?:^|\/)(?:roles|skills|\.agent-pipeline)\//.test(fileText)) mark('aiAgent','AI agent or LLM tool boundary');
  if(hit(text,/\b(mcp|model context protocol)\b/)){ mark('mcp','MCP server/tool boundary'); profile.aiAgent=true; }
  const topics=new Map<OwaspTopicId,ReturnType<typeof topic>>(); const add=(id:OwaspTopicId,reason:string):void=>{ if(!topics.has(id)) topics.set(id,topic(id,reason)); };
  if(profile.authentication) add('authentication','Authentication behavior is in scope.'); if(password) add('password-storage','Password credentials are in scope.'); if(profile.sessionState) add('session-management','Session/token state is in scope.'); if(profile.authorization||profile.multiTenant) add('authorization','Authorization or isolation rules are in scope.'); if(profile.api) add('rest-security','An API/service boundary is in scope.'); if(profile.webUi){ add('xss','Browser-rendered UI is in scope.'); add('content-security-policy','Browser defense-in-depth is relevant.'); } if(profile.webUi&&profile.sessionState) add('csrf','Authenticated browser state-changing requests are in scope.'); if(profile.fileUploads) add('file-upload','Untrusted files are accepted or imported.'); if(profile.externalRequests) add('ssrf','Server-side outbound destinations or callbacks are in scope.'); if(profile.sensitiveData) add('data-protection','Sensitive or personal data is in scope.'); if(profile.secrets) add('secrets-management','Secrets or credentials are in scope.'); if(profile.database||profile.fileUploads||profile.externalRequests||profile.api||profile.webUi) add('input-validation','Untrusted input crosses an application boundary.'); if(profile.database||profile.api||profile.fileUploads) add('injection-prevention','Untrusted input may reach an interpreter, query or parser.'); if(profile.authentication||profile.authorization||profile.sensitiveData||profile.secrets) add('logging-monitoring','Security-relevant events require safe audit/diagnostic handling.'); if(profile.dependencyChange) add('software-supply-chain','Dependency provenance or lockfile integrity is in scope.'); if(profile.ciCd){ add('github-actions','CI/workflow permissions and untrusted triggers are in scope.'); add('software-supply-chain','Build/CI integrity is in scope.'); } if(profile.aiAgent){ add('ai-agent-security','An AI agent/tool boundary is in scope.'); add('llm-prompt-injection','Agent context can contain untrusted instructions.'); add('secure-coding-with-ai','AI-assisted code changes require supply-chain and review controls.'); } if(profile.mcp) add('mcp-security','MCP tools or servers are in scope.');
  const critical=profile.authentication||profile.authorization||profile.sensitiveData||profile.fileUploads||profile.externalRequests||profile.multiTenant||profile.secrets||profile.aiAgent||profile.mcp; const requiresThreatModel=critical; if(requiresThreatModel) add('threat-modeling','Material trust boundaries or security-sensitive assets are in scope.');
  const negativeTestsRequired=profile.authentication||profile.authorization||profile.fileUploads||profile.externalRequests||profile.api||profile.database; const high=critical||profile.ciCd||profile.dependencyChange; const standard=topics.size>0;
  return securityContextSchema.parse({ profile, topics:[...topics.values()], requiresThreatModel, negativeTestsRequired, minimumLane:high?'high':standard?'standard':'fast', untrustedContext:true, signals:[...new Set(signals)].slice(0,100), note:topics.size?'OWASP routing is deterministic guidance, not a compliance claim. Product must map applicable topics to verifiable criteria; configured gates remain authoritative.':'No material security surface was detected deterministically. Product still owns application-specific security analysis.' });
}
export function topicById(id:OwaspTopicId):OwaspTopic { return owaspCatalog.find(x=>x.id===id)!; }
