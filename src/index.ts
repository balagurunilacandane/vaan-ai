// The agent runtime. Everything that knows about everything else lives here,
// so the pieces underneath don't have to know about each other.
//
// The shape worth noticing is which way the arrows point. The runtime builds
// the policy, the gate and the trace, and hands tools a context that can *ask*
// for permission. It never hands them the thing that answers. The approver is a
// function the CLI closed over a terminal, and it stays in this file's closure
// — that is the mechanical reason the model cannot approve its own actions,
// rather than an instruction somewhere asking it not to.
//
// This is internal. Vaan ships as an agent, not a library — package.json
// exports nothing but itself, so importing "vaan" fails cleanly rather than
// half-working against interfaces that are still moving.

import { continueAgent, type AgentEvent, type AgentResult } from "./agent.js";
import { defaultConfig, type Config } from "./config.js";
import { noMemory, type Memory } from "./memory/index.js";
import { needsMemory } from "./memory/context.js";
import { openMemory } from "./memory/store.js";
import { newRequest, type RequestContext } from "./observability/request.js";
import { openTrace, type StoredTrace, type Trace } from "./observability/trace.js";
import { approveAll, createGate, denyAll, type Approver, type Gate } from "./permissions/approval.js";
import { createPolicy, type Policy } from "./permissions/policy.js";
import { home } from "./paths.js";
import { buildSystemPrompt, loadPersona } from "./prompt.js";
import { resolve, type Env } from "./providers/index.js";
import { loadSkills } from "./skills.js";
import { builtinTools } from "./tools/index.js";
import type { SearchProvider } from "./tools/web.js";
import { scrubEnv } from "./sandbox/process.js";
import type { Message, Provider, Tool, ToolContext, Usage } from "./types.js";

/** Rough cap on in-process history, trimmed whole rounds at a time. */
const MAX_HISTORY = 40;

export interface SessionOptions {
  workspace: string;
  /** A `provider/model` string, e.g. "anthropic/claude-opus-4-8". */
  model: string;
  config?: Config;
  memory?: boolean;
  /** Approve everything without asking. The `--yes` flag, and the eval runner. */
  yes?: boolean;
  env?: Env & NodeJS.ProcessEnv;
  search?: SearchProvider;
  /** Show a diff and wait. Distinct from `approve`: what, not whether. */
  confirm?: (message: string) => Promise<boolean>;
  /** Asks the human for permission. Absent means nobody is there, so: no. */
  approve?: Approver;
  /** Write traces to .vaan/traces. Off for evals and unit tests. */
  trace?: boolean;
  /** Read the model's reply incrementally. The REPL does. */
  stream?: boolean;
}

export interface AskHandlers {
  onEvent?: (event: AgentEvent) => void;
  /** Fires with the gate's verdict, so the REPL can show that it skipped a lookup. */
  onRecall?: (used: boolean) => void;
  /** Fires as soon as the request has an id, before any model call. */
  onRequest?: (request: RequestContext) => void;
  signal?: AbortSignal;
}

export interface AskResult extends AgentResult {
  requestId: string;
  trace: StoredTrace;
}

export interface Session {
  readonly model: string;
  readonly provider: Provider;
  readonly memory: Memory;
  readonly tools: Tool[];
  readonly config: Config;
  readonly policy: Policy;
  /** Running token total for this session, across every request. */
  readonly usage: Usage;
  /** Non-fatal setup notes: an oversized SOUL.md, too many skills. */
  readonly warnings: string[];
  ask(input: string, handlers?: AskHandlers): Promise<AskResult>;
  /** Forget the in-process transcript. `/new`. Stored memory is untouched. */
  reset(): void;
  close(): void;
}

