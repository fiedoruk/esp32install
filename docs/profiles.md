# The two profiles

A release picks one of two ways to install itself. `factory` writes a whole
layout and may erase the chip first. `preserve` writes only the parts it lists
into a device that already works, and never erases anything.

The profile is set by `profile` at the top of the manifest. Absent means
`factory`. A build may repeat the same value; a build that names a different
profile is refused with `manifest.profile`, because the engine installs by the
manifest's profile and a `preserve` build inside a `factory` manifest would
otherwise run through the erase path.

A file chosen from disk always runs `factory`. Step 4 takes the bytes from
memory instead of downloading them and holds them to the size and SHA-256
measured when the file was read; every other step is the same. The erase prompt
of step 8 is offered only for a file written at `0x0`; a file written anywhere
else never erases, because the bootloader and partition table it relies on are
already on the device. `preserve` cannot be chosen for it: there is no
`compatibility` data to check the device against.

## `factory`, step by step

1. **Connect.** The browser opens its port picker. If the release has exactly one
   build with USB ids, the picker is filtered to those ids; otherwise every
   serial port is offered. Cancelling here stops before the device is touched.
2. **Read the device.** The chip family, the chip description, the feature list
   and the flash size are read. The flash size comes from the JEDEC id; an
   unreadable or unknown id stops the install rather than assuming 4 MB.
3. **Match.** Builds are filtered by chip family, `flashSizeMB`, USB ids,
   `chipDescriptionIncludes` and `featuresAll`. One survivor is used directly.
   Several survivors open a board chooser. None stops the install.
4. **Download and verify.** Each part is fetched and checked in turn: not empty,
   within the size limits, exactly the declared `size`, exactly the declared
   `sha256`. A part with no declared checksum is hashed anyway and the hash goes
   into the log.
5. **Check the layout.** No part past the end of flash, no overlaps, total within
   the limit.
6. **Check the images.** Whatever covers the chip's bootloader offset must
   start with `0xE9` and carry this chip's image id. Then every part that is at
   least a header long and starts with `0xE9` must carry this chip's image id as
   well, wherever it is written; an application for another chip is refused even
   when nothing covers the bootloader offset. A data part that happens to start
   with `0xE9` is refused too. ESP8266 images carry no chip id and are not judged.
7. **Optional backup.** If the user ticked the box, the whole flash is read once
   and a **Save the copy** button appears. On a browser with a save picker the
   click opens it, suggesting `<name>-backup-<8 hex>.bin`; elsewhere the click
   downloads the file under that name. It is a keepsake: it is not read back,
   not re-verified, and never blocks the install.
8. **The erase prompt.** If the build sets `eraseAll`, the chip is erased without
   asking. Otherwise, if the manifest sets `new_install_prompt_erase`, a dialog
   asks. In *first installation* mode it reads *"This will erase everything on
   {board}, including saved Wi-Fi and settings, and install a fresh copy."* with
   **Erase and install** and **Cancel**. In *update* mode it reads *"Erasing also
   removes saved settings. You can keep them."* with **Erase and install** and
   **Keep settings**. Both second buttons mean the same thing to the engine: do
   not erase, carry on installing.
9. **Erase, if that was the answer.** This is the point of no return. Once the
   erase starts the flash is blank, so cancelling would leave a dead device.
10. **Write.** All parts go in one `writeFlash` call, compressed, with
    `eraseAll` false because step 9 already handled it. esptool-js hashes each
    image before compression and compares that hash with the MD5 it reads back
    from the chip, throwing on any mismatch.
11. **Reset.** A hard reset is attempted. A reset that fails is logged with
    advice to press reset or replug; it does not fail the install, because the
    image is already written and verified.

### Where you can still cancel

Up to and including the erase prompt. Cancellation is checked after the port
picker, after the device answered, after the board choice, after each downloaded
part, after the download as a whole, after the backup and after the erase prompt.
From the first write onwards the install runs to the end.

Closing the tab calls cancel, so a cancellation before the write leaves the
device untouched.

