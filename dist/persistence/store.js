import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { states, validateReceipt } from '../domain/contracts.js';
import { parseJson } from '../domain/schema.js';
import { hash } from '../domain/hash.js';
import { invariant, PipelineError } from '../domain/errors.js';
export function processAlive(pid) {
    if (process.platform === 'linux') {
        try {
            const state = /\)\s+([A-Z])/.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1];
            if (state === 'Z' || state === 'X')
                return false;
        }
        catch { /* Fallback is conservative for permission errors and PID reuse. */ }
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
export class Store {
    root;
    onProgress;
    db;
    constructor(root) {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        invariant(!lstatSync(root).isSymbolicLink(), 'STATE_PATH', 'State root cannot be a symlink');
        this.root = realpathSync(root);
        chmodSync(this.root, 0o700);
        const file = join(this.root, 'control.sqlite');
        invariant(!existsSync(file) || !lstatSync(file).isSymbolicLink(), 'STATE_PATH', 'Database cannot be a symlink');
        this.db = new DatabaseSync(file, { allowExtension: false });
        chmodSync(file, 0o600);
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
        const version = Number(this.db.prepare('PRAGMA user_version').get()['user_version']);
        if (version > 2) {
            this.db.close();
            throw new PipelineError('DB_VERSION', `Unsupported database version ${version}`);
        }
        this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS leases(run_id TEXT PRIMARY KEY REFERENCES runs(id), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS execution_lease(slot INTEGER PRIMARY KEY CHECK(slot=1), run_id TEXT NOT NULL REFERENCES runs(id), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS children(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), pid INTEGER NOT NULL, active INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS proof_cache(key TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES receipts(id), expires_at INTEGER NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS children_run ON children(run_id, active);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS document_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL REFERENCES documents(id), at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS document_leases(doc_id TEXT PRIMARY KEY REFERENCES documents(id), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS document_children(id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id), pid INTEGER NOT NULL, active INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS document_events_doc ON document_events(doc_id,seq);
      PRAGMA user_version=2;
      COMMIT;
    `);
    }
    close() { this.db.close(); }
    transaction(f) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = f();
            this.db.exec('COMMIT');
            return value;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    create(run) {
        this.transaction(() => {
            this.db.prepare('INSERT INTO runs(id,version,data) VALUES(?,?,?)').run(run.id, run.version, JSON.stringify(run));
            this.event(run.id, 'run.created', { taskId: run.task.id, baseSha: run.baseSha });
        });
    }
    get(id) {
        const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
        invariant(row, 'NOT_FOUND', `Unknown run ${id}`);
        const value = parseJson(String(row['data']));
        invariant(value && typeof value === 'object', 'DB_CORRUPT', 'Invalid stored run');
        const run = value; // Private, versioned storage boundary; not agent JSON.
        invariant(run.id === id && states.includes(run.state) && Number.isSafeInteger(run.version) &&
            hash(run.config) === run.configHash, 'DB_CORRUPT', 'Stored run integrity mismatch');
        return run;
    }
    list() { return this.db.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 200').all().map(r => this.get(String(r['id']))); }
    save(run, type, data = {}) {
        const next = structuredClone(run);
        next.version++;
        next.updatedAt = Date.now();
        this.transaction(() => {
            const result = this.db.prepare('UPDATE runs SET version=?,data=? WHERE id=? AND version=?')
                .run(next.version, JSON.stringify(next), next.id, run.version);
            invariant(Number(result.changes) === 1, 'CONFLICT', 'Stale run update refused');
            this.event(next.id, type, { state: next.state, ...data });
        });
        Object.assign(run, next);
    }
    event(runId, type, data) {
        this.db.prepare('INSERT INTO events(run_id,at,type,data) VALUES(?,?,?,?)').run(runId, Date.now(), type, JSON.stringify(data));
        try {
            this.onProgress?.('run', runId, type, data);
        }
        catch { /* Observability cannot change committed decisions. */ }
    }
    events(id) {
        return this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY seq').all(id).map(row => ({
            seq: Number(row['seq']), runId: String(row['run_id']), at: Number(row['at']), type: String(row['type']),
            data: parseJson(String(row['data'])),
        }));
    }
    acquire(id) {
        const token = randomUUID();
        this.transaction(() => {
            invariant(!this.db.prepare('SELECT 1 FROM leases WHERE run_id=?').get(id), 'LOCKED', 'Run is locked. Never auto-steal a lease; inspect and recover after stopping orphan processes.');
            this.db.prepare('INSERT INTO leases VALUES(?,?,?,?)').run(id, token, process.pid, hostname());
        });
        return token;
    }
    acquireExecution(id) {
        const token = randomUUID();
        this.transaction(() => {
            invariant(!this.db.prepare('SELECT 1 FROM execution_lease').get(), 'BUSY', 'Another execution is active in this local store; retry after it stops');
            this.db.prepare('INSERT INTO execution_lease VALUES(1,?,?,?,?)').run(id, token, process.pid, hostname());
        });
        return token;
    }
    releaseExecution(id, token) {
        this.db.prepare('DELETE FROM execution_lease WHERE run_id=? AND token=?').run(id, token);
    }
    release(id, token) { this.db.prepare('DELETE FROM leases WHERE run_id=? AND token=?').run(id, token); }
    startChild(runId, pid) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO children VALUES(?,?,?,1)').run(id, runId, pid);
        this.event(runId, 'process.started', { processId: id, pid });
        return id;
    }
    finishChild(id) {
        this.db.prepare('UPDATE children SET active=0 WHERE id=?').run(id);
        // Paired with process.started, so a stalled command is visible in the timeline instead of inferred.
        const row = this.db.prepare('SELECT run_id,pid FROM children WHERE id=?').get(id);
        if (row)
            this.event(String(row['run_id']), 'process.finished', { processId: id, pid: Number(row['pid']) });
    }
    activeProcesses(id) {
        return this.db.prepare('SELECT pid FROM children WHERE run_id=? AND active=1').all(id)
            .map(row => ({ pid: Number(row['pid']), alive: processAlive(Number(row['pid'])) }));
    }
    recover(id, confirmed) {
        invariant(confirmed, 'CONFIRM', 'Recovery requires explicit confirmation that all previous commands are stopped');
        this.transaction(() => {
            const lease = this.db.prepare('SELECT * FROM leases WHERE run_id=?').get(id);
            if (lease) {
                invariant(lease['host'] === hostname(), 'RECOVERY', 'Cannot recover a lease from another host');
                invariant(!processAlive(Number(lease['pid'])), 'RECOVERY', 'Previous controller PID is still alive');
            }
            const execution = this.db.prepare('SELECT * FROM execution_lease WHERE run_id=?').get(id);
            if (execution) {
                invariant(execution['host'] === hostname(), 'RECOVERY', 'Execution belongs to another host');
                invariant(!processAlive(Number(execution['pid'])), 'RECOVERY', 'Previous execution controller PID is still alive');
            }
            for (const row of this.db.prepare('SELECT pid FROM children WHERE run_id=? AND active=1').all(id)) {
                invariant(!processAlive(Number(row['pid'])), 'RECOVERY', `Command PID ${row['pid']} is still alive; inspect it before recovery`);
            }
            this.db.prepare('UPDATE children SET active=0 WHERE run_id=?').run(id);
            this.db.prepare('DELETE FROM leases WHERE run_id=?').run(id);
            this.db.prepare('DELETE FROM execution_lease WHERE run_id=?').run(id);
            this.event(id, 'run.lease_recovered', { confirmedStopped: true });
        });
    }
    createDocument(kind, data) {
        const doc = { id: randomUUID(), kind, version: 0, data };
        this.transaction(() => {
            this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?)').run(doc.id, kind, 0, hash(data), JSON.stringify(data));
            this.documentEvent(doc.id, `${kind}.created`, {});
        });
        return doc;
    }
    document(id, kind) {
        const row = this.db.prepare('SELECT * FROM documents WHERE id=? AND kind=?').get(id, kind);
        invariant(row, 'NOT_FOUND', `Unknown ${kind} ${id}`);
        const data = parseJson(String(row['data']));
        invariant(hash(data) === row['digest'], 'DB_CORRUPT', 'Document digest mismatch');
        return { id, kind, version: Number(row['version']), data: data };
    }
    documents(kind) {
        return this.db.prepare('SELECT id FROM documents WHERE kind=? ORDER BY rowid DESC LIMIT 500').all(kind)
            .map(row => this.document(String(row['id']), kind));
    }
    saveDocument(doc, type, event = {}) {
        this.transaction(() => {
            const result = this.db.prepare('UPDATE documents SET version=?,digest=?,data=? WHERE id=? AND kind=? AND version=?')
                .run(doc.version + 1, hash(doc.data), JSON.stringify(doc.data), doc.id, doc.kind, doc.version);
            invariant(Number(result.changes) === 1, 'CONFLICT', 'Stale lifecycle document update refused');
            this.documentEvent(doc.id, type, event);
        });
        doc.version++;
    }
    /** Removes one lifecycle document and its own history. Refused while a lease or a live process exists. */
    deleteDocument(id, kind) {
        this.transaction(() => {
            invariant(this.db.prepare('SELECT 1 FROM documents WHERE id=? AND kind=?').get(id, kind), 'NOT_FOUND', `Unknown ${kind} ${id}`);
            invariant(!this.db.prepare('SELECT 1 FROM document_leases WHERE doc_id=?').get(id), 'LOCKED', `Document ${id} is locked by a controller`);
            for (const child of this.db.prepare('SELECT pid FROM document_children WHERE doc_id=? AND active=1').all(id))
                invariant(!processAlive(Number(child['pid'])), 'BUSY', `Role process ${child['pid']} of ${id} is still alive`);
            this.db.prepare('DELETE FROM document_children WHERE doc_id=?').run(id);
            this.db.prepare('DELETE FROM document_events WHERE doc_id=?').run(id);
            this.db.prepare('DELETE FROM documents WHERE id=? AND kind=?').run(id, kind);
        });
    }
    /** Removes one run and everything that references it. Refused while a lease or a live process exists. */
    deleteRun(id) {
        this.transaction(() => {
            invariant(this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id), 'NOT_FOUND', `Unknown run ${id}`);
            invariant(!this.db.prepare('SELECT 1 FROM leases WHERE run_id=?').get(id), 'LOCKED', `Run ${id} is locked`);
            invariant(!this.db.prepare('SELECT 1 FROM execution_lease WHERE run_id=?').get(id), 'BUSY', `Run ${id} holds the execution lease`);
            for (const child of this.db.prepare('SELECT pid FROM children WHERE run_id=? AND active=1').all(id))
                invariant(!processAlive(Number(child['pid'])), 'BUSY', `Command process ${child['pid']} of run ${id} is still alive`);
            this.db.prepare('DELETE FROM proof_cache WHERE receipt_id IN (SELECT id FROM receipts WHERE run_id=?)').run(id);
            this.db.prepare('DELETE FROM receipts WHERE run_id=?').run(id);
            this.db.prepare('DELETE FROM children WHERE run_id=?').run(id);
            this.db.prepare('DELETE FROM events WHERE run_id=?').run(id);
            this.db.prepare('DELETE FROM runs WHERE id=?').run(id);
        });
    }
    documentEvent(id, type, data) {
        this.db.prepare('INSERT INTO document_events(doc_id,at,type,data) VALUES(?,?,?,?)').run(id, Date.now(), type, JSON.stringify(data));
        try {
            this.onProgress?.('lifecycle', id, type, data);
        }
        catch { /* Progress is non-authoritative. */ }
    }
    /** Latest sequence numbers of both event streams, so a live reader starts from "now". */
    eventCursor() {
        const runs = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM events').get()['m']);
        const documents = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM document_events').get()['m']);
        return { runs, documents };
    }
    /** Events of every run and document after a cursor, oldest first, bounded. */
    eventsSince(cursor, limit = 500) {
        const runs = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(cursor.runs, limit)
            .map(row => ({ source: 'run', id: String(row['run_id']), seq: Number(row['seq']), at: Number(row['at']), type: String(row['type']), data: parseJson(String(row['data'])) }));
        const documents = this.db.prepare('SELECT * FROM document_events WHERE seq>? ORDER BY seq LIMIT ?').all(cursor.documents, limit)
            .map(row => ({ source: 'lifecycle', id: String(row['doc_id']), seq: Number(row['seq']), at: Number(row['at']), type: String(row['type']), data: parseJson(String(row['data'])) }));
        return {
            cursor: { runs: runs.at(-1)?.seq ?? cursor.runs, documents: documents.at(-1)?.seq ?? cursor.documents },
            events: [...runs, ...documents].sort((a, b) => a.at - b.at),
        };
    }
    documentEvents(id) {
        return this.db.prepare('SELECT * FROM document_events WHERE doc_id=? ORDER BY seq').all(id).map(row => ({
            seq: Number(row['seq']), at: Number(row['at']), type: String(row['type']), data: parseJson(String(row['data'])),
        }));
    }
    acquireDocument(id) {
        const token = randomUUID();
        this.transaction(() => {
            invariant(!this.db.prepare('SELECT 1 FROM document_leases WHERE doc_id=?').get(id), 'LOCKED', 'Lifecycle operation is locked; recover explicitly after stopping old processes');
            this.db.prepare('INSERT INTO document_leases VALUES(?,?,?,?)').run(id, token, process.pid, hostname());
        });
        return token;
    }
    releaseDocument(id, token) {
        this.db.prepare('DELETE FROM document_leases WHERE doc_id=? AND token=?').run(id, token);
    }
    startDocumentChild(id, pid) {
        const child = randomUUID();
        this.db.prepare('INSERT INTO document_children VALUES(?,?,?,1)').run(child, id, pid);
        this.documentEvent(id, 'process.started', { pid, child });
        return child;
    }
    finishDocumentChild(id) {
        this.db.prepare('UPDATE document_children SET active=0 WHERE id=?').run(id);
        const row = this.db.prepare('SELECT doc_id,pid FROM document_children WHERE id=?').get(id);
        if (row)
            this.documentEvent(String(row['doc_id']), 'process.finished', { pid: Number(row['pid']), child: id });
    }
    documentProcesses(id) {
        return this.db.prepare('SELECT pid FROM document_children WHERE doc_id=? AND active=1').all(id)
            .map(row => ({ pid: Number(row['pid']), alive: processAlive(Number(row['pid'])) }));
    }
    recoverDocument(id, confirmed) {
        invariant(confirmed, 'CONFIRM', 'Confirm all old controller and role processes have stopped');
        this.transaction(() => {
            const lease = this.db.prepare('SELECT * FROM document_leases WHERE doc_id=?').get(id);
            if (lease) {
                invariant(lease['host'] === hostname() && !processAlive(Number(lease['pid'])), 'RECOVERY', 'Lifecycle controller is alive or belongs to another host');
            }
            invariant(this.documentProcesses(id).every(p => !p.alive), 'RECOVERY', 'A lifecycle role process is still alive');
            this.db.prepare('UPDATE document_children SET active=0 WHERE doc_id=?').run(id);
            this.db.prepare('DELETE FROM document_leases WHERE doc_id=?').run(id);
            this.documentEvent(id, 'operation.recovered', { confirmedStopped: true });
        });
    }
    addReceipt(receipt) {
        validateReceipt(receipt);
        invariant(receipt.id.length > 0 && /^[a-f0-9]{40,64}$/.test(receipt.candidateSha) && /^[a-f0-9]{64}$/.test(receipt.key), 'RECEIPT', 'Invalid receipt identity');
        this.transaction(() => {
            this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(receipt.id, receipt.runId, JSON.stringify(receipt));
            this.event(receipt.runId, 'gate.finished', { gateId: receipt.gateId, status: receipt.status, durationMs: receipt.durationMs, receiptId: receipt.id });
        });
    }
    // Called ONLY after the entire validation workspace has passed integrity checks.
    seal(receipt, ttlMs) {
        if (ttlMs <= 0 || receipt.status !== 'passed')
            return;
        this.verifyReceipt(receipt);
        invariant(receipt.exitCode === 0, 'RECEIPT', 'Cannot cache a nonzero result');
        const expiresAt = receipt.startedAt + receipt.durationMs + ttlMs;
        this.db.prepare('INSERT INTO proof_cache VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET receipt_id=excluded.receipt_id,expires_at=excluded.expires_at,digest=excluded.digest')
            .run(receipt.key, receipt.id, Math.floor(expiresAt), hash(receipt));
    }
    verifyReceipt(receipt) {
        validateReceipt(receipt);
        const row = this.db.prepare('SELECT data FROM receipts WHERE id=?').get(receipt.id);
        invariant(row && hash(parseJson(String(row['data']))) === hash(receipt), 'RECEIPT', 'Receipt does not match the persisted runner observation');
    }
    cached(key, now = Date.now()) {
        const row = this.db.prepare('SELECT receipts.data,proof_cache.digest FROM proof_cache JOIN receipts ON receipt_id=receipts.id WHERE key=? AND expires_at>?').get(key, now);
        if (!row)
            return null;
        const receipt = validateReceipt(parseJson(String(row['data'])));
        invariant(hash(receipt) === row['digest'] && receipt.key === key && receipt.status === 'passed' && receipt.exitCode === 0, 'CACHE_CORRUPT', 'Invalid cached proof');
        return receipt;
    }
}
//# sourceMappingURL=store.js.map