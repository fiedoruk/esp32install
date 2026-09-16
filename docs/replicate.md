# Putting this on your own server

The site is static files. Copy them somewhere that serves HTTPS and you have an
installer. There is nothing to compile, no runtime, no database, and nothing that
phones a third party you did not put in the catalog yourself: the page fetches the
binaries a manifest names, from its own origin unless `allowOrigins` says
otherwise, and nothing else.

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

**Let the page revalidate.** This is the one that bites after a deployment. There
is no build step here, so a file never changes its name: `style.css` is
`style.css` in every version you will ever publish. If your host caches it for a
month — and many send `max-age` of thirty days for CSS and JavaScript by default
— then somebody who opened your installer once keeps that copy for a month, and
your fix never reaches them. Nothing warns either of you. Send
`Cache-Control: no-cache` for the page, the stylesheets, the scripts and the
JSON. That does not mean "do not store": it means "ask before you use it", and
with an ETag the answer is a 304 with no body, so revalidating costs almost
nothing. Fonts and the vendored bundles may keep a long `max-age` — their names
carry a version.

On Apache, scoped to the directory you serve the installer from:

```apache
SetEnvIf Request_URI "^/install(/|$)" INSTALLER
SetEnvIf Request_URI "^/install/assets/fonts/" !INSTALLER
Header set Cache-Control "no-cache" env=INSTALLER
Header unset Expires env=INSTALLER
```

⚠ Match the address **without** the trailing slash too. A server that answers
`/install/` with a redirect to `/install` serves the document under the shorter
address, and a pattern that insists on the slash silently misses the page itself.

On nginx, `location /install/ { add_header Cache-Control "no-cache"; }` with a
nested `location /install/assets/fonts/` that overrides it.

`tools/check.py <your url>` warns when the page comes back with a long
`max-age`, or with no `Cache-Control` at all.

Nothing else matters. No PHP, no Node, no server-side code of any kind.

One thing the files cannot do for themselves: stop another site from framing
the page. The `frame-ancestors` directive is ignored inside a `<meta>` policy,
so it is not in `index.html`; it and the older `X-Frame-Options` only work as
HTTP response headers, which the host sets. On Apache that is
`Header set Content-Security-Policy "frame-ancestors 'none'"` plus
`Header set X-Frame-Options "DENY"`; on nginx `add_header` with the same two
values. Without them the page loads and works, but can be embedded elsewhere.
Point `tools/check.py` at the live URL once it is up and it says which of the two
it sees: `WARN framing` when neither header arrives, `OK framing` when one does.
`X-Frame-Options` counts only as `DENY` or `SAMEORIGIN` — the two values browsers
still act on. `ALLOWALL`, or the `ALLOW-FROM` that browsers dropped, warns like a
missing header, because that is how the browser treats it.
A directory on disk has no headers, so only the URL form can answer this. Web
Serial itself is not delegated to a cross-origin frame by default, so a framed
copy could not reach the device even so; what framing buys an attacker is the
clicks, not the port.

## Local testing

```
python3 -m http.server 8731
python3 tools/check.py http://127.0.0.1:8731/
```

If the installer is a subdirectory of a larger site and its manifests reach
outside it, a portal that keeps binaries under `/os/` next to `/install/` say,
tell the checker where the site's root is, so `../../os/x.bin` and `/os/x.bin`
resolve as the browser will resolve them:

```
python3 tools/check.py /var/www/site/install --site-root /var/www/site
```

Without the flag the installer directory is the whole site, and a path that
leaves it is a FAIL. With it, a path may go anywhere under the site root and
still nowhere above it. A live URL never needs the flag.

`localhost` and `127.0.0.1` are treated as secure contexts by every browser
that has Web Serial (Chrome, Edge, Opera, Firefox 151 and newer), so the install
button works there and you can rehearse a release against real hardware before
you upload anything.

## Without a catalog

`catalog.json` is optional. A copy of these files with no catalog, or with an
empty `systems` list, opens straight on the own-file path: the visitor picks a
`.bin` from their disk and installs it with the same checks a release gets.
That is how the repository ships: its `catalog.json` lists no systems, so a
fresh copy is an installer for the visitor's own files and nothing else until
you add a release. `?own=1` opens that path on any copy, catalog or not, and a
catalogued install links to it under the button. `check.py` reports an empty
`systems` list as a WARN, because that is a legitimate site, and a missing
catalog as a FAIL, because a site that publishes releases is expected to have
one; on a copy that deliberately has none, that one finding is the expected one.

