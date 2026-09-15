# Putting this on your own server

The site is static files. Copy them somewhere that serves HTTPS and you have an
installer. There is nothing to compile, no runtime, no database, and nothing that
calls home.

## What the host has to do

Four requirements, and they are all a web server does by default or with one
line of configuration.

**Serve over HTTPS.** Web Serial is only available in a secure context. Over
plain HTTP the page loads and shows the files, the checksums and an `esptool`
command line, but the install button is replaced by a sentence explaining why.
`http://localhost` counts as secure, which is what makes local testing possible.

**Send the right media type for `.js`.** The page is ES modules, loaded with
`<script type="module">`. A server that sends `text/plain` for `.js` breaks the
whole page. Every mainstream server gets this right out of the box.

**Send `.json`, `.bin` and `.woff2` as files, not as something to interpret.**
`application/json`, `application/octet-stream` and `font/woff2`.

**Do not rewrite everything to one entry point.** The page fetches
`catalog.json`, then a manifest, then the binaries, all by real paths. A
single-page-app catch-all rule that answers every request with `index.html` will
produce puzzling JSON parse errors.

Nothing else matters. No PHP, no Node, no server-side code of any kind.

## Local testing

```
python3 -m http.server 8731
python3 tools/check.py http://127.0.0.1:8731/
```

`localhost` and `127.0.0.1` are treated as secure contexts by Chrome and Edge, so
the install button works there and you can rehearse a release against real
hardware before you upload anything.

## Apache

Copying the directory into the document root is normally all it takes. If the
host has an aggressive rewrite rule, exempt the installer:

```apache
<Directory /var/www/install>
    Options -Indexes
    AllowOverride None
    RewriteEngine Off
</Directory>

AddType application/octet-stream .bin
AddType font/woff2 .woff2
```

If you cannot touch the server configuration, the same two `AddType` lines work
in an `.htaccess` file inside the installer directory.

## nginx

```nginx
location /install/ {
    alias /var/www/install/;
    try_files $uri $uri/ =404;
    types {
        text/html            html;
        text/javascript      js;
        text/css             css;
        application/json     json;
        application/octet-stream bin;
        font/woff2           woff2;
        image/svg+xml        svg;
    }
}
```

The important part is `try_files ... =404` rather than a fallback to
`index.html`. A missing binary should be a 404 the installer can report, not an
HTML page it tries to parse as firmware.

## GitHub Pages

Push the directory to a repository and turn Pages on. Pages serves HTTPS, sends
the correct media types, and does not rewrite paths, so it works unmodified.

Two things to know. Pages caps both the size of a published site and the size of
a single file, so check the current limits before you publish a large firmware
archive; if it does not fit, put the binaries on a release host and list that
host in `allowOrigins`. And `tools/` and `tests/` are published
along with everything else unless you exclude them; that is harmless, but if you
would rather not, keep the site in a `docs/` directory or on its own branch.

## Any other static host

Netlify, Cloudflare Pages, S3 behind CloudFront, a university web space, a NAS.
The checklist is the same four points above. If the host offers a
single-page-app mode, leave it off.

## Where the binaries may live

By default every file a manifest names has to come from the same origin as the
manifest itself. That is the rule that makes the installer safe to hand to
someone: a release cannot quietly point the download at a third party.

To serve binaries from another host, list its origin in `catalog.json`:

```json
{
  "site": "example",
  "allowOrigins": ["https://files.example.org"],
  "systems": []
}
```

Then that host has to allow the page to read the bytes, because the browser is
doing a cross-origin `fetch`. It must send `Access-Control-Allow-Origin` with
your installer's origin, or `*`. Without it the browser blocks the response and
the install stops with a download error, which looks like a network problem and
is not.

The origin check is also repeated on the response, not only on the manifest. A
redirect is followed, but if the bytes finally arrive from an origin other than
the one that was requested, the download is rejected.

## Adding a system

