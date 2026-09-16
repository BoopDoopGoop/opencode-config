import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin/tool";

const execFileAsync = promisify(execFile);

export const HANDOFF_PLAN_COMMAND = "handoff_plan";
export const HANDOFF_EXECUTE_COMMAND = "handoff_execute";
export const HANDOFF_RECEIVE_COMMAND = "handoff_receive";
export const HANDOFF_PLAN_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_PROTOCOL_VERSION = "1";

// The helper is deliberately not resolved through PATH. These are the only
// locations from which this plugin will ever execute a handoff helper.
export const ALLOWED_HELPER_PATHS = [
  "/usr/local/bin/oc-handoff",
  "/opt/homebrew/bin/oc-handoff",
] as const;
export const DEFAULT_HELPER_PATH = ALLOWED_HELPER_PATHS[0];
export const CLOUD_REPOSITORY_DESTINATION = "/home/developer/workspace/intangibility";

const PLAN_ID_PATTERN = /^[a-f0-9-]{36}$/;
const CONFIRMATION_TOKEN_PATTERN = /^[a-f0-9-]{36}$/;
const RECEIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type HandoffDirection = "local-to-cloud" | "cloud-to-local";
export type HandoffDestination = "local" | "cloud";

export type HandoffContext = {
  sessionID: string;
  directory: string;
  worktree: string;
};

export type HandoffPlan = HandoffContext & {
  direction: HandoffDirection;
  destination: HandoffDestination;
  handoffID?: string;
  planID: string;
  confirmationToken: string;
  expiresAt: number;
};

export type HelperResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type HelperRunner = (
  args: readonly string[],
) => Promise<HelperResult>;

export type HandoffClient = {
  session?: {
    get?: (options: {
      path: { id: string };
      query?: { directory?: string };
    }) => Promise<{ data?: { parentID?: string }; error?: unknown }>;
  };
};

type HandoffOptions = {
  helperPath?: string;
  runHelper?: HelperRunner;
  now?: () => number;
  createID?: () => string;
  client?: HandoffClient;
};

type HandoffToolArgs = {
  direction: HandoffDirection;
  destination: HandoffDestination;
  handoffId?: string;
};

type HandoffExecuteArgs = {
  planId: string;
  confirmationToken: string;
};

type TextPart = { type: "text"; text: string };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function isAllowedHelperPath(helperPath: string): boolean {
  return isAbsolute(helperPath) &&
    (ALLOWED_HELPER_PATHS as readonly string[]).includes(helperPath);
}

export function resolveHelperPath(helperPath?: string): string {
  const selected = helperPath ?? process.env.OC_HANDOFF_HELPER_PATH ?? DEFAULT_HELPER_PATH;
  if (!isAllowedHelperPath(selected)) {
    throw new Error(
      `oc-handoff helper path is not allowlisted: ${selected}. ` +
        `Use ${ALLOWED_HELPER_PATHS.join(" or ")}.`,
    );
  }
  return selected;
}

export function captureHandoffContext(
  context: Pick<ToolContext, "sessionID" | "directory" | "worktree">,
): HandoffContext {
  if (context.sessionID.trim() === "") throw new Error("sessionID is required");
  if (context.directory.trim() === "") throw new Error("directory is required");
  if (context.worktree.trim() === "") throw new Error("worktree is required");
  return {
    sessionID: context.sessionID,
    directory: context.directory,
    worktree: context.worktree,
  };
}

export function validateDestination(
  direction: HandoffDirection,
  destination: HandoffDestination,
): HandoffDestination {
  const expected = direction === "local-to-cloud" ? "cloud" : "local";
  if (destination !== expected) {
    throw new Error(
      `destination must be ${expected} for ${direction}; got ${destination}`,
    );
  }
  return destination;
}

export function validateReceiveID(id: string): string {
  if (!RECEIVE_ID_PATTERN.test(id)) {
    throw new Error("receive id must be one safe token (letters, numbers, ., _, :, or -)");
  }
  return id;
}

function validatePlanID(id: string): string {
  if (!PLAN_ID_PATTERN.test(id)) throw new Error("invalid handoff plan ID");
  return id;
}