The own-file path also takes an address. A relative path or a URL on the same
origin is fetched and checked like a downloaded part. A URL on another origin
is blocked by the shipped policy, `connect-src 'self'`, before any request is
made, and by that origin's CORS headers if it were not; the page reports
`own.blocked` and suggests downloading the file and choosing it from disk. A
host that wants any `https:` address to work must widen the policy in
`index.html`:

```
connect-src 'self' https:
```

This is an opt-in and the shipped product does not make it: with the default
policy the field works for same-origin paths only, and a cross-origin address
ends in `own.blocked`, never in a generic network error. The trade-off of
widening: the page can then read any `https:` address the visitor types, and
the visitor may reach a file they would not have found on their own. Every
byte is still measured, its SHA-256 shown in the technical layer and held to
before the first write, and the image is still checked against the chip that is
plugged in. [security.md](security.md#content-security-policy) states the same
rule from the policy's side. The catalog path is unaffected: a manifest's parts are still held to
the manifest's origin and `allowOrigins`; only a typed address bypasses that
list. `check.py` will report the widened `connect-src` unless the origins are
passed with `--allow-origin`; `https:` as a bare scheme is not an origin, so on
such a host that finding is expected too.

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

To serve binaries from another host, three edits are needed, and the page
refuses the download until all three are in place.

**1. List the origin in `catalog.json`.** Scheme, host and port, no path:

```json
{
  "site": "example",
  "allowOrigins": ["https://files.example.org"],
  "systems": []
}
```

**2. Let the page reach it.** The Content-Security-Policy in `index.html` ships
with `connect-src 'self'`, and the browser enforces that before the installer's
own origin check ever runs. Add the origin there:

```
connect-src 'self' https://files.example.org
```

Without this edit the fetch is blocked by the page's own policy and the install
stops with a download error that looks like a network problem and is not.

**3. Let the checker know.** `tools/check.py` reads `allowOrigins` from the
catalog and accepts exactly those origins in `connect-src`, nothing more. An
origin in the policy that the catalog does not list is a FAIL; an origin in the
catalog that the policy does not name is a WARN, because the page would refuse
to download from it. An entry that is not `https:` is a FAIL and is ignored,
because the browser blocks a plain-http download on an https page; the only
exceptions are `http://localhost` and `http://127.0.0.1`. So after steps 1 and 2:

```
python3 tools/check.py .
```

```
OK csp index.html pins default-src to 'self'
```

Then that host has to allow the page to read the bytes, because the browser is
doing a cross-origin `fetch`. It must send `Access-Control-Allow-Origin` with
your installer's origin, or `*`. Without it the browser blocks the response and
the install stops with the same download error as in step 2.

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
site with twelve need no different code. `guide` has to be an `https:` address or
a path on this site; anything else is dropped and no link is shown.

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

The tool also re-reads `index.html` and the vendored files each time (the
esptool-js bundle, and the Improv client when it is shipped), so a half-finished
upload that left an old `esptool-js` behind is reported:

```
OK csp index.html pins default-src to 'self'
OK vendor esptool-js-0.6.1.js matches the pinned checksum
```

## Linking straight at one system

The list is one way in; a link is the other. Every row in the list carries a
**Copy link** button that puts that row's own address on the clipboard, so the
owner of another page can paste it there without reading this file. The addresses
are plain and you can also write them by hand:

| What the visitor gets | Address |
|---|---|
| The list of systems | `https://example.com/install/` |
| One system, newest stable release | `https://example.com/install/?fw=my-system` |
| The same, in Polish | `https://example.com/install/?fw=my-system&lang=pl` |
| One exact version, for a device tested with it | `https://example.com/install/?fw=my-system&v=1.1.0` |
| The newest release whatever its channel | `https://example.com/install/?fw=my-system&channel=pre` |
| Someone's own file from their computer | `https://example.com/install/?own=1` |

`fw` is the `id` from `catalog.json`, not the name. `lang` is always worth
spelling out on a link you publish: without it the visitor's browser decides, and
a copy served under a language path (`/pl/install/`) keeps its own language until
`lang` says otherwise.

## Making it look like yours

**`theme.css` holds the tokens, and a replica should not need to touch anything
else.** It defines the fonts and 38 custom properties on `:root`, with a dark
variant under `prefers-color-scheme`. These are the ones a repaint starts from;
open the file for the rest, which are tints, shades and edges derived from the
same palette and which will look wrong against a new one if they are left behind:

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

The two buttons in the header let a visitor pick light or dark by hand. The
choice is kept in the browser's `localStorage` under the key `theme` and put on
`<html data-theme>` by `theme-init.js`, a classic script loaded synchronously in
`<head>` so the page never paints in the wrong theme first. It is a separate file
because the policy allows no inline script. With no stored choice the page
follows the system setting, and `theme.css` already has both variants.

## The footer, and everything that says who you are

`site.json` sits next to `catalog.json` and belongs to you in the same way. The
product ships one describing itself; replace it, and the footer becomes yours.

```json
{
  "brand": "Acme Robotics",
  "tagline": "Firmware for the Acme 9000.",
  "columns": [
    { "title": "Devices", "links": [ { "text": "Acme 9000", "href": "https://acme.example/9000" } ] },
    { "title": "Project", "links": [ { "text": "Source code", "href": "https://github.com/acme/firmware" } ] }
  ],
  "bottom": [ { "text": "MIT licence", "href": "https://acme.example/licence" } ]
}
```

Every field is optional and so is the whole file. If it is missing, unreachable or
malformed the page keeps the one line that ships in `index.html` and installs
exactly as before — a footer is never allowed to stop an installer.

Two rules the page applies to what you write there:

* **Every `href` is filtered** the same way a `guide` link from the catalog is:
  `https:` and paths of your own site are kept, everything else is dropped. A
  dropped address costs the link, not the line — the words still show, without
  anything to click. So `javascript:`, `data:`, plain `http:` and `//other.host`
  will not render as links, and that is not a bug to work around.
* **Nothing is built from markup.** The text you write is text; a `<b>` in it will
  appear as `<b>`.

The bottom row of the footer carries the installer's own sign and version. That
part is the product's, not yours: it says which installer this page is, which is
what someone reporting a problem needs to tell you.

⛔ **The product itself names no site.** Nothing in `app/`, `style.css`,
`theme.css`, `locales/` or `index.html` may carry a domain, a brand or an address
of whoever publishes a copy, and `tests/site.test.js` fails the build if one
appears. That is what makes a copy of this repository yours rather than an
advertisement for someone else's.

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

If the host runs PHP, the whole thing fits in ten lines. One script per binary,
with the path written into the script — never taken from the query string, which
is how these counters turn into a way to read any file on the server:

```php
<?php
// firmware/demo.php — counts one download, then sends the file. The manifest's
// "path" for this part says "demo.php" instead of "demo.bin".
$file = __DIR__ . '/demo.bin';
// Anywhere the web server does not serve. Not this folder and not the document
// root: a log written next to the binary is fetched as easily as the binary.
$log = '/var/log/esp32install/downloads.log';
file_put_contents($log, date('c') . "\t" . basename($file) . "\n", FILE_APPEND | LOCK_EX);
header('Content-Type: application/octet-stream');
header('Content-Length: ' . filesize($file));
readfile($file);
```

One consequence to know before you run the checker: with `"path": "demo.php"` in
the manifest, `python3 tools/check.py .` on a directory measures the PHP source
instead of the binary and reports `FAIL size` and `FAIL sha256`. Check a site
that counts downloads through its URL, `python3 tools/check.py https://…/`,
where the script runs and the real bytes arrive.

The installer checks the size and the SHA-256 of what arrives, so the script has
to send the bytes unchanged: no compression the manifest does not know about, no
HTML error page in place of the file. Count the lines, not the bytes; `wc -l
downloads.log` is the number. Keep that log where the server does not hand it
out: the path above is outside the document root altogether, which is the point —
`__DIR__ . '/downloads.log'` would publish it as `/firmware/downloads.log`. Where
you cannot write outside the root, deny the file in the host's configuration.

Server access logs answer the same question without any code at all, and a
privacy-respecting analytics tool can count the page view. The page also calls
`window.__esp32installAnalytics(name, props)` if the surrounding site defines it,
with `start`, `done` and `error` events. It is never defined by the installer
itself, and nothing breaks if it is absent.

An analytics script loaded from another host needs two things the product does
not ship with. Its origin goes into `script-src` (and `script-src-elem`, if you
use it) and, if the script phones home, into `connect-src` of the policy in
`index.html`. And `tools/check.py` has to be told that this widening is yours,
because by default it accepts nothing beyond `'self'` in those directives:

```
python3 tools/check.py https://example.com/install/ --allow-origin https://stats.example.org
```

The flag is repeatable and takes an origin, not a URL. It widens `script-src`,
`script-src-elem` and `connect-src` only; `default-src` and `style-src` stay at
`'self'` whatever you pass. Origins from the catalog's `allowOrigins` are
accepted in `connect-src` without any flag.
