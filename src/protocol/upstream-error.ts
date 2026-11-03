/** An upstream answered with a non-2xx status; the local server maps it onward. */
export class UpstreamError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "UpstreamError";
        this.status = status;
    }
}
