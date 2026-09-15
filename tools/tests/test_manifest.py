#!/usr/bin/env python3
"""Tests for tools/manifest.py — the manifest generator.

Run from the repository root:
    python3 -m unittest discover -s tools/tests -t .
"""
import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from tools import manifest


def esp_image(chip_id=0, length=4096, magic=0xE9):
    """A synthetic ESP image: magic byte, then the chip id at bytes 12-13 (little endian)."""
    blob = bytearray(b'\xff' * length)
    blob[0] = magic
    blob[12] = chip_id & 0xFF
    blob[13] = (chip_id >> 8) & 0xFF
    return bytes(blob)


class GeneratorTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.firmware = self.root / 'firmware'
        self.firmware.mkdir()
        self.bin = self.firmware / 'demo.bin'
        self.bin.write_bytes(esp_image(0))
        self.out = self.firmware / 'demo-1-0-0.json'

    def cli(self, *args):
        """Run the command line in process; return (exit code, everything it printed)."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = manifest.main([str(a) for a in args])
            except SystemExit as exc:  # argparse usage errors
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue() + err.getvalue()

    def generate(self, *extra, source=None):
        code, text = self.cli(
            f'{source or self.bin}@0x1000', '--chip', 'ESP32', '--name', 'Demo firmware',
            '--version', '1.0.0', '--out', self.out, *extra)
        return code, text

    # --- happy path -----------------------------------------------------

    def test_writes_a_schema_2_manifest_with_size_and_sha256(self):
        code, text = self.generate('--prompt-erase')
        self.assertEqual(code, 0, text)
        data = json.loads(self.out.read_text('utf-8'))
        self.assertEqual(data['schema'], 2)
        self.assertEqual(data['name'], 'Demo firmware')
        self.assertEqual(data['version'], '1.0.0')
        self.assertEqual(data['profile'], 'factory')
        self.assertIs(data['new_install_prompt_erase'], True)
        build = data['builds'][0]
        self.assertEqual(build['chipFamily'], 'ESP32')
        part = build['parts'][0]
        self.assertEqual(part['path'], 'demo.bin')
        self.assertEqual(part['offset'], 0x1000)
        self.assertEqual(part['size'], self.bin.stat().st_size)
        self.assertEqual(part['sha256'], hashlib.sha256(self.bin.read_bytes()).hexdigest())

    def test_file_ends_with_a_single_newline_and_has_no_crlf(self):
        self.assertEqual(self.generate()[0], 0)
        raw = self.out.read_bytes()
        self.assertNotIn(b'\r', raw)
        self.assertTrue(raw.endswith(b'\n'))
        self.assertFalse(raw.endswith(b'\n\n'))

    def test_board_flash_and_usb_land_in_the_build(self):
        code, text = self.generate(
            '--board', 'M5Stack Core2', '--board-key', 'core2', '--flash-mb', '16', '--usb', '1a86:55d4')
        self.assertEqual(code, 0, text)
        build = json.loads(self.out.read_text('utf-8'))['builds'][0]
        self.assertEqual(build['boardKey'], 'core2')
        self.assertEqual(build['board'], 'M5Stack Core2')
        self.assertEqual(build['flashSizeMB'], 16)
        self.assertEqual(build['usbVendorId'], 0x1A86)
        self.assertEqual(build['usbProductId'], 0x55D4)

    def test_optional_fields_are_left_out_when_not_asked_for(self):
        self.assertEqual(self.generate()[0], 0)
        build = json.loads(self.out.read_text('utf-8'))['builds'][0]
        for key in ('boardKey', 'board', 'flashSizeMB', 'usbVendorId', 'usbProductId', 'compatibility'):
            self.assertNotIn(key, build)
        self.assertIs(json.loads(self.out.read_text('utf-8'))['new_install_prompt_erase'], False)

    def test_a_bin_without_an_offset_is_offset_zero(self):
        boot = self.firmware / 'boot.bin'
        boot.write_bytes(esp_image(9, length=2048))
        code, text = self.cli(boot, '--chip', 'ESP32-S3', '--name', 'D', '--version', '2', '--out', self.out)
        self.assertEqual(code, 0, text)
        self.assertEqual(json.loads(self.out.read_text('utf-8'))['builds'][0]['parts'][0]['offset'], 0)

    def test_several_parts_keep_their_offsets(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(b'\x00' * 1024)
        code, text = self.cli(
            f'{self.bin}@0x1000', f'{app}@0x10000', '--chip', 'ESP32', '--name', 'D', '--version', '1',
            '--out', self.out)
        self.assertEqual(code, 0, text)
        parts = json.loads(self.out.read_text('utf-8'))['builds'][0]['parts']
        self.assertEqual([p['offset'] for p in parts], [0x1000, 0x10000])
        self.assertEqual([p['path'] for p in parts], ['demo.bin', 'app.bin'])

    # --- paths ----------------------------------------------------------

    def test_default_path_is_relative_to_the_manifest_directory(self):
        nested = self.root / 'bin'
        nested.mkdir()
        blob = nested / 'other.bin'
        blob.write_bytes(esp_image(0))
        code, text = self.generate(source=blob)
        self.assertEqual(code, 0, text)
        path = json.loads(self.out.read_text('utf-8'))['builds'][0]['parts'][0]['path']
        self.assertEqual(path, '../bin/other.bin')

    def test_path_prefix_replaces_the_directory(self):
        code, text = self.generate('--path-prefix', '../../os/')
        self.assertEqual(code, 0, text)
        path = json.loads(self.out.read_text('utf-8'))['builds'][0]['parts'][0]['path']
        self.assertEqual(path, '../../os/demo.bin')

    def test_path_prefix_without_a_trailing_slash_still_separates(self):
        self.assertEqual(self.generate('--path-prefix', 'bin')[0], 0)
        path = json.loads(self.out.read_text('utf-8'))['builds'][0]['parts'][0]['path']
        self.assertEqual(path, 'bin/demo.bin')

    # --- positive controls: the generator must refuse bad input ---------

    def test_positive_control_wrong_chip_in_the_image_exits_1(self):
        self.bin.write_bytes(esp_image(9))  # 9 is ESP32-S3
        code, text = self.generate()
        self.assertEqual(code, 1, text)
        self.assertIn('ESP32-S3', text)

    def test_positive_control_overlapping_parts_exit_1(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(b'\x00' * 4096)
        code, text = self.cli(
            f'{self.bin}@0x1000', f'{app}@0x1800', '--chip', 'ESP32', '--name', 'D', '--version', '1',
            '--out', self.out)
        self.assertEqual(code, 1, text)
        self.assertIn('overlap', text.lower())
        self.assertFalse(self.out.exists())

    def test_missing_file_exits_1(self):
        code, text = self.generate(source=self.firmware / 'nope.bin')
        self.assertEqual(code, 1, text)
        self.assertIn('nope.bin', text)

    def test_empty_file_exits_1(self):
        self.bin.write_bytes(b'')
        code, text = self.generate()
        self.assertEqual(code, 1, text)
        self.assertIn('empty', text.lower())

    def test_negative_offset_exits_1(self):
        code, text = self.cli(
            f'{self.bin}@-16', '--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out)
        self.assertEqual(code, 1, text)

    def test_a_missing_boot_image_magic_exits_1(self):
        self.bin.write_bytes(esp_image(0, magic=0x00))
        code, text = self.generate()
        self.assertEqual(code, 1, text)

    def test_an_image_away_from_the_bootloader_offset_is_not_header_checked(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(b'\x00' * 1024)  # no ESP header, and nothing at 0x1000
        code, text = self.cli(
            f'{app}@0x10000', '--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out)
        self.assertEqual(code, 0, text)

    # --- usage errors ---------------------------------------------------

    def test_unknown_chip_family_is_a_usage_error(self):
        code, _ = self.cli(self.bin, '--chip', 'ESP42', '--name', 'D', '--version', '1', '--out', self.out)
        self.assertEqual(code, 2)

    def test_preserve_without_a_region_is_a_usage_error(self):
        code, text = self.generate('--profile', 'preserve')
        self.assertEqual(code, 2, text)
        self.assertIn('preserve', text.lower())

    def test_a_bad_board_key_is_a_usage_error(self):
        self.assertEqual(self.generate('--board-key', 'no spaces')[0], 2)

    def test_a_malformed_usb_id_is_a_usage_error(self):
        self.assertEqual(self.generate('--usb', '1a86')[0], 2)

    def test_a_malformed_region_is_a_usage_error(self):
        self.assertEqual(self.generate('--profile', 'preserve', '--compat-region', '0x0')[0], 2)

    # --- preserve profile ------------------------------------------------

    def test_preserve_emits_compatibility_in_the_shape_the_page_accepts(self):
        digest = 'a' * 64
        code, text = self.generate(
            '--profile', 'preserve',
            '--compat-region', f'0x0:0x8000:{digest}',
            '--first-region', f'0x8000:0x1000:{digest}',
            '--first-empty', '0x10000:0x10000',
            '--update-table', '0x8000')
        self.assertEqual(code, 0, text)
        data = json.loads(self.out.read_text('utf-8'))
        self.assertEqual(data['profile'], 'preserve')
        compat = data['builds'][0]['compatibility']
        self.assertEqual(compat['regions'], [{'offset': 0, 'size': 0x8000, 'sha256': digest}])
        self.assertEqual(compat['firstInstall']['regions'],
                         [{'offset': 0x8000, 'size': 0x1000, 'sha256': digest}])
        self.assertEqual(compat['firstInstall']['empty'], [{'offset': 0x10000, 'size': 0x10000}])
        self.assertEqual(compat['update']['tableOffset'], 0x8000)

    def test_a_region_checksum_is_optional(self):
        self.assertEqual(self.generate('--profile', 'preserve', '--compat-region', '0x0:0x8000')[0], 0)
        compat = json.loads(self.out.read_text('utf-8'))['builds'][0]['compatibility']
        self.assertEqual(compat['regions'], [{'offset': 0, 'size': 0x8000}])

    # --- importable API --------------------------------------------------

    def test_build_manifest_is_importable_and_takes_plain_values(self):
        data = manifest.build_manifest(
            [manifest.Part(self.bin, 0x1000)],
            {'chip': 'ESP32', 'name': 'Demo', 'version': '1.0.0', 'out': self.out})
        self.assertEqual(data['builds'][0]['parts'][0]['offset'], 0x1000)
        self.assertEqual(data['name'], 'Demo')

    def test_build_manifest_raises_instead_of_exiting(self):
        with self.assertRaises(manifest.ManifestError):
            manifest.build_manifest(
                [manifest.Part(self.firmware / 'nope.bin', 0)],
                manifest.Options(chip='ESP32', name='D', version='1', out=self.out))


class ChipTableTest(unittest.TestCase):
    """The table mirrors app/verify.js; drift between them breaks verification silently."""

    def test_table_matches_verify_js(self):
        source = (Path(__file__).resolve().parents[2] / 'app' / 'verify.js').read_text('utf-8')
        for family, chip in manifest.CHIPS.items():
            needle = "'%s':" % family
            self.assertIn(needle, source, family)
        self.assertEqual(manifest.CHIPS['ESP32'].bootloader_offset, 0x1000)
        self.assertEqual(manifest.CHIPS['ESP32'].image_chip_id, 0)
        self.assertEqual(manifest.CHIPS['ESP32-S3'].image_chip_id, 9)
        self.assertIsNone(manifest.CHIPS['ESP32-C61'].bootloader_offset)
        self.assertIsNone(manifest.CHIPS['ESP8266'].image_chip_id)


if __name__ == '__main__':
    unittest.main()
