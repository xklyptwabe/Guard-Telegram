# Polling to webhook migration

1. Deploy the webhook-capable build without enabling webhook mode.
2. Publish the HTTPS endpoint behind the configured path and verify the TLS certificate and reverse-proxy handling of `X-Telegram-Bot-Api-Secret-Token`.
3. Set `TELEGRAM_TRANSPORT=webhook`, `TELEGRAM_WEBHOOK_URL`, and a new 16+ character secret through the secret store.
4. Restart the single bot process. It calls `setWebhook`; do not leave a polling instance running.
5. Verify a command, `/command@bot_username` in a group, a callback, and a forum-topic reply. Confirm no secret or update body appears in logs.

To return to polling, remove the webhook at Telegram, deploy the polling configuration, and then start exactly one runner. Review `processed_updates` behavior during the handover; duplicate delivery must not duplicate effects.
