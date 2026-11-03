import { type Component, Text } from "@earendil-works/pi-tui";
import { colors, t } from "../theme.ts";

const roleUser = t(" you ", colors.user, { bold: true });

export class UserItem implements Component {
    private text: string;
    constructor(text: string) {
        this.text = text;
    }
    setText(text: string): void {
        this.text = text;
    }
    invalidate(): void {}
    render(width: number): string[] {
        return new Text(`${roleUser} ${this.text}`, 1, 0).render(width);
    }
}
