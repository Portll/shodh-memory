#!/usr/bin/env node
/**
 * A deterministic OpenAI-compatible model endpoint, for exercising the seat
 * harness end-to-end without a real model.
 *
 * Why this exists: the harness's plumbing — streaming, tool calls, the memory
 * tools, both learning loops, the ledger, persistence — is exactly the part
 * that must be verified before a demo, and none of it depends on model
 * intelligence. The seat's local providers (Ollama / LM Studio / vLLM) all
 * speak this API against a configurable baseUrl, so pointing
 * LMSTUDIO_BASE_URL at this process runs the REAL harness code path with a
 * model whose behaviour is scripted and assertable.
 *
 * Behaviour per /chat/completions call, decided by the conversation tail:
 *   - If the last message is a tool result: stream a text answer that cites
 *     the first `[mem:xxxxxxxx]` short-id present in that result (the seat's
 *     citation contract), or says plainly that nothing surfaced.
 *   - Otherwise: emit a `recall_memory` tool call whose query is the last
 *     user message. This drives the seat's full tool round-trip.
 *
 * Every response carries usage numbers so the usage/billing pipeline runs.
 * Nothing here is random; same input, same output, always.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.FIXTURE_PORT ?? 3210);
const MODEL_ID = "fixture-deterministic-v1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** SSE chunk in OpenAI streaming format. */
function chunk(res, delta, finishReason = null) {
  const payload = {
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function usageChunk(res, promptTokens, completionTokens) {
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })}\n\n`,
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const body = JSON.parse((await readBody(req)) || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1] ?? {};
    const promptTokens = Math.max(1, Math.round(JSON.stringify(messages).length / 4));

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const isToolResult = last.role === "tool";
    if (isToolResult) {
      const content =
        typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
      const cite = /\[mem:[0-9a-f]{8}\]/.exec(content)?.[0];
      const text = cite
        ? `Based on recalled memory ${cite}, the retrieved evidence answers the question directly.`
        : "Recall returned nothing for that cue; no memory supports an answer.";
      chunk(res, { role: "assistant" });
      for (const word of text.split(/(?<= )/)) chunk(res, { content: word });
      chunk(res, {}, "stop");
      usageChunk(res, promptTokens, Math.round(text.length / 4));
    } else {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const query = String(
        typeof lastUser?.content === "string" ? lastUser.content : "context",
      ).slice(0, 120);
      chunk(res, { role: "assistant" });
      chunk(res, {
        tool_calls: [
          {
            index: 0,
            id: "call_fixture_1",
            type: "function",
            function: { name: "recall_memory", arguments: JSON.stringify({ query }) },
          },
        ],
      });
      chunk(res, {}, "tool_calls");
      usageChunk(res, promptTokens, 12);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fixture model listening on http://127.0.0.1:${PORT}/v1 (model: ${MODEL_ID})`);
});
