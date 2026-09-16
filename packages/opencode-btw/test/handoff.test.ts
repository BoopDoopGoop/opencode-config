import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import {
  HANDOFF_PLAN_TTL_MS,
  captureHandoffContext,
  createHandoffTools,
  isAllowedHelperPath,
  validateDestination,
  validateReceiveID,
} from "../src/handoff";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "session-current",
    directory: "/workspace/project",
    worktree: "/workspace",
    messageID: "message-current",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    ...overrides,
  };
}

function output(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "output" in result) {
    return String((result as { output: unknown }).output);
  }
  throw new Error("expected a tool result");
}

describe("handoff protocol", () => {
  test("captures the exact OpenCode session context", () => {
    const captured = captureHandoffContext({
      sessionID: "session exact",
      directory: "/tmp/project with spaces",
      worktree: "/tmp/worktree",
    });

    expect(captured).toEqual({
      sessionID: "session exact",
      directory: "/tmp/project with spaces",
      worktree: "/tmp/worktree",
    });
  });

  test("requires the matching destination", () => {
    expect(validateDestination("local-to-cloud", "cloud")).toBe("cloud");
    expect(validateDestination("cloud-to-local", "local")).toBe("local");
    expect(() => validateDestination("local-to-cloud", "local")).toThrow(
      "destination must be cloud",
    );
  });

  test("requires confirmation and expires plans", async () => {
    let now = 10_000;
    const calls: string[][] = [];
    const handoff = createHandoffTools({
      helperPath: "/usr/local/bin/oc-handoff",
      now: () => now,
      createID: (() => {
        const ids = [PLAN_ID, TOKEN];
        return () => ids.shift() ?? PLAN_ID;
      })(),
      runHelper: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "planned", stderr: "" };
      },
    });

    const planResult = await handoff.tools.handoff_plan.execute(
      { direction: "local-to-cloud", destination: "cloud" },
      context(),
    );
    expect(output(planResult)).toContain(`Plan ID: ${PLAN_ID}`);
    expect(output(planResult)).toContain(`Confirmation token: ${TOKEN}`);
    expect(calls).toHaveLength(0);

    await expect(
      handoff.tools.handoff_execute.execute(
        { planId: PLAN_ID, confirmationToken: PLAN_ID },
        context(),
      ),
    ).rejects.toThrow("confirmation token does not match");

    now += HANDOFF_PLAN_TTL_MS;
    await expect(
      handoff.tools.handoff_execute.execute(
        { planId: PLAN_ID, confirmationToken: TOKEN },
        context(),
      ),
    ).rejects.toThrow("handoff plan has expired");
    expect(calls).toHaveLength(0);
  });

  test("executes the documented helper protocol only after confirmation", async () => {
    const calls: string[][] = [];
    const handoff = createHandoffTools({
      helperPath: "/usr/local/bin/oc-handoff",
      createID: (() => {
        const ids = [PLAN_ID, TOKEN];
        return () => ids.shift() ?? PLAN_ID;
      })(),
      runHelper: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "Handoff created: oc-123", stderr: "" };
      },
    });

    await handoff.tools.handoff_plan.execute(
      { direction: "local-to-cloud", destination: "cloud" },
      context(),
    );
    const result = await handoff.tools.handoff_execute.execute(
      { planId: PLAN_ID, confirmationToken: TOKEN },
      context(),
    );

    expect(output(result)).toContain("completed without a reported error");
    expect(calls).toEqual([[
      "cloud",
      "session-current",
      "--source",
      "/workspace",
      "--destination",
      "/home/developer/workspace/intangibility",
    ]]);
  });

  test("supports cloud-to-local through the helper receive protocol", async () => {
    const calls: string[][] = [];
    const handoff = createHandoffTools({
      helperPath: "/usr/local/bin/oc-handoff",
      createID: (() => {
        const ids = [PLAN_ID, TOKEN];
        return () => ids.shift() ?? PLAN_ID;
      })(),
      runHelper: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "received", stderr: "" };
      },
    });

    await handoff.tools.handoff_plan.execute(
      { direction: "cloud-to-local", destination: "local", handoffId: "oc-123" },
      context(),
    );
    await handoff.tools.handoff_execute.execute(
      { planId: PLAN_ID, confirmationToken: TOKEN },
      context(),
    );

    expect(calls).toEqual([["receive", "oc-123", "--output", "/workspace/project"]]);
  });

  test("passes runtime paths as safe argv values, never a shell command", async () => {
    const calls: string[][] = [];
    const handoff = createHandoffTools({
      helperPath: "/opt/homebrew/bin/oc-handoff",
      createID: (() => {
        const ids = [PLAN_ID, TOKEN];
        return () => ids.shift() ?? PLAN_ID;
      })(),
      runHelper: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const unsafeLookingContext = context({
      directory: "/workspace/project; touch SHOULD_NOT_EXIST",
      worktree: "/workspace && reset --hard",
    });

    await handoff.tools.handoff_plan.execute(
      { direction: "local-to-cloud", destination: "cloud" },
      unsafeLookingContext,
    );
    await handoff.tools.handoff_execute.execute(
      { planId: PLAN_ID, confirmationToken: TOKEN },
      unsafeLookingContext,
    );

    expect(calls[0]).toContain("/workspace && reset --hard");
    expect(calls[0]?.join(" ")).not.toContain('"; touch SHOULD_NOT_EXIST"');
    await expect(handoff.receive("remote-id;rm -rf /")).rejects.toThrow(
      "receive id must be one safe token",
    );
    expect(isAllowedHelperPath("oc-handoff")).toBe(false);
    expect(isAllowedHelperPath("/opt/homebrew/bin/oc-handoff")).toBe(true);
  });

  test("refuses child sessions before invoking the helper", async () => {
    let called = false;
    const handoff = createHandoffTools({
      helperPath: "/usr/local/bin/oc-handoff",
      client: {
        session: {
          async get() {
            return { data: { parentID: "root-session" } };
          },
        },
      },
      runHelper: async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      handoff.tools.handoff_plan.execute(
        { direction: "local-to-cloud", destination: "cloud" },
        context(),
      ),
    ).rejects.toThrow("child session");
    expect(called).toBe(false);
  });

  test("does not report helper failure as a successful transfer", async () => {
    const handoff = createHandoffTools({
      helperPath: "/usr/local/bin/oc-handoff",
      createID: (() => {
        const ids = [PLAN_ID, TOKEN];
        return () => ids.shift() ?? PLAN_ID;
      })(),
      runHelper: async () => ({ exitCode: 23, stdout: "", stderr: "not available" }),
    });

    await handoff.tools.handoff_plan.execute(
      { direction: "local-to-cloud", destination: "cloud" },
      context(),
    );
    const result = await handoff.tools.handoff_execute.execute(
      { planId: PLAN_ID, confirmationToken: TOKEN },
      context(),
    );
    expect(output(result)).toContain("no transfer was reported as complete");
    expect(output(result)).toContain("Session ID: session-current");
  });

  test("validates receive IDs before helper invocation", () => {
    expect(validateReceiveID("abc-123._:ok")).toBe("abc-123._:ok");
    expect(() => validateReceiveID("../escape")).toThrow();
  });
});
