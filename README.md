<div align="center">

# ⚡ ccmux

**Claude Code on Copilot + Ollama Cloud.**

Your GitHub Copilot subscription (including the free tier) and your Ollama Cloud key both power `claude` in your terminal.

[![npm](https://img.shields.io/npm/v/@dondetir/ccmux?label=npm)](https://www.npmjs.com/package/@dondetir/ccmux)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npm i -g @dondetir/ccmux && ccmux claude
```

*Don't switch tools. Switch backends.*

</div>

---

> 💡 **Why?** Your Copilot subscription already includes Claude, GPT, and Gemini, and Ollama Cloud adds GLM, Qwen, DeepSeek, Kimi and more. You just couldn't run them in `claude`. ccmux fixes that, aggregating every backend you have into one `/model` picker.
>
> ⚠️ **Unofficial:** it rides Copilot's editor-facing API, not a public one, so it can break when GitHub changes that surface. Free-tier premium requests are limited; `429`s are passed through so Claude Code backs off cleanly.

## 🔌 How it works

```
 ┌─────────────┐   Anthropic API    ┌───────┐    Copilot API     ┌────────────────┐
 │ Claude Code │ -----------------> │ ccmux  │ -----------------> │ GitHub Copilot │
 │ (terminal)  │ <----------------- │ :4141 │ <----------------- │ (your sub)     │
 └─────────────┘  streamed replies  └───────┘  native/translate  └────────────────┘
```

`ccmux` speaks the Anthropic API to Claude Code and routes each request to the right backend by model id: native pass-through for Copilot's Claude models, OpenAI translation for GPT/Gemini and every Ollama Cloud model (`ollama/*`), and the Responses API for `/responses`-only models. Ollama thinking models stream their reasoning back as Claude thinking blocks. It binds to `127.0.0.1`, so your credentials never leave your machine.

## 🚀 Quickstart

```bash
npm i -g @dondetir/ccmux   # puts the `ccmux` CLI on your PATH
ccmux claude        # starts the proxy if needed, then launches Claude Code
```

Requires **Node 20+**, [Claude Code](https://docs.anthropic.com/en/docs/claude-code), and a GitHub account with Copilot access. The first run without a token triggers a one-time device-flow login in your terminal (saved to `~/.config/ccmux/env`).

## 🧠 Models

Every Copilot model shows up in the native `/model` picker, with no `settings.json` edits:

```
$ ccmux claude
✓ proxy ready on http://127.0.0.1:4141
> /model
  claude-haiku-4.5
  claude-sonnet-4.6
  claude-gpt-4.1
  claude-gemini-2.5-pro
  …
```

Free tier gets `claude-haiku-4.5` only; paid Copilot unlocks sonnet, GPT, and Gemini. Set an Ollama Cloud key (`ccmux login ollama`) and its models join the same picker as `ollama/<id>` (e.g. `ollama/glm-5.2`, `ollama/qwen3-coder:480b`), each showing its real context window. Non-Claude ids are prefixed `claude-` to pass discovery, then the proxy strips the prefix and routes them to the right backend.

## 🛠 Commands

| Command | What it does |
|---|---|
| `ccmux claude` | Start the proxy if needed + launch Claude Code through it |
| `ccmux login copilot` | One-time GitHub device-flow login (in a terminal) |
| `ccmux login ollama` | Save an Ollama Cloud API key (from ollama.com/settings/keys) |
| `ccmux logout` | Remove saved tokens (GitHub + Ollama) + VS Code Copilot tokens + stop the proxy. Use `eval "$(ccmux logout)"` to also clear tokens exported in the current shell |
| `ccmux serve` | Run the proxy in the foreground on `:4141` |

Logs stream to `~/.config/ccmux/proxy.log`. If models vanish, the catalog self-heals on the next request.

## ⚙️ Configuration

Env vars (or `~/.config/ccmux/env`):

| Var | Default | Meaning |
|---|---|---|
| `GH_TOKEN` | device flow | GitHub OAuth token (`GITHUB_TOKEN` also accepted) |
| `OLLAMA_API_KEY` | unset | Ollama Cloud key; set it (or run `ccmux login ollama`) to add `ollama/*` models |
| `NATIVE_MODEL` | `claude-haiku-4.5` | Model served to Claude Code. Paid: try `claude-sonnet-4.6` |
| `PORT` | `4141` | Proxy port (binds `127.0.0.1` only) |
| `USE_NATIVE` | `1` | `1` = native pass-through; `0` = OpenAI translation path |
| `CLAUDE_CONTEXT_WINDOW` | `200000` | Context window Claude Code assumes (token counts scaled to match) |

## 🔧 Development

```bash
npm install
npm test        # translators + streaming state machine
npm run dev     # proxy with live reload
```

## 📜 License

Released under the **MIT License**.

```
MIT License

Copyright (c) 2026 dondetir

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

A copy is also included in the repository as [`LICENSE`](./LICENSE).

---

<div align="center">

### 💛 Built with conviction

Claude Code is the best agentic coding harness out there, but it only spoke one
backend. ccmux gives you the freedom to run *any* Copilot model on it, not just
Claude: GPT, Gemini, and Claude, all in one terminal, all from the subscription
you already have. No relay servers, no middlemen, just a few hundred lines of
TypeScript running on your own machine.

If ccmux gave you model freedom on the best harness, **⭐ star the repo**. It's
the fuel that keeps projects like this alive and maintained.

[![stars](https://img.shields.io/badge/⭐-Star_on_GitHub-yellow?style=social)](https://github.com/dondetir/ccmux)
·
[Report a bug](https://github.com/dondetir/ccmux/issues)
·
[Request a feature](https://github.com/dondetir/ccmux/issues)

*Built for developers who want every model on the best harness.*

</div>
