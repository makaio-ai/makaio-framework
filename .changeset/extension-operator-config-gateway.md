---
"@makaio/extension-gateway": minor
---

The README now documents `$MAKAIO_HOME/config/extensions/gateway.json` as the
primary way to configure upstreams, routing rules and the access token, replacing
the `MAKAIO_CONFIG_FILE` workaround. The example access-token reference is renamed
from `env:GATEWAY_ACCESS_TOKEN` to `env:MAKAIO_GATEWAY_ACCESS_TOKEN`. No runtime
behaviour changes; the gateway schema is unchanged.
