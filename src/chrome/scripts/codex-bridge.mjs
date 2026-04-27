#!/usr/bin/env node
/**
 * Local OpenAI-compatible bridge for WebBrain -> Codex.
 *
 * The Chrome extension cannot and should not read ~/.codex/auth.json or spawn
 * local processes directly. Run this bridge on localhost instead:
 *
 *   node scripts/codex-bridge.mjs
 *
 * Faster ACP backend:
 *
 *   WEBBRAIN_CODEX_BACKEND=acpx node scripts/codex-bridge.mjs
 *
 * Then select "Codex Local Bridge" in WebBrain settings.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = process.env.WEBBRAIN_CODEX_HOST || '127.0.0.1';
const PORT = Number(process.env.WEBBRAIN_CODEX_PORT || 1455);
const BACKEND = (process.env.WEBBRAIN_CODEX_BACKEND || 'cli').toLowerCase();
const CODEX_BIN = process.env.WEBBRAIN_CODEX_BIN || 'codex';
const CODEX_TIMEOUT_MS = Number(process.env.WEBBRAIN_CODEX_TIMEOUT_MS || 180000);
const ACPX_BIN = process.env.WEBBRAIN_CODEX_ACPX_BIN || 'acpx';
const ACPX_AGENT = process.env.WEBBRAIN_CODEX_ACPX_AGENT || 'codex';
const ACPX_MODEL = process.env.WEBBRAIN_CODEX_ACPX_MODEL || 'gpt-5.3-codex-spark/low';
const ACPX_TIMEOUT_SECONDS = Number(process.env.WEBBRAIN_CODEX_ACPX_TIMEOUT || 60);
const ACPX_SESSION = process.env.WEBBRAIN_CODEX_ACPX_SESSION || '';
const ACPX_TTL_SECONDS = process.env.WEBBRAIN_CODEX_ACPX_TTL || '300';
const ACPX_FALLBACK_TO_CLI = !/^(0|false|no|off)$/i.test(process.env.WEBBRAIN_CODEX_ACPX_FALLBACK_TO_CLI || '1');
const MAX_IMAGES = Number(process.env.WEBBRAIN_CODEX_MAX_IMAGES || 4);
const MAX_IMAGE_BYTES = Number(process.env.WEBBRAIN_CODEX_MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.WEBBRAIN_CODEX_VERBOSE || '');
let requestSeq = 0;

function vlog(...args) {
  if (VERBOSE) console.log(new Date().toISOString(), '[verbose]', ...args);
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          arguments_json: { type: 'string' },
        },
        required: ['name', 'arguments_json'],
      },
    },
  },
  required: ['content', 'tool_calls'],
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 12_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function addImage(imageUrl, images) {
  const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url;
  if (!url || !url.startsWith('data:image/')) return '[image ignored: unsupported image_url format]';
  if (images.length >= MAX_IMAGES) return '[image ignored: bridge image limit reached]';

  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
  if (!match) return '[image ignored: unsupported image data URL]';

  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (bytes.byteLength > MAX_IMAGE_BYTES) return `[image ignored: ${bytes.byteLength} bytes exceeds bridge limit]`;

  const mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const label = `image_${images.length + 1}.${ext}`;
  images.push({ label, mime, ext, bytes });
  return `[image attached for Codex: ${label}]`;
}

function textFromContent(content, images) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map(part => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'image_url') return addImage(part.image_url, images);
    return JSON.stringify(part);
  }).join('\n');
}

function toolCallToText(message) {
  const calls = message.tool_calls || [];
  if (!calls.length) return '';
  return calls.map(tc => {
    const name = tc?.function?.name || tc?.name || 'unknown_tool';
    const args = tc?.function?.arguments || tc?.arguments || '{}';
    return `<assistant_tool_call name="${name}">${typeof args === 'string' ? args : JSON.stringify(args)}</assistant_tool_call>`;
  }).join('\n');
}

function buildPrompt(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const images = [];

  const transcript = messages.map((message, index) => {
    const role = message.role || 'user';
    const content = textFromContent(message.content || '', images);
    const toolCalls = toolCallToText(message);
    const toolName = message.name || message.tool_call_id || '';
    const label = toolName ? `${role}:${toolName}` : role;
    return `### Message ${index + 1} (${label})\n${content}${toolCalls ? `\n${toolCalls}` : ''}`;
  }).join('\n\n');

  const toolList = tools.map(tool => {
    const fn = tool.function || tool;
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || {},
    };
  });

  const imageNote = images.length
    ? `\nAttached screenshots/images available to Codex CLI: ${images.map(img => img.label).join(', ')}\n`
    : '';

  const prompt = `You are the LLM planner inside a Chrome browser-agent extension.

You do not have direct browser access. WebBrain will execute exactly the tool calls you return, then call you again with the results. Your job is to decide the next browser step or provide the final answer.
${imageNote}

Return ONLY a JSON object with this shape:
{"content":"assistant text for the user, or empty string when calling tools","tool_calls":[{"name":"tool_name","arguments_json":"{}"}]}

Rules:
- Use only tool names from the Available tools list.
- When a tool is needed, put one or more entries in tool_calls. Put the tool arguments as a JSON object string in arguments_json.
- When no tool is needed, set tool_calls to [] and put the final answer in content.
- Do not include Markdown fences, commentary, hidden reasoning, or XML tags.
- Do not ask Codex to run shell commands. The browser extension, not Codex, executes browser tools.

Available tools:
${JSON.stringify(toolList, null, 2)}

Conversation:
${transcript}`;

  return { prompt, images };
}

function parseCodexJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { content: '', tool_calls: [] };
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }

  return { content: trimmed, tool_calls: [] };
}

function normalizeAssistant(parsed) {
  const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
  const toolCalls = calls
    .filter(call => call && typeof call.name === 'string')
    .map((call, index) => {
      let args = {};
      if (typeof call.arguments_json === 'string' && call.arguments_json.trim()) {
        try {
          const parsedArgs = JSON.parse(call.arguments_json);
          if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) args = parsedArgs;
        } catch {}
      } else if (call.arguments && typeof call.arguments === 'object') {
        args = call.arguments;
      }
      return {
        id: `codex_call_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(args),
        },
      };
    });

  return {
    role: 'assistant',
    content: String(parsed.content || ''),
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

function normalizeAcpxModel(model) {
  const raw = String(model || '').trim();
  if (!raw || raw === 'codex') return ACPX_MODEL;
  if (raw.includes('/')) return raw;
  if (/^gpt-\d/.test(raw)) return `${raw}/low`;
  return raw;
}

function normalizeCliModel(model) {
  const raw = String(model || '').trim();
  if (!raw || raw === 'codex') return raw;
  return raw.replace(/\/(?:low|medium|high|xhigh)$/i, '');
}

function acpxPromptPayload(prompt, images) {
  if (!images.length) return prompt;
  return JSON.stringify([
    { type: 'text', text: prompt },
    ...images.map(image => ({
      type: 'image',
      mimeType: image.mime,
      data: image.bytes.toString('base64'),
    })),
  ]);
}

async function runCodex(prompt, model, images = []) {
  const dir = await mkdtemp(join(tmpdir(), 'webbrain-codex-'));
  const outputPath = join(dir, 'last-message.txt');
  const schemaPath = join(dir, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(RESPONSE_SCHEMA), 'utf8');
  const imagePaths = [];
  for (const image of images) {
    const imagePath = join(dir, image.label);
    await writeFile(imagePath, image.bytes);
    imagePaths.push(imagePath);
  }

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
  ];
  for (const imagePath of imagePaths) {
    args.push('--image', imagePath);
  }
  const cliModel = normalizeCliModel(model);
  if (cliModel && cliModel !== 'codex') args.push('--model', cliModel);
  args.push('-');
  const started = Date.now();
  vlog('tmp_dir=', dir);
  vlog('codex_args=', args.map(arg => arg.includes(' ') ? JSON.stringify(arg) : arg).join(' '));
  vlog('prompt_chars=', prompt.length, 'images=', imagePaths.map(path => path.replace(dir + '/', '')).join(',') || 'none');

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(CODEX_BIN, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      });

      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`codex timed out after ${CODEX_TIMEOUT_MS}ms`));
      }, CODEX_TIMEOUT_MS);

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`codex exited with ${code}: ${stderr.slice(-4000)}`));
      });

      child.stdin.end(prompt);
    });

    const output = await readFile(outputPath, 'utf8');
    vlog('codex_ms=', Date.now() - started, 'output_chars=', output.length);
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
    vlog('tmp_removed=', dir);
  }
}

async function runAcpx(prompt, model, images = []) {
  const dir = await mkdtemp(join(tmpdir(), 'webbrain-acpx-'));
  const promptPath = join(dir, 'prompt.json');
  const promptPayload = acpxPromptPayload(prompt, images);
  await writeFile(promptPath, promptPayload, 'utf8');

  const acpxModel = normalizeAcpxModel(model);
  const args = [
    '--format', 'quiet',
    '--timeout', String(ACPX_TIMEOUT_SECONDS),
    '--ttl', String(ACPX_TTL_SECONDS),
    '--deny-all',
    '--no-terminal',
    '--model', acpxModel,
    ACPX_AGENT,
  ];
  if (ACPX_SESSION) args.push('--session', ACPX_SESSION);
  args.push('-f', promptPath);

  const started = Date.now();
  vlog('tmp_dir=', dir);
  vlog('acpx_args=', args.map(arg => arg.includes(' ') ? JSON.stringify(arg) : arg).join(' '));
  vlog('prompt_chars=', prompt.length, 'images=', images.map(img => img.label).join(',') || 'none', 'acpx_model=', acpxModel);

  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(ACPX_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`acpx timed out after ${ACPX_TIMEOUT_SECONDS}s`));
      }, ACPX_TIMEOUT_SECONDS * 1000 + 5000);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`acpx exited with ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}`));
      });
    });

    vlog('acpx_ms=', Date.now() - started, 'output_chars=', output.length);
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
    vlog('tmp_removed=', dir);
  }
}

async function runBackend(prompt, model, images = []) {
  if (BACKEND === 'acpx') {
    try {
      return await runAcpx(prompt, model, images);
    } catch (error) {
      if (!ACPX_FALLBACK_TO_CLI) throw error;
      vlog('acpx_failed_falling_back_to_cli=', error?.message || String(error));
      return runCodex(prompt, model, images);
    }
  }
  if (BACKEND === 'cli') return runCodex(prompt, model, images);
  throw new Error(`Unsupported WEBBRAIN_CODEX_BACKEND "${BACKEND}". Use "cli" or "acpx".`);
}

async function handleChat(req, res) {
  const reqId = ++requestSeq;
  const started = Date.now();
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : {};
  vlog(`#${reqId}`, 'incoming', 'model=', body.model || 'codex', 'messages=', Array.isArray(body.messages) ? body.messages.length : 0, 'tools=', Array.isArray(body.tools) ? body.tools.length : 0, 'raw_bytes=', raw.length);
  if (body.stream) {
    sendJson(res, 400, { error: { message: 'Codex bridge does not support streaming; use non-streaming chat.' } });
    return;
  }

  const { prompt, images } = buildPrompt(body);
  vlog(`#${reqId}`, 'built_prompt', 'prompt_chars=', prompt.length, 'images=', images.length, 'image_bytes=', images.map(img => img.bytes.byteLength).join(',') || 'none');
  const rawCodex = await runBackend(prompt, body.model, images);
  const parsed = parseCodexJson(rawCodex);
  const message = normalizeAssistant(parsed);
  vlog(`#${reqId}`, 'response', 'content_chars=', message.content.length, 'tool_calls=', message.tool_calls?.length || 0, 'total_ms=', Date.now() - started);

  sendJson(res, 200, {
    id: `chatcmpl-codex-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'codex',
    choices: [{
      index: 0,
      message,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
    }],
    usage: null,
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        bridge: 'webbrain-codex',
        backend: BACKEND,
        codexBin: CODEX_BIN,
        acpxBin: ACPX_BIN,
        acpxAgent: ACPX_AGENT,
        acpxModel: ACPX_MODEL,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      await handleChat(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  } catch (error) {
    sendJson(res, 500, { error: { message: error?.message || String(error) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WebBrain Codex bridge listening at http://${HOST}:${PORT}/v1`);
  console.log(`Backend: ${BACKEND}${BACKEND === 'acpx' ? ` (${ACPX_AGENT}, ${ACPX_MODEL})` : ` (${CODEX_BIN})`}`);
  if (VERBOSE) console.log('Verbose logging enabled via WEBBRAIN_CODEX_VERBOSE=1');
});
