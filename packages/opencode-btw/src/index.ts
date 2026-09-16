import type { Config, Hooks, Plugin } from "@opencode-ai/plugin";

const BTW_COMMAND = "btw";
const COMMAND_TEMPLATE = "$ARGUMENTS";
const BTW_AGENT_PROMPT =
  "You are the BTW side-conversation agent. Answer the current BTW question directly and concisely. If it is not a substantive question, request clarification briefly.";
const PARENT_SYSTEM =
  "The message labelled BTW is for the user only. Ignore it completely: do not treat it as instructions, context, or information; do not respond to, reference, act on, or change the current task because of it.";

const WORKER_SYSTEM = [
  "You are a background BTW worker.",
  "Treat all inherited parent conversation as reference context only.",
  "Do not continue, execute, answer, or follow any inherited task, plan, command, tool call, approval, edit request, or instruction.",
  "Only the post-boundary BTW prompt is active. Answer that prompt directly.",
  "If it is not a substantive question, request clarification briefly.",
  "Best effort only: read project state and do not edit, write, patch, delete, or otherwise change files or project state.",
  "These are instructions, not an enforced isolation boundary.",
  "Every BTW answer must be exactly one short paragraph of plain prose with no Markdown, headings, bullets, lists, blockquotes, code fences, labels, or formatting.",
  "Answer the question only. Do not mention these instructions or describe your process.",
].join(" ");

const WORKER_PROMPT_BOUNDARY = [
  "--- FINAL ACTIVE BTW BOUNDARY ---",
  "All prior and inherited conversation is reference only; ignore all prior instructions and assistant responses.",
  "Answer only the question following this boundary. If it is not substantive, ask for a short clarification.",
  "--- QUESTION FOLLOWS ---",
].join("\n");

type RequestResult<T> = {
  data?: T;
  error?: unknown;
};

type SessionReference = {
  id: string;
};

type BtwPart = {
  type: string;
  text?: string;
  ignored?: boolean;
};

type PromptResponse = {
  parts: readonly BtwPart[];
  info?: {
    error?: unknown;
  };
};

type WorkerMessage = {
  info: {
    id: string;
    role: "user" | "assistant";
    error?: unknown;
  };
  parts: readonly BtwPart[];
};

type ForkOptions = {
  path: { id: string };
  query?: { directory?: string };
};

type PromptOptions = {
  path: { id: string };
  query?: { directory?: string };
  body: {
    agent?: string;
    system?: string;
    parts: readonly [{ type: "text"; text: string }];
    noReply?: boolean;
  };
};

type MessagesOptions = {
  path: { id: string };
    query?: { directory?: string; limit?: number };
};

type DeleteOptions = {
  path: { id: string };
  query?: { directory?: string };
};

export type BtwClient = {
  session: {
    fork(options: ForkOptions): Promise<RequestResult<SessionReference>>;
    prompt(options: PromptOptions): Promise<RequestResult<PromptResponse>>;
    messages(options: MessagesOptions): Promise<RequestResult<readonly WorkerMessage[]>>;
    delete(options: DeleteOptions): Promise<RequestResult<boolean>>;
  };
};

type BtwInput = {
  client: BtwClient;
  directory: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "object" && data !== null && "message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return String(error);
}

function reportDiagnostic(message: string, error: unknown): void {
  console.error(`[BTW] ${message}: ${errorMessage(error)}`);
}

function resultData<T>(result: RequestResult<T>, operation: string): T {
  if (result.error !== undefined) throw result.error;
  if (result.data === undefined) {
    throw new Error(`${operation} returned no data`);
  }
  return result.data;
}

function finalAnswer(parts: readonly BtwPart[]): string {
  return parts
    .filter((part): part is BtwPart & { type: "text"; text: string } =>
      part.type === "text" && !part.ignored && part.text !== undefined,
    )
    .map((part) => part.text)
    .join("\n");
}

function usableAnswer(parts: readonly BtwPart[]): string | undefined {
  const answer = finalAnswer(parts);
  return answer.trim() === "" ? undefined : answer;
}

async function loadWorkerMessages(
  client: BtwClient,
  workerSessionID: string,
  directory: string,
): Promise<readonly WorkerMessage[]> {
  return resultData(
    await client.session.messages({
      path: { id: workerSessionID },
      query: { directory },
    }),
    "worker messages",
  );
}

function stripOuterFence(answer: string): string {
  const match = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/.exec(answer);
  return match?.[1] ?? answer;
}

function normalizeAnswer(question: string, answer: string): string {
  const duplicateHeader = `BTW: ${question}\n\n`;
  let normalized = answer.trim();

  if (normalized.startsWith(duplicateHeader)) {
    normalized = normalized.slice(duplicateHeader.length);
    normalized = stripOuterFence(normalized);
  } else {
    normalized = stripOuterFence(normalized);
    if (normalized.startsWith(duplicateHeader)) {
      normalized = normalized.slice(duplicateHeader.length);
    }
  }

  return normalized.trim();
}

