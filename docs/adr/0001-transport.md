# ADR 0001: grammY transport

Use grammY as the single Telegram platform layer. Long polling is the development/default transport and runs through `@grammyjs/runner` to allow controlled concurrency. Webhook is the production alternative only when a public HTTPS endpoint and secret token exist. The two transports share the same bot instance and middleware chain.
