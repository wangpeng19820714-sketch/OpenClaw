import { describe, expect, it } from "vitest";
import { resolveUserId } from "../extensions-custom/mem0/index.ts";

describe("mem0 room-scoped long-term memory", () => {
  it("keeps direct-message long-term memory scoped to the agent", () => {
    expect(
      resolveUserId(undefined, {
        agentId: "client",
        sessionKey: "agent:client:feishu:dm:ou_123",
      }),
    ).toBe("openclaw:client");
  });

  it("stores group long-term memory inside the group namespace", () => {
    expect(
      resolveUserId(undefined, {
        agentId: "client",
        sessionKey: "agent:client:feishu:group:oc_group_chat",
      }),
    ).toBe("openclaw:room:agent:client:feishu:group:oc_group_chat");
  });

  it("collapses thread sessions back to their parent room namespace", () => {
    expect(
      resolveUserId(undefined, {
        agentId: "ops",
        sessionKey: "agent:ops:slack:channel:C123:thread:1770408518.451689",
      }),
    ).toBe("openclaw:room:agent:ops:slack:channel:c123");
  });

  it("respects an explicit config userId override", () => {
    expect(
      resolveUserId("custom-scope", {
        agentId: "client",
        sessionKey: "agent:client:feishu:group:oc_group_chat",
      }),
    ).toBe("custom-scope");
  });
});