function validateConfirmationToken(token: string): string {
  if (!CONFIRMATION_TOKEN_PATTERN.test(token)) {
    throw new Error("invalid handoff confirmation token");
  }
  return token;
}

async function defaultRunHelper(
  helperPath: string,
  args: readonly string[],
): Promise<HelperResult> {
  try {
    const result = await execFileAsync(helperPath, [...args], {
      shell: false,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? errorText(error)),
    };
  }
}

function helperArgs(plan: HandoffPlan): string[] {
  if (plan.direction === "local-to-cloud") {
    // This is the v1 protocol implemented by the external helper. The plan
    // ID and token remain plugin-local confirmation material and are not
    // invented CLI options sent to an older helper.
    return [
      "cloud",
      plan.sessionID,
      "--source",
      plan.worktree,
      "--destination",
      CLOUD_REPOSITORY_DESTINATION,
    ];
  }

  if (plan.handoffID === undefined) {
    throw new Error("cloud-to-local handoffs require the external handoff ID");
  }
  return ["receive", plan.handoffID, "--output", plan.directory];
}

function contextText(context: HandoffContext): string {
  return [
    `Session ID: ${context.sessionID}`,
    `Directory: ${context.directory}`,
    `Worktree: ${context.worktree}`,
  ].join("\n");
}

function helperText(result: HelperResult): string {
  return [result.stdout.trim(), result.stderr.trim()]
    .filter((value) => value !== "")
    .join("\n")
    .trim();
}

function resultText(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { title: "OpenCode handoff", output, metadata };
}

async function rejectChildSession(
  client: HandoffClient | undefined,
  context: HandoffContext,
): Promise<void> {
  const getSession = client?.session?.get;
  if (getSession === undefined) return;
  const result = await getSession({
    path: { id: context.sessionID },
    query: { directory: context.directory },
  });
  if (result.error !== undefined) throw new Error(`could not inspect session: ${errorText(result.error)}`);
  if (result.data?.parentID !== undefined) {
    throw new Error("refusing handoff for a child session; run it from the root session");
  }
}

function formatFailure(
  operation: string,
  plan: HandoffPlan,
  result: HelperResult,
  helperPath: string,
): string {
  const detail = helperText(result);
  return [
    `oc-handoff ${operation} failed (exit ${result.exitCode}); no transfer was reported as complete.`,
    contextText(plan),
    `Helper: ${helperPath}`,
    detail === "" ? "The helper returned no diagnostic output." : detail,
  ].join("\n");
}

