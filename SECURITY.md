# Security policy

## Supported versions

This project ships as a directory of static files that a site copies and serves
itself. There are no maintained branches: **only the current `main` is
supported.** Fixes land there, and a replica picks them up by copying the files
again.

If you run a copy, the two things worth re-checking after any update are the
pinned esptool-js checksum in `vendor/esptool-js/SHA256SUMS` and the
Content-Security-Policy in `index.html`. Both are verified by:

```
python3 tools/check.py .
```

## Reporting a vulnerability

**Report privately, through GitHub's Private Vulnerability Reporting.** Open the
repository's *Security* tab and choose *Report a vulnerability*. That creates a
private advisory visible only to the maintainers.

Please do not open a public issue for a security problem, and please do not post
it in a discussion or a pull request.

There is no security contact address for this project. Private Vulnerability
Reporting is the only channel.

## What to include

- What an attacker can do, in one sentence.
- Which files or functions are involved.
- Steps to reproduce, or a manifest and catalog that trigger it. A manifest is
  usually enough, because most of the attack surface is the release file.
- The browser and version, and the chip family if hardware is involved.
- Whether a device can be damaged or bricked, and whether user data can be read
  or written.

If a proof of concept involves a firmware image, please describe it rather than
attaching it, and never attach a flash backup: those contain Wi-Fi passwords and
other device secrets.

## What to expect

This is a volunteer project maintained in spare time, with no security team and
no on-call rotation. There is no guaranteed response time and no bug bounty.

What is promised is honest: reports are read, a reply comes when there is
something real to say rather than an automatic acknowledgement, and a confirmed
problem is fixed in `main` and described in a published advisory so that anyone
running a copy knows to update. If a report is not a vulnerability, you will be
told why.

## Out of scope

- **Malicious firmware from a site you chose to trust.** The installer verifies
  that the bytes match what the publisher declared, not that the publisher is
  honest. See [docs/security.md](docs/security.md).
- **A publisher's own site or hosting.** Report that to the publisher.
- **Missing checksums in someone's manifest.** That is a release problem;
  `tools/check.py` already warns about it.
- **Vulnerabilities in esptool-js itself.** Report those to the esptool-js
  project. If a fix requires a version bump here, an issue in this repository is
  welcome and does not need to be private.
- **Web Serial or browser behaviour.** Report to the browser vendor.