## `preserve`, step by step

This profile is for updating a device in the field without losing its Wi-Fi
credentials, calibration or user data. It has no erase path at all: the module
never calls `eraseFlash`.

1. **Connect and match.** As in `factory`.
2. **Check that the chip is unlocked.** The security-info command is read. All
   four flag bytes and the flash-encryption counter must be zero. A device with
   secure boot or encrypted flash is refused, and so is a device whose ROM does
   not answer that command at all, which is treated as locked.
3. **Note the identity.** The MAC address is read and kept, then re-read before
   the backup and again before the first write. A different MAC means someone
   swapped the device mid-install.
4. **Read the header and check it.** The header span covers every offset the
   manifest makes a claim about, table page included. Every `compatibility.regions`
   entry must hash to its declared `sha256`. In *update* mode the sector at
   `update.tableOffset` must hold this release's partition table, with the rest of
   the sector `0xff`. In *first installation* mode the `firstInstall.regions`
   entries must match and the `firstInstall.empty` ranges must be all `0xff`.
5. **Download and verify.** As in `factory`, including the image check on every
   part, except that `size` and `sha256` are mandatory on every part, so nothing
   unverified can reach the chip.
6. **Back up, for real this time.** The whole flash is read twice and the two
   reads must agree byte for byte. The ring shows a time estimate from the read
   rate, as the write stage does. The copy is compared against the header read
   in step 4. Then the page shows one button, **Save the copy**, with the
   sentence *"The copy is ready. Choose where to keep it, then the installation
   continues."* Nothing is saved until that click: the browser's save picker
   only opens on a user gesture. The suggested name is `<name>-backup-<8 hex>.bin`
   and the SHA-256 goes into the log.
7. **Prove the copy is on disk.** Two ways, chosen by the browser:
   - *With a save picker* (Chrome, Edge): the click opens the system's save
     dialog, the user picks a folder and may rename the file, and the bytes are
     written through that handle. The page then reads the file back through the
     same handle and compares its length and SHA-256 with the copy it made. The
     stage line reads *"Saved as {file}. Checking it can be read back."* with the
     name the user chose. The page never learns the folder: browsers do not
     expose paths, only the file name and the handle.
   - *Without one* (Brave, or any Chromium build with the File System Access API
     switched off): the click downloads the file, then a dialog names it, says
     that the browser put it in its download folder, and asks the user to choose
     it. The page checks its size and its SHA-256 against the copy it made.

   Either way the check is the gate: a copy that does not read back whole and
   identical stops the install with `backup.file` before anything is written.
   Cancelling the save picker or the file dialog stops it with `serial.cancelled`.
8. **Re-check.** The MAC is read again and the header is read again, and both
   must be identical to step 3 and step 4.
9. **Write part by part.** Each part is written on its own, `eraseAll` false. After
   each, the chip's own MD5 for that offset and length is read and compared with
   the hash of the bytes just sent.
10. **Prove nothing else moved.** The header span is read once more. The chip
    erases every whole 4 KiB sector a write touches, so two things must hold:
    inside a touched sector but outside the written part, bytes read back `0xff`;
    everywhere else in the span, bytes are identical to what was there before.
11. **Reset.** As in `factory`.

### The sector-erase rule

A part that does not start and end on a 4 KiB boundary still costs whole
sectors. Writing 3 072 bytes at `0x8000` erases `0x8000`–`0x8FFF`, so the last
1 024 bytes of that sector end up blank. The read-back in step 10 expects exactly
that: `0xff` in the padding, unchanged bytes outside the touched sectors.

This is why a partition table declared through `update.tableOffset` is checked as
a full page: the table itself against the part's `sha256`, and the remainder of
the page against `0xff`.

### Where you can still cancel

Up to step 8. Besides the checks shared with `factory` up to the download, the
`preserve` flow checks for cancellation at seven points of its own: after the
identity check, after the header comparison, after the download, after the backup
is saved, after it has been read back (or, in the download path, after the file
is handed back), after that copy has been verified, and after the final re-check.
From step 9 onwards it runs to the end.

