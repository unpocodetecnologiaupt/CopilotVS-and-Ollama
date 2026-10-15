// ollama-nothink-proxy.js
// Proxy between VS Code Copilot and Ollama.
//  - Turns off thinking on every chat request:
//      /api/chat             -> adds "think": false
//      /v1/chat/completions  -> adds "reasoning_effort": "none" (and "think": false)
//  - Logs each chat request and how its response ended, without slowing anything
//    down: the response goes to Copilot as it arrives, and the log only reads a
//    copy of the same chunks.
//
// Usage:   node ollama-nothink-proxy.js
// Copilot: point the Ollama URL to http://127.0.0.1:11435
//
// Options (environment variables, all optional):
//   PROXY_KEEP_THINK=1   do NOT turn off thinking (useful to compare with/without)
//   PROXY_LOG_ALL=1      also log the noisy requests (/api/ps, /api/tags, /api/show...)
//   PROXY_LOG_FILE=0     do NOT save the log to ollama-proxy.log (by default it prints
//                        to the terminal AND saves it next to this script)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 11434; // where Ollama listens
const LISTEN_PORT = 11435; // where Copilot connects

const FORCE_NO_THINK = process.env.PROXY_KEEP_THINK !== '1';
const LOG_ALL = process.env.PROXY_LOG_ALL === '1';

const LOG_PATH = path.join(__dirname, 'ollama-proxy.log');
const logFile = process.env.PROXY_LOG_FILE !== '0' ? fs.createWriteStream(LOG_PATH, { flags: 'a' }) : null;
function log(line) {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const out = `${ts} ${line}`;
  console.log(out);
  if (logFile) logFile.write(out + '\n');
}

function preview(text, max = 160) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// Message content can be a string or an array of parts (OpenAI format).
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ');
  return '';
}

let counter = 0;

