/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @aicoach chat participant — conversational interface to AI Engineer Coach data.
 * Delegates tool calls to the LM tools registered in tools.ts.
 */

import * as vscode from 'vscode';
import { TOOL_DEFS } from '../mcp/tools';
import { buildSystemPrompt } from './system-prompt';

const PARTICIPANT_ID = 'aiEngineerCoach.aicoach';
const MAX_TOOL_ROUNDS = 8;

/* ---- slash commands ---- */

interface SlashCommand {
  name: string;
  description: string;
  /** Injected into the user prompt when the slash command is used with no additional text. */
  defaultPrompt: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'summary', description: 'Get a quick summary of your AI coding usage', defaultPrompt: 'Give me a concise overview of my AI coding usage, highlighting strengths and top areas to improve.' },
  { name: 'improve', description: 'Get improvement recommendations', defaultPrompt: 'Analyse my usage patterns and give me the top 3 things I should improve, with specific actions.' },
  { name: 'compare', description: 'Compare your AI coding tools', defaultPrompt: 'Compare the AI coding tools I use and tell me which is most effective for what.' },
  { name: 'flow', description: 'Analyse your flow & focus', defaultPrompt: 'Analyse my flow state and deep work patterns. When am I most productive, and how can I protect that time?' },
];

/* ---- build tools array for sendRequest ---- */

function getChatTools(): vscode.LanguageModelChatTool[] {
  return TOOL_DEFS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/* ---- agentic tool loop ---- */

async function runAgenticLoop(
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = resolveUserPrompt(request);

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];

  const tools = getChatTools();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const chatResponse = await request.model.sendRequest(messages, { tools }, token);

    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let textSoFar = '';

    for await (const chunk of chatResponse.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        textSoFar += chunk.value;
        response.markdown(chunk.value);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(chunk);
      }
    }

    // No tool calls → model is done
    if (toolCalls.length === 0) {
      return {};
    }

    // Append assistant message with tool calls
    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    if (textSoFar) {
      assistantParts.push(new vscode.LanguageModelTextPart(textSoFar));
    }
    assistantParts.push(...toolCalls);
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    // Invoke each tool and collect results
    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      response.progress(`Calling ${call.name}…`);
      const result = await vscode.lm.invokeTool(call.name, {
        input: call.input,
        toolInvocationToken: request.toolInvocationToken,
      }, token);

      resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content as Array<vscode.LanguageModelTextPart>));
    }

    // Append user message with tool results
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
  }

  // Exhausted rounds
  response.markdown('\n\n*Reached the maximum number of tool calls. Please ask a more focused question.*');
  return {};
}

/* ---- prompt resolution ---- */

function resolveUserPrompt(request: vscode.ChatRequest): string {
  if (request.command) {
    const cmd = SLASH_COMMANDS.find(c => c.name === request.command);
    if (cmd) {
      return request.prompt.trim() || cmd.defaultPrompt;
    }
  }
  return request.prompt || 'Give me a coaching summary.';
}

/* ---- follow-ups ---- */

function getFollowups(result: vscode.ChatResult): vscode.ChatFollowup[] {
  const meta = result.metadata as Record<string, unknown> | undefined;
  if (meta?.['suppressFollowups']) return [];

  return [
    { prompt: 'What should I improve next?', label: 'Improve', command: 'improve' },
    { prompt: 'Compare my AI tools', label: 'Compare tools', command: 'compare' },
    { prompt: 'How is my focus & flow?', label: 'Flow state', command: 'flow' },
  ];
}

/* ---- registration ---- */

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, _context, response, token) => {
    return runAgenticLoop(request, response, token);
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');

  participant.followupProvider = {
    provideFollowups(result, _context, _token) {
      return getFollowups(result);
    },
  };

  context.subscriptions.push(participant);
}

export { SLASH_COMMANDS, PARTICIPANT_ID };
