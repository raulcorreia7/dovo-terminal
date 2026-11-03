import type { Component } from "@earendil-works/pi-tui";
import { assertNever } from "dovo-terminal/protocol/errors.ts";
import type { ConversationItem } from "../protocol/workspace.ts";
import { ApprovalItem } from "./items/approval-item.ts";
import { AssistantItem } from "./items/assistant-item.ts";
import { SystemItem } from "./items/system-item.ts";
import { ToolItem } from "./items/tool-item.ts";
import { UserItem } from "./items/user-item.ts";

export { ApprovalItem } from "./items/approval-item.ts";
export { AssistantItem } from "./items/assistant-item.ts";
export { SystemItem } from "./items/system-item.ts";
export { ToolItem } from "./items/tool-item.ts";
export { UserItem } from "./items/user-item.ts";

/** Builds the cached renderer for a new conversation item. */
export function createItemView(item: ConversationItem): Component {
    switch (item.kind) {
        case "user":
            return new UserItem(item.text);
        case "assistant":
            return new AssistantItem(item.text);
        case "tool":
            return new ToolItem(item.name, item.detail, item.state);
        case "approval":
            return new ApprovalItem(item.title, item.detail, item.options);
        case "system":
            return new SystemItem(item.text);
        default:
            return assertNever(item);
    }
}
