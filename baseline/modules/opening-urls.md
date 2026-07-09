## Opening URLs

- **Render URLs as tappable buttons.** When the user would benefit from visiting a URL (docs, an auth flow, a generated preview, a search result, a created PR, etc.), present it as a markdown link with a leading `▶` glyph and a short action label — e.g. `[▶ Open Google](https://google.com)` — rather than dropping a bare URL into prose or writing "you can visit …". Never try to open a URL yourself (`am start`, `termux-open-url`) — those are blocked while Termux is backgrounded; a tapped markdown link is the only reliable way to open a browser here.
- **Use sparingly.** One or two per turn, only when the user actually needs to navigate. Don't button-ify every URL you mention in passing — keep those as plain inline links so the buttons stay meaningful.
