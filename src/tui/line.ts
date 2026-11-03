import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

/** Single styled line whose text mutates in place; renders one truncated row. */
export class LineText implements Component {
    private text: string;
    private readonly paddingX: number;

    constructor(text: string, paddingX = 1) {
        this.text = text;
        this.paddingX = paddingX;
    }

    setText(text: string): void {
        this.text = text;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const content = Math.max(0, width - this.paddingX * 2);
        return [" ".repeat(this.paddingX) + truncateToWidth(this.text, content)];
    }
}
