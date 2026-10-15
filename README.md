# ollama-nothink-proxy

##

Proxy ligero en Node.js entre GitHub Copilot (VS Code) y Ollama que **desactiva el modo thinking en cada petición de chat**. Así evita el error de Copilot con modelos pequeños que no cierran el tag del razonamiento. Además, registra cada petición y cómo terminó su respuesta (tokens, tool calls, respuestas vacías) sin frenar el streaming. No tiene dependencias.

**Uso:** `node ollama-nothink-proxy.js` y en Copilot cambia la URL de Ollama a `http://127.0.0.1:11435`.

Opciones: `PROXY_KEEP_THINK=1` (no apaga el thinking), `PROXY_LOG_ALL=1` (registra todas las peticiones), `PROXY_LOG_FILE=0` (no guarda `ollama-proxy.log`).

##

A lightweight Node.js proxy between GitHub Copilot (VS Code) and Ollama that **turns off thinking on every chat request**. This avoids the Copilot error with small models that fail to close the reasoning tag. It also logs each request and how its response ended (tokens, tool calls, empty responses) without slowing down the stream. No dependencies.

**Usage:** `node ollama-nothink-proxy.js`, then set Copilot's Ollama URL to `http://127.0.0.1:11435`.

Options: `PROXY_KEEP_THINK=1` (keep thinking on), `PROXY_LOG_ALL=1` (log every request), `PROXY_LOG_FILE=0` (don't save `ollama-proxy.log`).