1. Put the binaries somewhere the site serves, conventionally `firmware/`.
2. Build a manifest next to them with `tools/manifest.py`. See
   [manifest.md](manifest.md) for the schema and for the `preserve` profile.
3. Add an entry to `catalog.json`:

```json
{
  "id": "mysystem",
  "name": "My system",
  "device": "M5Stack Core2",
  "guide": "https://example.com/mysystem/start",
  "releases": [
    { "version": "1.2.0", "manifest": "firmware/mysystem-1-2-0.json", "channel": "stable" }
  ]
}
```

4. Run `python3 tools/check.py .` before uploading and again against the live URL
   afterwards.

`id` is what appears in the address as `?fw=mysystem`. With no `?fw=` the page
lists every system and lets the visitor choose, so a site with one system and a
site with twelve need no different code.

## A new release

Releases are listed **newest first**. The page does not sort and does not parse
version numbers; it takes the first entry that matches. So:

1. Build the new manifest.
2. Insert its release object at the **top** of that system's `releases` array.
3. Keep the old entries. Old links with `&v=1.1.0` keep working, which matters
   when a device in the field needs the version it was tested with.
4. Mark a test build `"channel": "pre"`. A visitor with no `channel` parameter
   gets the newest `stable` release and never sees it; `&channel=pre` takes the
   very first entry in the list whatever its channel.
5. Run `check.py` against the live site.

```
python3 tools/check.py https://example.com/install/
```

It downloads every part in full and compares the bytes against the declared size
and checksum, so it catches the classic mistake of updating a manifest and
forgetting to upload the binary. It exits 1 on any FAIL, which makes it usable as
the last step of a deployment script.

The tool also re-reads `index.html` and the vendored bundle each time, so a
half-finished upload that left an old `esptool-js` behind is reported:

```
OK csp index.html pins default-src to 'self'
OK vendor esptool-js-0.6.1.js matches the pinned checksum
```

## Making it look like yours

**`theme.css` holds the tokens, and a replica should not need to touch anything
else.** It defines the fonts and these custom properties on `:root`, with a dark
variant under `prefers-color-scheme`:

| Token | What it colours |
|---|---|
| `--bg`, `--bg-2` | the field and the plate |
| `--ink`, `--dim` | text, and secondary text |
| `--line` | borders and the progress track |
| `--accent`, `--accent-ink` | the one action button |
| `--warn`, `--stop`, `--done` | caution, stopped, finished |
| `--backdrop` | the dim behind a dialog |
| `--font-display`, `--font-body`, `--font-mono` | headings, body, the log |
| `--ring-width`, `--radius`, `--gap`, `--maxw` | the progress ring, corners, spacing, page width |

The state colours follow ISO 3864: blue means do this, green means safe, amber
means caution, red is reserved for stopped. Keeping that mapping is worth more
than matching your brand exactly, because it is the part a stranger reads without
reading.

To use your own fonts, replace the `@font-face` blocks and the three font
variables, and put the files under `assets/fonts/`. Keep them local: the
Content-Security-Policy allows fonts only from the page's own origin, so a Google
Fonts link will simply not load. If you drop the vendored families, remove their
files and their entries from `assets/fonts/SHA256SUMS` as well.

`style.css` is layout and can be edited too, but every element there does
something, and the ones that look decorative are usually a state indicator.

## Counting downloads

The product deliberately has no telemetry and no counter. If a publisher needs
one, it is a host concern, not a change to these files.

The usual shape is a small script on your own server that logs the request and
then redirects or streams the binary, with the manifest pointing at that script
instead of the file. Two consequences follow from the checks already described.
The script must live on an origin the manifest is allowed to use, so either the
same origin or one listed in `allowOrigins`. And if it redirects, the final
response has to stay on the origin that was requested, or the download is
rejected.

Server access logs answer the same question without any code at all, and a
privacy-respecting analytics tool can count the page view. The page also calls
`window.__esp32installAnalytics(name, props)` if the surrounding site defines it,
with `start`, `done` and `error` events. It is never defined by the installer
itself, and nothing breaks if it is absent.
