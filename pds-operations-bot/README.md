# PDS Operations Bot

Teams bot that accepts a prefilled Contact Admin report in its personal chat and posts a validated report to the PDS Operations channel after the employee sends it.

## Local checks

Requires Node.js 22.12 or newer.

```powershell
npm install
npm test
npm run build
```

For local activity testing, copy `.env.example` to `.env` and run `npm run dev`. `TEAMS_ALLOW_UNAUTHENTICATED=true` is only for the local Agents Playground and must never be enabled in production.

## Tenant setup

1. Deploy the bot container to an HTTPS host and note its public URL. Before registration, configure `TENANT_ID` and `PDS_CHANNEL_CONVERSATION_ID` as host environment variables. The app ID and secret are generated in the next step. Never commit `.env` or production credentials.
2. A Microsoft 365 admin signs in with the Teams Developer CLI and creates the app registration with the public messaging endpoint:

   ```powershell
   npx @microsoft/teams.cli login
   npx @microsoft/teams.cli app create --name "PDS Operations" --endpoint "https://<bot-host>/api/messages" --env .env
   ```

3. Put the generated `CLIENT_ID` and `CLIENT_SECRET` in the host environment, then restart/redeploy the bot. Keep `TEAMS_ALLOW_UNAUTHENTICATED` unset in production.
4. Install the app in both personal scope and the PDS Operations team. The bot must be installed in the team before it can post to the channel.
5. Deploy the push worker. Event notification Contact Admin links open the PEOPLES DAY x MEDICAL MISSION Teams channel directly; stock-request contacts keep their separate CALOOCAN destination. The channel link does not prefill a message draft.

The bot rejects messages outside personal chat or the configured tenant, requires all five report fields and a non-empty concern, and posts only after the employee sends the draft. It does not send the draft automatically. Event notification Contact Admin links currently open the event schedule channel directly rather than opening the bot chat.