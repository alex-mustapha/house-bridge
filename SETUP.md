# Setup checklist

Work top to bottom. Everything here is free. Run all commands from
`E:\projects\linear-discord-bridge` in PowerShell.

> Gotchas already handled:
> - If `node`/`npx` aren't recognized, your terminal predates the Node install.
>   Refresh PATH in the window:
>   `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`
> - If you see "running scripts is disabled," run once:
>   `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

## Done so far
- [x] Install Node.js
- [x] Create Cloudflare account
- [x] `npx wrangler login`

## A. Linear workspace
- [ ] Create a **personal** Linear workspace (keep it separate from any work org)
- [ ] Create team **Chores** with key `CHO`
- [ ] Create team **Projects** with key `PRJ`
- [ ] On the Chores team, add labels for rooms: `bedroom` `bathroom` `kitchen`
      `living-room` `yard` `garage` `pets` (add/trim as you like)
- [ ] Create a Linear API key: **Settings → Security & access → Personal API keys**.
      Save it for step C.

## B. Discord channels + webhooks
Create these channels, then for each: **Channel Settings → Integrations →
Webhooks → New Webhook → Copy Webhook URL**.
- [ ] `#chores-activity`  → URL for `DISCORD_WEBHOOK_CHO`
- [ ] `#projects-activity` → URL for `DISCORD_WEBHOOK_PRJ`
- [ ] `#due-soon`         → URL for `DISCORD_WEBHOOK_DUE`
- [ ] `#bot-log`          → URL for `DISCORD_WEBHOOK_ADMIN`
- [ ] Decide a fallback for `DISCORD_WEBHOOK_DEFAULT` (point it at `#chores-activity`)
- [ ] Pick a random string for `LINEAR_WEBHOOK_SECRET` (reused in step E)

## C. Set secrets
Each command prompts you to paste the value.
```
npx wrangler secret put LINEAR_WEBHOOK_SECRET
npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put DISCORD_WEBHOOK_DEFAULT
npx wrangler secret put DISCORD_WEBHOOK_CHO
npx wrangler secret put DISCORD_WEBHOOK_PRJ
npx wrangler secret put DISCORD_WEBHOOK_DUE
npx wrangler secret put DISCORD_WEBHOOK_ADMIN
```

## D. Deploy
```
npm run deploy
```
Copy the printed URL: `https://linear-discord-bridge.<you>.workers.dev`

## E. Point Linear at the Worker
Linear → **Settings → API → Webhooks → New webhook**:
- [ ] URL = your Worker URL from step D
- [ ] Secret = the same string you set as `LINEAR_WEBHOOK_SECRET`
- [ ] Enable **Issues** and **Comments**

## F. Test
```
npm run tail
```
Create an issue in Linear → watch it appear in the logs and in `#chores-activity`.

## Later (optional)
- [ ] Author recurring chores in the Linear `Recurring` project (see README §7)
- [ ] `wrangler secret put ROTATION_MEMBERS` (e.g. `Alex,Kristal`) for alternating
      auto-assignment
- [ ] `wrangler secret put DISCORD_MENTIONS` (`Name:DiscordUserID,…`) so the daily
      digest @-mentions each owner
- [ ] `wrangler secret put CRON_KEY` to enable the manual toolkit endpoints
      (run-cron / scoreboard / replace — see README "Manual toolkit")
- [ ] `wrangler secret put DISCORD_WEBHOOK_DONE` / `DISCORD_WEBHOOK_STATS` to give
      the celebration and scoreboard their own channels
- [ ] Enable Linear's native Discord integration to create issues from Discord
      (README "Creating issues & projects from Discord")
- [ ] Adjust cron time in `wrangler.toml` for EST winter (see notes in that file)