http.createServer((req, res) => {
  const id = ++counter;
  const start = Date.now();
  const isPost = req.method === 'POST';
  const kind =
    isPost && req.url.startsWith('/api/chat') ? 'chat' :
    isPost && req.url.startsWith('/v1/chat/completions') ? 'v1chat' :
    isPost && req.url.startsWith('/api/generate') ? 'generate' : null;
  const watched = kind !== null;

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);

    // ---- Request: turn off thinking and log a one-line summary ----
    if (watched && body.length) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        if (FORCE_NO_THINK && kind === 'chat') json.think = false;
        if (FORCE_NO_THINK && kind === 'v1chat') {
          json.reasoning_effort = 'none';
          delete json.reasoning;
          json.think = false;
        }
        body = Buffer.from(JSON.stringify(json), 'utf8');

        const msgs = Array.isArray(json.messages) ? json.messages : [];
        const last = msgs[msgs.length - 1];
        const lastInfo = last
          ? `last=${last.role}${last.role === 'tool' ? ` "${preview(contentText(last.content), 60)}"` : ''}`
          : '';
        const thinkInfo = kind === 'v1chat'
          ? `reasoning=${json.reasoning_effort ?? 'default'}`
          : `think=${json.think === undefined ? 'default' : json.think}`;
        log(
          `#${id} → ${kind} model=${json.model} msgs=${msgs.length} ` +
          `tools=${Array.isArray(json.tools) ? json.tools.length : 0} ${thinkInfo} ${lastInfo}`
        );
      } catch {
        log(`#${id} → ${req.method} ${req.url} (body is not JSON, forwarded unchanged)`);
      }
    } else if (LOG_ALL) {
      log(`#${id} → ${req.method} ${req.url}`);
    }

    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    delete headers['transfer-encoding'];
    headers['content-length'] = body.length;

    const upstream = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res); // Copilot gets every chunk immediately, untouched

        if (!watched) {
          if (LOG_ALL) up.on('end', () => log(`#${id} ← ${up.statusCode} ${Date.now() - start}ms`));
          return;
        }

        // ---- Response: read a copy of the stream to build the summary ----
        // Works for Ollama NDJSON (/api/*) and for SSE "data: {...}" (/v1/*),
        // streaming or not.
        const decoder = new StringDecoder('utf8');
        let pending = '';
        let content = '';
        let contentChars = 0;
        let thinkingChars = 0;
        const toolCalls = [];
        let reason = null;
        let promptTokens = null;
        let genTokens = null;
        let errorText = null;
        let raw = ''; // only used if nothing could be parsed (e.g. an error page)

        const addContent = (piece) => {
          if (!piece) return;
          contentChars += piece.length;
          if (content.length < 4000) content += piece;
        };

        const handleObj = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.error) errorText = typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error));

          // OpenAI format (/v1/chat/completions)
          if (Array.isArray(obj.choices)) {
            for (const ch of obj.choices) {
              const m = ch.delta || ch.message || {};
              addContent(contentText(m.content));
              const think = m.reasoning ?? m.reasoning_content ?? '';
              if (think) thinkingChars += String(think).length;
              if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) if (tc?.function?.name) toolCalls.push(tc.function.name);
              }
              if (ch.finish_reason) reason = ch.finish_reason;
            }
            if (obj.usage) {
              promptTokens = obj.usage.prompt_tokens ?? promptTokens;
              genTokens = obj.usage.completion_tokens ?? genTokens;
            }
            return;
          }

          // Ollama native format (/api/chat, /api/generate)
          const m = obj.message || {};
          addContent(m.content ?? obj.response ?? '');
          const think = m.thinking ?? obj.thinking ?? '';
          if (think) thinkingChars += think.length;
          if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) toolCalls.push(tc?.function?.name || '?');
          }
          if (obj.done) {
            reason = obj.done_reason ?? reason;
            promptTokens = obj.prompt_eval_count ?? promptTokens;
            genTokens = obj.eval_count ?? genTokens;
          }
        };

        let parsedAny = false;
        const handleLine = (line) => {
          let s = line.trim();
          if (!s) return;
          if (s.startsWith('data:')) s = s.slice(5).trim();
          if (!s || s === '[DONE]' || s.startsWith('event:') || s.startsWith(':')) return;
          try { handleObj(JSON.parse(s)); parsedAny = true; } catch { if (raw.length < 300) raw += s; }
        };

        up.on('data', (chunk) => {
          pending += decoder.write(chunk);
          let nl;
          while ((nl = pending.indexOf('\n')) >= 0) {
            handleLine(pending.slice(0, nl));
            pending = pending.slice(nl + 1);
          }
        });

        up.on('end', () => {
          pending += decoder.end();
          if (pending) handleLine(pending);

          const secs = ((Date.now() - start) / 1000).toFixed(1);
          log(
            `#${id} ← ${up.statusCode} ${secs}s reason=${reason ?? '?'} prompt=${promptTokens ?? '?'} gen=${genTokens ?? '?'} | ` +
            `content=${contentChars} chars thinking=${thinkingChars} chars ` +
            `tool_calls=${toolCalls.length ? toolCalls.join(',') : 'none'}`
          );

          if (errorText) log(`#${id}   ERROR from Ollama: ${preview(errorText, 300)}`);
          if (!parsedAny && raw) log(`#${id}   raw: ${preview(raw, 300)}`);
          if (contentChars > 0) log(`#${id}   text: "${preview(content)}"`);
          if (up.statusCode === 200 && contentChars === 0 && toolCalls.length === 0) {
            log(`#${id}   *** EMPTY RESPONSE: no text and no tool calls (Copilot will show "no response") ***`);
          }
        });
      }
    );

    upstream.on('error', (err) => {
      log(`#${id} ✖ could not reach Ollama: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Proxy could not reach Ollama: ${err.message}`);
    });

    // If Copilot cancels (Stop button), stop the request to Ollama too.
    res.on('close', () => {
      if (!res.writableFinished) {
        if (watched) log(`#${id} ✖ cancelled by Copilot after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        upstream.destroy();
      }
    });

    upstream.end(body);
  });
}).listen(LISTEN_PORT, '127.0.0.1', () => {
  log(
    `Proxy listening on http://127.0.0.1:${LISTEN_PORT} -> Ollama on ${TARGET_PORT} ` +
    `(thinking=${FORCE_NO_THINK ? 'off' : 'unchanged'}${logFile ? `, also saving to ${LOG_PATH}` : ''})`
  );
});