export function createHandoffTools(options: HandoffOptions = {}) {
  const helperPath = resolveHelperPath(options.helperPath);
  const runHelper = options.runHelper ?? ((args) => defaultRunHelper(helperPath, args));
  const now = options.now ?? (() => Date.now());
  const createID = options.createID ?? randomUUID;
  const plans = new Map<string, HandoffPlan>();

  const plan = async (
    args: HandoffToolArgs,
    context: HandoffContext,
  ): Promise<ToolResult> => {
    validateDestination(args.direction, args.destination);
    const handoffID = args.direction === "cloud-to-local"
      ? validateReceiveID(args.handoffId ?? "")
      : args.handoffId === undefined
        ? undefined
        : validateReceiveID(args.handoffId);
    if (args.direction === "local-to-cloud" && args.handoffId !== undefined) {
      throw new Error("local-to-cloud plans must not include an external handoff ID");
    }
    await rejectChildSession(options.client, context);
    const createdAt = now();
    const handoffPlan: HandoffPlan = {
      ...context,
      direction: args.direction,
      destination: args.destination,
      handoffID,
      planID: createID(),
      confirmationToken: createID(),
      expiresAt: createdAt + HANDOFF_PLAN_TTL_MS,
    };
    validatePlanID(handoffPlan.planID);
    validateConfirmationToken(handoffPlan.confirmationToken);

    // Planning is intentionally local-only. It records no transport result
    // and cannot claim that a transfer happened; only execute invokes the
    // external helper's documented v1 command.
    plans.set(handoffPlan.planID, handoffPlan);
    return resultText([
      "Handoff plan created; no transfer has been executed.",
      contextText(context),
      `Direction: ${handoffPlan.direction}`,
      `Destination: ${handoffPlan.destination}`,
      ...(handoffPlan.handoffID === undefined ? [] : [`External handoff ID: ${handoffPlan.handoffID}`]),
      `Plan ID: ${handoffPlan.planID}`,
      `Confirmation token: ${handoffPlan.confirmationToken}`,
      `Expires: ${new Date(handoffPlan.expiresAt).toISOString()}`,
      `Helper: ${helperPath}`,
      "The external helper will be called only after explicit confirmation.",
      "Call handoff_execute with this plan ID and confirmation token after reviewing it.",
    ].filter((line) => line !== "").join("\n"), {
      sessionID: context.sessionID,
      directory: context.directory,
      worktree: context.worktree,
      planID: handoffPlan.planID,
      expiresAt: handoffPlan.expiresAt,
      executable: true,
    });
  };

  const execute = async (
    args: HandoffExecuteArgs,
    context: HandoffContext,
  ): Promise<ToolResult> => {
    const planID = validatePlanID(args.planId);
    const confirmationToken = validateConfirmationToken(args.confirmationToken);
    const handoffPlan = plans.get(planID);
    if (handoffPlan === undefined) {
      throw new Error("handoff plan is unknown, already used, or created by another plugin instance");
    }
    if (now() >= handoffPlan.expiresAt) {
      plans.delete(planID);
      throw new Error("handoff plan has expired; create a new plan");
    }
    if (handoffPlan.confirmationToken !== confirmationToken) {
      throw new Error("confirmation token does not match the handoff plan");
    }
    if (
      context.sessionID !== handoffPlan.sessionID ||
      context.directory !== handoffPlan.directory ||
      context.worktree !== handoffPlan.worktree
    ) {
      throw new Error("current session context does not match the planned session context");
    }
    await rejectChildSession(options.client, context);

    // A plan is single-use. Delete it before invoking the external helper so
    // retries cannot accidentally repeat a transfer after an ambiguous exit.
    plans.delete(planID);
    const result = await runHelper(helperArgs(handoffPlan));
    if (result.exitCode !== 0) {
      return resultText(formatFailure("execute", handoffPlan, result, helperPath), {
        sessionID: context.sessionID,
        directory: context.directory,
        worktree: context.worktree,
        planID,
        executable: false,
      });
    }
    return resultText([
      "oc-handoff execute completed without a reported error.",
      contextText(context),
      `Plan ID: ${planID}`,
      `Helper: ${helperPath}`,
      helperText(result),
      "Verify the destination before continuing. This plugin does not commit, stash, reset, or otherwise alter git state.",
    ].filter((line) => line !== "").join("\n"), {
      sessionID: context.sessionID,
      directory: context.directory,
      worktree: context.worktree,
      planID,
      executable: false,
    });
  };

  const receive = async (id: string, outputDirectory?: string): Promise<string> => {
    const safeID = validateReceiveID(id);
    const args = outputDirectory === undefined
      ? ["receive", safeID]
      : ["receive", safeID, "--output", outputDirectory];
    const result = await runHelper(args);
    if (result.exitCode !== 0) {
      return [
        `oc-handoff receive failed (exit ${result.exitCode}); no receive was reported as complete.`,
        helperText(result),
      ].filter((line) => line !== "").join("\n");
    }
    return ["oc-handoff receive completed without a reported error.", helperText(result)]
      .filter((line) => line !== "").join("\n");
  };

  const tools = {
    handoff_plan: tool({
      description:
        "Create a short-lived, reviewable local/cloud handoff plan for the current session. It never transfers data by itself.",
      args: {
        direction: tool.schema.enum(["local-to-cloud", "cloud-to-local"]),
        destination: tool.schema.enum(["local", "cloud"]),
        handoffId: tool.schema.string().regex(RECEIVE_ID_PATTERN).optional(),
      },
      execute: async (args, context) =>
        plan(args, captureHandoffContext(context)),
    }),
    handoff_execute: tool({
      description:
        "Execute exactly one previously created handoff plan after presenting its confirmation token. The plan must be unexpired and match this session.",
      args: {
        planId: tool.schema.string().regex(PLAN_ID_PATTERN),
        confirmationToken: tool.schema.string().regex(CONFIRMATION_TOKEN_PATTERN),
      },
      execute: async (args, context) =>
        execute(args, captureHandoffContext(context)),
    }),
  };

  return { tools, plan, execute, receive };
}

