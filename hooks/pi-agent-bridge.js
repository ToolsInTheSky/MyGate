import fs from 'node:fs';
import { JsonToToolFormat } from './json-to-tool-format.js';
import { toolFormatToToolCalls } from './tool-format-to-tool-calls.js';

/**
 * Pi coding-agent bridge.
 *
 * When the upstream model has tool calling disabled, this hook converts the
 * request into a human-in-the-loop format: native tool definitions are
 * stripped from the body and instead embedded in the system message as
 * [(S)USERREQUEST]...[(E)USERREQUEST] blocks. The model is instructed to
 * request one human-run operation at a time.
 *
 * On the response side, the hook validates that the model only emitted
 * request blocks, then converts them back into native tool_calls so the
 * downstream pi agent receives a normal tool-calling response.
 */

// Load the human collaboration instructions once when the hook is registered. 
const prompt = fs.readFileSync(new URL('./systemprompt.txt', import.meta.url), 'utf8').trim();
const converter = new JsonToToolFormat();
const taskIntroduction = 'The user is going to give you a task now:';
const requestBlockPattern = /^\s*(?:\[\(S\)USERREQUEST\]\r?\n[^]*?\r?\n\[\(E\)USERREQUEST\]\s*)+$/;
const formatError = 'Response format error: upstream response must contain only [(S)USERREQUEST]...[(E)USERREQUEST] blocks.';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((part) => part?.type === 'text' ? part.text : null);
  return parts.every((part) => typeof part === 'string') ? parts.join('\n') : null;
}

function checkedContent(content) {
  if (!content.trimStart().startsWith('[(S)USERREQUEST]')) return null;
  return requestBlockPattern.test(content) ? content : formatError;
}

function applyToolCalls(target, choice, content, tools) {
  try{
    target.content = null;
    target.tool_calls = toolFormatToToolCalls(content, tools);
    choice.finish_reason = 'tool_calls';
  } catch {
    target.content = formatError;
  }
}

export function requestMutation(ctx) {
  // Apply this mutation only to chat-completion message arrays.
  if (ctx.endpoint !== 'chat.completions' || !Array.isArray(ctx.messages)) return;

  const lastMessage = ctx.messages.at(-1);
  if (lastMessage?.role === 'tool') {
    lastMessage.role = 'user';
    delete lastMessage.tool_call_id;
  }

  // The first text message contains the original system prompt and tool summary.
  const firstMessage = ctx.messages[0];
  if (typeof firstMessage?.content !== 'string') return;

  // Convert native tool definitions into the human-operated request format
  const toolDefinitions = Array.isArray(ctx.tools) ? ctx.tools : ctx.body?.tools;
  ctx.originalTools = toolDefinitions;
  const tools = Array.isArray(toolDefinitions) && toolDefinitions.length
    ? converter.convert({ tools: toolDefinitions }).trimEnd()
    : '';

  // Prevent the upstream model from receiving native tool-calling fields.
  delete ctx.tools;
  if (ctx.body){
    delete ctx.body.tools;
    delete ctx.body.tool_choice;
    delete ctx.body.parallel_tool_calls;
  }

  // Discard the original prompt through </tools>, preserving the user's remaining rules and content.
  const toolsEnd = firstMessage.content.indexOf('</tools>');
  const remainingContent = toolsEnd === -1
    ? firstMessage.content
    : firstMessage.content.slice(toolsEnd + '</tools>'.length);

  // Merge separate task message so AI receives one authoritative user message.
  const task = ctx.messages[1]?.role === 'user' ? textContent(ctx.messages[1].content) : null;
  firstMessage.role = 'user';
  firstMessage.content = [
    prompt,
    tools,
    remainingContent.trimStart(),
    task === null ? '' : `${taskIntroduction}\n\n${task}`,
  ].filter(Boolean).join('\n\n');
  if (task !== null) ctx.messages.splice(1, 1);
  ctx.requireUserRequestFormat = true;
}

export function responseMutation(ctx, response) {
  if (ctx.endpoint !== 'chat.completions' || !ctx.requireUserRequestFormat) return;

  const choice = response?.choices?.[0];
  const message = choice?.message;
  if (typeof message?.content === 'string') {
    const content = checkedContent(message.content);
    if (content === formatError) message.content = content;
    else if (content !== null) applyToolCalls(message, choice, content, ctx.originalTools);
    return;
  }

  const delta = choice?.delta;
  if (!delta) return;
  if (typeof delta.content === 'string') {
    ctx.userRequestResponse = (ctx.userRequestResponse ?? '') + delta.content;
    delta.content = ''; 
  }
  if (choice.finish_reason) {
    const buffered = ctx.userRequestResponse ?? '';
    const content = checkedContent(buffered);
    if (content === formatError) delta.content = content;
    else if (content === null) delta.content = buffered;
    else applyToolCalls(delta, choice, content, ctx.originalTools);
    delete ctx.userRequestResponse;
  }
}
