# Claude Monitor

A local, read-only, zero-dependency live viewer for [Claude Code](https://claude.com/claude-code) session transcripts.
It tails the `.jsonl` files Claude Code writes and streams them to a browser dashboard over Server-Sent Events.

- No dependencies, no build step — just Node.js ≥ 18
- Binds to `127.0.0.1` only and rejects non-local `Host` headers
- Never writes to your transcripts
- Estimated token cost per session
- Optional Jira Cloud activity feed

## Quick start

```bash
git clone https://github.com/baocuong0501/claude-monitor.git
cd claude-monitor
npm start            # or: node server.js
```

Open <http://127.0.0.1:7777>.

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)).

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `7777` | HTTP port (host is always `127.0.0.1`) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where Claude Code stores transcripts |
| `JIRA_URL` / `JIRA_EMAIL` / `JIRA_TOKEN` | – | Enable the Jira feed (all three required) |
| `JIRA_POLL_MS` | `60000` | Jira polling interval |
| `JIRA_JQL` | assigned to or watched by me | JQL filter for the feed |

## Project layout

```
claude-monitor/
├── server.js        # HTTP + SSE server, transcript parser, Jira poller
├── public/
│   └── index.html   # Single-file dashboard UI
├── .env.example
├── package.json
├── LICENSE
└── README.md
```

## Privacy & security

- Transcripts can contain secrets, source code and file contents. Everything stays on your machine; the server listens on loopback only. **Do not expose it** via port-forwarding, tunnels or a reverse proxy.
- The UI loads fonts from Google Fonts. Remove the `<link>` tags in `public/index.html` for fully offline use.
- Jira credentials are read from the environment and sent only to your `JIRA_URL`.

## Cost estimates

Costs are estimated from token usage with a small built-in price table (`PRICE` in `server.js`) and are approximate. Models not in the table are counted as "unpriced". Update the table as new models appear.

## Contributing

Issues and pull requests are welcome. Keep the project dependency-free and read-only.

## License

[MIT](LICENSE)

Example

<img width="1075" height="825" alt="image" src="https://github.com/user-attachments/assets/8f1e7316-bbff-41eb-b442-e56906c9303f" />
