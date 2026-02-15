import * as vscode from 'vscode';

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function readLlmConfig(): LlmConfig {
  const c = vscode.workspace.getConfiguration('codesense.llm');
  return {
    enabled: c.get<boolean>('enabled', false),
    baseUrl: c.get<string>('baseUrl', 'http://localhost:11434/v1'),
    model: c.get<string>('model', 'llama3.1'),
    apiKey: c.get<string>('apiKey', ''),
  };
}

const SYSTEM_PROMPT = `You are CodeSense, a patient senior engineer explaining code to a developer
who is new to this codebase. Explain clearly and concretely. Use short sections and bullet points.
Do not rewrite or improve the code unless asked. If something is ambiguous, say so.`;

/**
 * Calls any OpenAI-compatible chat endpoint (OpenAI, Ollama, LM Studio, Groq, ...).
 * One small function = easy to swap providers later.
 */
export async function explainWithLlm(cfg: LlmConfig, userPrompt: string): Promise<string> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '(empty response)';
}
