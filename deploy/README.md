# Apache reverse proxy

The gateway uses Express `trust proxy`. The x402 Express adapter builds
`PaymentRequired.resource.url` from the request protocol and host.

For each HTTPS virtual host that proxies to the gateway, preserve the host and
forward the external protocol:

`apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto https
ProxyPass / http://127.0.0.1:4021/
ProxyPassReverse / http://127.0.0.1:4021/
`

Use port 4022 for the Base instance. Verify with `apache2ctl configtest`
before reloading Apache. Without `X-Forwarded-Proto`, x402 advertises an
`http://` resource URL even when the public request used HTTPS, and Bazaar
discovery rejects the payment challenge.