export function createSession(opts: SessionOptions): Session {
  const env = opts.env ?? process.env;
  const workspace = opts.workspace;
  const config = opts.config ?? defaultConfig(workspace, opts.model);
  const { provider, model } = resolve(opts.model, env);

  const memoryOn = opts.memory ?? config.memory;
  const memory = memoryOn ? openMemory({ dir: workspace }) : noMemory;
  const persona = loadPersona(workspace);
  const { skills, warnings: skillWarnings } = loadSkills(workspace);

  const policy = createPolicy({ workspace, approvals: config.approvals });

  // The gate lives for the session so that "yes, run npm test" holds for the
  // session. The trace it writes to changes every request, hence the accessor.
  let current: Trace | undefined;
  const gate: Gate = createGate({
    policy,
    approve: opts.yes ? approveAll : (opts.approve ?? denyAll),
    trace: () => current,
    memoise: !config.sandbox.confirmEveryCommand,
  });

  const tools = builtinTools({
    groups: config.tools,
    ...(opts.search ? { search: opts.search } : {}),
  });
  // Credentials are stripped once, here, rather than at each spawn: the child
  // environment is a property of the session, not of the command.
  const childEnv = scrubEnv(env);

  // The retrieval gate runs on every turn, so it's worth pointing at something
  // cheap. Unrelated to the permission gate, which shares nothing but the word.
  const recallModel = env.VAAN_GATE_MODEL ? resolve(env.VAAN_GATE_MODEL, env) : { provider, model };

  let history: Message[] = [];
  const usage: Usage = { input: 0, output: 0 };

  return {
    model: opts.model,
    provider,
    memory,
    tools,
    config,
    policy,
    usage,
    warnings: [...persona.warnings, ...skillWarnings],

    async ask(input, handlers = {}): Promise<AskResult> {
      const request = newRequest(input, opts.model, workspace);
      handlers.onRequest?.(request);

      // Events are always collected — the eval graders read them — but only
      // written to disk when tracing is on.
      const trace = openTrace({
        home: home(workspace),
        request,
        persist: opts.trace !== false,
      });
      current = trace;

      const ctx: ToolContext = {
        workspace,
        gate,
        policy,
        trace,
        network: config.network,
        confirm: opts.yes ? async () => true : (opts.confirm ?? (async () => false)),
        remember: async (fact) =>
          memory.remember(workspace, { kind: "fact", text: fact, source: "tool" }),
        env: childEnv,
        ...(handlers.signal ? { signal: handlers.signal } : {}),
      };

      try {
        const wanted = await needsMemory(input, {
          provider: recallModel.provider,
          model: recallModel.model,
          ...(handlers.signal ? { signal: handlers.signal } : {}),
        });
        handlers.onRecall?.(wanted);
        trace.record({
          kind: "memory",
          op: wanted ? "recall" : "skipped",
          detail: wanted ? input : "the question stands on its own",
        });

        // Facts come back either way — they're injected, not searched, and the
        // gate only decides whether to spend a query on past turns.
        const recalled = await memory.recall(workspace, wanted ? input : "");
        const system = buildSystemPrompt({
          workspace,
          agentName: config.agentName,
          persona,
          facts: recalled.facts,
          turns: wanted ? recalled.turns : [],
          skills,
          toolNames: tools.map((tool) => tool.name),
        });

        history = trim([
          ...history,
          { role: "user", parts: [{ type: "text", text: input }] } satisfies Message,
        ]);

        const result = await continueAgent(history, {
          provider,
          model,
          system,
          tools,
          ctx,
          trace,
          ...(opts.stream ? { stream: true } : {}),
          ...(handlers.onEvent ? { onEvent: handlers.onEvent } : {}),
          ...(handlers.signal ? { signal: handlers.signal } : {}),
        });
        history = result.messages;

        if (result.usage) {
          usage.input += result.usage.input;
          usage.output += result.usage.output;
        }

        await memory.remember(workspace, {
          kind: "turn",
          userText: input,
          replyText: result.text,
          tools: result.usedTools,
        });

        const stored = trace.finish(true, result.text);
        return { ...result, requestId: request.id, trace: stored };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        trace.record({ kind: "error", where: "runtime", message: detail });
        trace.finish(false, detail);
        throw err;
      } finally {
        current = undefined;
      }
    },

    reset() {
      history = [];
    },

    close() {
      memory.close?.();
    },
  };
}

/**
 * Keep the transcript from growing without limit, dropping whole rounds from
 * the front. Trimming at an arbitrary index would orphan a tool_result from its
 * tool_call, which providers reject — so cuts only happen at a plain user turn.
 */
function trim(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY) return messages;
  for (let index = messages.length - MAX_HISTORY; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user" && message.parts.every((part) => part.type === "text")) {
      return messages.slice(index);
    }
  }
  return messages;
}

export type { AgentEvent, AgentResult };
