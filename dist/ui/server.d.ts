export interface UiOptions {
    stateDir: string;
    /** 0 picks a free port. */
    port?: number;
    /** Polling period of the live stream, in milliseconds. */
    pollMs?: number;
}
export interface UiServer {
    /** One-time entry URL carrying the access token; it is exchanged for a session cookie. */
    url: string;
    port: number;
    accessToken: string;
    close(): Promise<void>;
}
/**
 * Local dashboard of the lifecycle store: every spec, its tasks, QA, designs and live activity, plus the
 * operator actions the CLI offers. Bound to 127.0.0.1. Access requires the one-time token printed at start,
 * exchanged for an HttpOnly SameSite=Strict cookie; the Host header is checked against DNS rebinding; every
 * action additionally requires the page's CSRF token and a same-origin Origin header. Approvals name the exact
 * hash or SHA the operator saw, carry a note, and record the git identity of the repository as reviewer.
 * Long operations run as separate CLI processes that survive the dashboard.
 */
export declare function startUi(options: UiOptions): Promise<UiServer>;
