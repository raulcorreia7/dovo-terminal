// A pi-tui Terminal backed by @xterm/headless: real parser, real buffer, no
// pty. Shared by the smoke scenario and probes that drive the actual TUI.

import type { Terminal } from "@earendil-works/pi-tui";
import xtermHeadless from "@xterm/headless";

const { Terminal: XtermHeadless } = xtermHeadless;

export class HeadlessTerminal implements Terminal {
    private readonly buffer = new XtermHeadless({
        cols: 84,
        rows: 24,
        allowProposedApi: true,
    });
    private onInput: ((data: string) => void) | null = null;

    start(onInput: (data: string) => void): void {
        this.onInput = onInput;
    }

    stop(): void {
        // Real pty owns the terminal; nothing to stop.
    }

    write(data: string): void {
        this.buffer.write(data);
    }

    get columns(): number {
        return this.buffer.cols;
    }

    get rows(): number {
        return this.buffer.rows;
    }

    get kittyProtocolActive(): boolean {
        return false;
    }

    moveBy(lines: number): void {
        if (lines > 0) {
            this.buffer.write(`\x1b[${lines}B`);
        } else if (lines < 0) {
            this.buffer.write(`\x1b[${-lines}A`);
        }
    }

    hideCursor(): void {
        // The real PTY manages the cursor.
    }

    showCursor(): void {
        // The real PTY manages the cursor.
    }

    clearLine(): void {
        this.buffer.write("\x1b[2K");
    }

    clearFromCursor(): void {
        this.buffer.write("\x1b[0J");
    }

    clearScreen(): void {
        this.buffer.write("\x1b[2J");
    }

    setTitle(): void {
        // The pty needs no window chrome.
    }

    setProgramStatus(): void {
        // The pty needs no window chrome.
    }

    setProgress(): void {
        // The pty needs no window chrome.
    }

    async drainInput(): Promise<void> {
        // No buffered fake input; the pty is the source.
    }

    input(data: string): void {
        this.onInput?.(data);
    }

    screen(): string[] {
        const lines: string[] = [];
        for (let i = 0; i < this.buffer.rows; i++) {
            lines.push(this.buffer.buffer.active.getLine(i)?.translateToString(true) ?? "");
        }
        return lines;
    }
}