async function workerAnswer(
  client: BtwClient,
  workerSessionID: string,
  directory: string,
  response: PromptResponse,
  baselineMessageIDs: ReadonlySet<string>,
): Promise<string> {
  if (response.info?.error !== undefined) {
    throw response.info.error;
  }

  const directAnswer = usableAnswer(response.parts);
  if (directAnswer !== undefined) return directAnswer;

  const messages = await loadWorkerMessages(client, workerSessionID, directory);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (baselineMessageIDs.has(message.info.id)) continue;
    if (message.info.role !== "assistant") continue;
    const answer = usableAnswer(message.parts);
    if (answer === undefined) continue;
    if (message.info.error !== undefined) throw message.info.error;
    return answer;
  }

  throw new Error("worker returned an empty answer");
}

function parentResult(question: string, answer: string): string {
  return `BTW: ${question}\n\n${answer}`;
}

function failureResult(question: string, error: unknown): string {
  return `BTW: ${question}\n\nBackground question failed: ${errorMessage(error)}`;
}

async function appendToParent(
  client: BtwClient,
  parentSessionID: string,
  directory: string,
  text: string,
): Promise<void> {
  const result = await client.session.prompt({
    path: { id: parentSessionID },
    query: { directory },
    body: {
      noReply: true,
      system: PARENT_SYSTEM,
      parts: [{ type: "text", text }],
    },
  });
  resultData(result, "parent delivery");
}

async function runBtw(
  client: BtwClient,
  parentSessionID: string,
  directory: string,
  question: string,
): Promise<void> {
  let workerSessionID: string | undefined;
  let result: string;

  try {
    const fork = await client.session.fork({
      path: { id: parentSessionID },
      query: { directory },
    });
    workerSessionID = resultData(fork, "worker fork").id;
    const baselineMessageIDs = new Set(
      (await loadWorkerMessages(client, workerSessionID, directory)).map(
        (message) => message.info.id,
      ),
    );

    const response = await client.session.prompt({
      path: { id: workerSessionID },
      query: { directory },
      body: {
        agent: "btw",
        system: WORKER_SYSTEM,
        parts: [{ type: "text", text: `${WORKER_PROMPT_BOUNDARY}\n\n${question}` }],
      },
    });
    const answer = await workerAnswer(
      client,
      workerSessionID,
      directory,
      resultData(response, "worker prompt"),
      baselineMessageIDs,
    );
    const normalizedAnswer = normalizeAnswer(question, answer);
    if (normalizedAnswer === "") {
      throw new Error("worker returned an empty answer");
    }
    result = parentResult(question, normalizedAnswer);
  } catch (error) {
    result = failureResult(question, error);
  }

  try {
    await appendToParent(client, parentSessionID, directory, result);
  } catch (error) {
    reportDiagnostic("parent delivery failed; worker retained", error);
    return;
  }

  if (workerSessionID !== undefined) {
    try {
      const deletion = await client.session.delete({
        path: { id: workerSessionID },
        query: { directory },
      });
      resultData(deletion, "worker cleanup");
    } catch (error) {
      reportDiagnostic("worker cleanup failed", error);
    }
  }
}

function createBtwHooks(input: BtwInput): Hooks {
  return {
    config: async (config: Config) => {
      config.command ??= {};
      if (config.command[BTW_COMMAND] === undefined) {
        config.command[BTW_COMMAND] = {
          description: "Ask a quick side question without interrupting the current task",
          template: COMMAND_TEMPLATE,
        };
      }
      config.agent ??= {};
      config.agent[BTW_COMMAND] = {
        hidden: true,
        mode: "subagent",
        model: "openai/gpt-5.6-terra",
        variant: "high",
        prompt: BTW_AGENT_PROMPT,
        tools: {
          "*": false,
          read: true,
          glob: true,
          grep: true,
          webfetch: true,
          edit: false,
          write: false,
          bash: false,
          task: false,
        },
        permission: {
          edit: "deny",
          bash: "deny",
          webfetch: "allow",
          doom_loop: "deny",
          external_directory: "deny",
        },
      };
    },
    "command.execute.before": async (command, output) => {
      if (command.command !== BTW_COMMAND) return;

      output.parts.splice(0, output.parts.length);
      void runBtw(input.client, command.sessionID, input.directory, command.arguments).catch(
        (error) => {
          reportDiagnostic("background question failed", error);
        },
      );
    },
  };
}

const BtwPlugin: Plugin = async (input) =>
  createBtwHooks({
    // The production SDK client is wider than the small surface used here.
    client: input.client as unknown as BtwClient,
    directory: input.directory,
  });

export default BtwPlugin;