### Part order

List the application before the partition table, as the example manifest does.
The parts are written in the order listed, so if the write fails during the
application the old table is still on the device and a retry in *first
installation* mode remains possible. Written the other way round, a failure
between the two parts leaves a table that points at an application that is not
there yet. Both tools enforce it: `tools/manifest.py` refuses a `preserve`
command line whose `--update-table` binary is not given last, and `tools/check.py`
reports `FAIL order` when the part at `update.tableOffset` is not the last part.
The rising-offset warning applies to `factory` only.

## Stop conditions

Every one of these leaves the device unwritten, unless the table says otherwise.
The sentences are the English strings the page shows, taken from
`locales/en.json`; a test in `tests/` fails if a code is missing from this page
or its sentence drifts from the file.

### The release or the catalog is at fault

| Code | Message |
|---|---|
| `manifest.url` | The address of the release file is not valid. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.notObject` | The release file is not valid. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.schema` | The release file is written in a format this installer does not know ({schema}). This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.name` | The release file does not say which system it installs. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.version` | The release file does not say which version it is. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.noBuilds` | The release file offers nothing to install. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.build` | Entry {index} of the release file is not valid. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.boardKey` | Entry {index} of the release file has an invalid name. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.chipFamily` | Build {boardKey} names a device this installer does not know ({chipFamily}). This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.profile` | Build {boardKey} asks for a way of installing this installer does not know. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.preserveNoErase` | Build {boardKey} asks to clear the whole device, which is not allowed when settings have to be kept. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.flashSizeMB` | Build {boardKey} states an invalid memory size. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.usb` | Build {boardKey} states invalid USB identifiers. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.filters` | Build {boardKey} has invalid matching rules. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.compatibility` | Build {boardKey} has invalid compatibility data. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.noParts` | Build {boardKey} has no files to install. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.part` | Build {boardKey}, file {index} is not valid. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.path` | One of the files in the release has no location to download from. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.origin` | The release points to another site ({origin}), and files have to come from this site. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.offset` | Build {boardKey}, file {index} has an invalid address. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.size` | Build {boardKey}, file {index} has an invalid size. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.sha256` | Build {boardKey}, file {index} has an invalid checksum. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.preserveNeedsSize` | Build {boardKey}, file {index} needs both a size and a checksum. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.duplicateBoardKey` | Two builds in the release file share the name {boardKey}. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `manifest.fetch` | Could not download the release file ({status}). Check your connection and try again. If it keeps failing, the release itself is broken, not your device. Tell whoever published it. |
| `catalog.fetch` | Could not load the list of systems. Check your connection and try again. If it keeps failing, this page is broken, not your device. Tell whoever runs it. |
| `catalog.unknownSystem` | There is no system called {fw} here. This is a problem with the release itself, not with your device. Tell whoever published it. |
| `catalog.unknownVersion` | This version of {fw} is not available here. This is a problem with the release itself, not with your device. Tell whoever published it. |

`manifest.compatibility` is what a `preserve` release gets when a region carries
no checksum, when it declares no region at all, when `update.tableOffset` is
missing, or when it names an offset no part is written at. All of that is
decided when the manifest is read, before the device is opened. `manifest.profile`
also covers a build whose `profile` differs from the manifest's: the page installs
by the manifest's profile and refuses a build that says otherwise.

### The download does not match the release

| Code | Message |
|---|---|
| `verify.empty` | One of the release files is empty. Nothing was written, so your device is unchanged. Try again, and tell whoever published this release if it happens again. |
| `verify.part` | One of the release files is not usable. Nothing was written, so your device is unchanged. Try again, and tell whoever published this release if it happens again. |
| `verify.tooLarge` | The file {path} is larger than this installer allows. Nothing was written. Tell whoever published this release. |
| `verify.size` | The file {path} arrived with {bytes} bytes instead of {expected}. The download was stopped and nothing was written. Check your connection and try again. |
| `verify.sha256` | The file {path} does not match the release and may have been damaged on the way. Nothing was written. Check your connection and try again. |
| `verify.overlap` | Two files in this release want the same place on the device. Nothing was written. Tell whoever published this release. |
| `verify.beyondFlash` | This release needs more memory than this device has. Nothing was written. Check that you picked the right system for your device. |
| `verify.totalTooLarge` | This release is larger than this installer allows. Nothing was written. Tell whoever published this release. |
| `verify.notAnImage` | The file for address 0x{offset} is not a program this device can start. Nothing was written. Tell whoever published this release. |
| `verify.wrongChip` | These files are made for a different device ({found}), not {expected}. Nothing was written. Check that you picked the right system for your device. |
| `verify.flashSize` | The size of the device's memory could not be determined. Nothing was written. Unplug the device, plug it back in and try again. |
| `verify.chipUnknown` | This device's chip is not one this installer knows. Nothing was written. Check that you picked the right system for your device. |

`verify.wrongChip` comes from two checks: the part that covers the chip's
bootloader offset, and every other part that starts with the image magic `0xE9`.
The second one is what catches an application built for another chip in a
`preserve` release, where nothing is written at the bootloader offset.

### The device is not the one this release expects

| Code | Message |
|---|---|
| `device.chipUnknown` | The device did not say what it is. Unplug it, plug it back in and try again. |
| `device.flashUnknown` | The size of the device's memory could not be read reliably (id 0x{id}). Nothing was written. Try another cable or another USB port. |
| `device.noMatch` | This release is not made for this device. Yours has a {chip} chip with {flash} of memory. Check that you picked the right system for your device. |
| `device.changed` | A different device is connected now. Start again with the device you want to install on. |
| `device.secured` | This device is locked by its maker (secure boot or encrypted flash), so nothing was written. Use the tools from the device's maker instead. |
| `device.layout` | This device's memory is arranged differently from the one this release was tested on. Nothing was written. Tell whoever published this release. |
| `device.notEmpty` | The area this release needs is already in use. Nothing was written. Choose First installation to clear the device and start fresh. |

`device.secured`, `device.layout`, `device.notEmpty` and `device.changed` belong
to the `preserve` profile.

### The backup

| Code | Message |
|---|---|
| `backup.mismatch` | The copy was read twice and the two reads differ. Nothing was written. Try again, ideally with a shorter cable. |
| `backup.file` | The chosen file is not a copy of this device. Choose the copy you saved from this device, or start again without one. |

`backup.file` covers both paths of step 7 in `preserve`: a file the user picked
that is not the copy, and a copy saved through a handle that does not read back
whole and identical. In both cases nothing has been written.

### The cable, the port, the write

| Code | Message |
|---|---|
| `serial.cancelled` | No device was chosen. Start again and pick your device from the list the browser shows. |
| `serial.busy` | The port is in use. Close the Arduino IDE, serial monitors or other flashing tools, then try again. |
| `serial.lost` | The device was disconnected. Plug it back in and try again. |
| `serial.connect` | The device did not answer. Try again, and on some boards hold the BOOT button while you connect. |
| `serial.blocked` | The browser did not allow access to the device. Reload the page and choose Allow when asked. |
| `flash.erase` | The device could not be cleared. Nothing was written. Reconnect the device and try again. |
| `flash.write` | Writing stopped part way. Reconnect the device and try again. Do not erase the device by hand. |
| `flash.verify` | What is on the device does not match the release. Keep your copy and try again. |
| `engine.load` | The part of this page that talks to devices could not be loaded. Reload the page and try again. |
| `engine.busy` | Something else is still running. Wait for it to finish and try again. |
| `engine.unexpected` | Something unexpected stopped the installer before anything was written. Reload the page and try again. |

`flash.write` and `flash.verify` are the two codes that can appear after writing
has begun; every other code on this page means the flash was not modified. That
distinction is in the engine: an unrecognised error becomes `engine.unexpected`
until the first write, and `flash.write` afterwards.
