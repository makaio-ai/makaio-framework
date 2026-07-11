---
'@makaio/ai-adapters-core': patch
---

Construct replacement connectors with their target reasoning effort. Reasoning-only and model-swap mutations now resolve the effective effort before the connector swap and pass it through the new `reasoningEffort` config override (key presence gates the override), so adapters that consume reasoning at construction/start no longer keep running with the previous effort while the API reports the new one.