function commandParts(text: string): TextPart[] {
  return [{ type: "text", text }];
}

function parseCommandTokens(argumentsText: string, count: number): string[] {
  const tokens = argumentsText.trim() === "" ? [] : argumentsText.trim().split(/\s+/u);
  if (tokens.length !== count) throw new Error(`expected ${count} safe argument${count === 1 ? "" : "s"}`);
  return tokens;
}

export function createHandoffHooks(input: PluginInput): Hooks {
  const handoff = createHandoffTools({
    client: input.client as unknown as HandoffClient,
  });
  const command = async (
    commandInput: { command: string; sessionID: string; arguments: string },
    output: { parts: unknown[] },
  ): Promise<void> => {
    if (
      commandInput.command !== HANDOFF_PLAN_COMMAND &&
      commandInput.command !== HANDOFF_EXECUTE_COMMAND &&
      commandInput.command !== HANDOFF_RECEIVE_COMMAND
    ) return;

    output.parts.splice(0, output.parts.length);
    try {
      if (commandInput.command === HANDOFF_RECEIVE_COMMAND) {
        const [id] = parseCommandTokens(commandInput.arguments, 1);
        output.parts.push(...commandParts(await handoff.receive(id ?? "", input.directory)));
        return;
      }

      const context = captureHandoffContext({
        sessionID: commandInput.sessionID,
        directory: input.directory,
        worktree: input.worktree,
      });
      if (commandInput.command === HANDOFF_PLAN_COMMAND) {
        const planTokens = commandInput.arguments.trim() === ""
          ? []
          : commandInput.arguments.trim().split(/\s+/u);
        if (planTokens.length < 1 || planTokens.length > 2) {
          throw new Error("expected destination and, for cloud-to-local, one external handoff ID");
        }
        const destination = planTokens[0];
        const checkedDestination = destination as HandoffDestination;
        const direction: HandoffDirection = checkedDestination === "cloud"
          ? "local-to-cloud"
          : "cloud-to-local";
        const handoffId = planTokens[1];
        if (direction === "local-to-cloud" && handoffId !== undefined) {
          throw new Error("local-to-cloud plans accept only the cloud destination");
        }
        if (direction === "cloud-to-local" && handoffId === undefined) {
          throw new Error("cloud-to-local plans require an external handoff ID");
        }
        const result = await handoff.plan({ direction, destination: checkedDestination, handoffId }, context);
        output.parts.push(...commandParts(typeof result === "string" ? result : result.output));
        return;
      }

      const [planId, confirmationToken] = parseCommandTokens(commandInput.arguments, 2);
      const result = await handoff.execute(
        { planId: planId ?? "", confirmationToken: confirmationToken ?? "" },
        context,
      );
      output.parts.push(...commandParts(typeof result === "string" ? result : result.output));
    } catch (error) {
      output.parts.push(...commandParts(`Handoff refused: ${errorText(error)}`));
    }
  };

  return {
    tool: handoff.tools,
    config: async (config) => {
      config.command ??= {};
      config.command[HANDOFF_PLAN_COMMAND] ??= {
        description: "Create a reviewable local/cloud handoff plan",
        template: "$ARGUMENTS",
      };
      config.command[HANDOFF_EXECUTE_COMMAND] ??= {
        description: "Execute a handoff plan with its confirmation token",
        template: "$ARGUMENTS",
      };
      config.command[HANDOFF_RECEIVE_COMMAND] ??= {
        description: "Receive a handoff by ID using the external oc-handoff helper",
        template: "$ARGUMENTS",
      };
    },
    "command.execute.before": command as Hooks["command.execute.before"],
  };
}
