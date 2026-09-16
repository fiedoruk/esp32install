#!/usr/bin/env python3
"""Tests for tools/manifest.py — the manifest generator.

Run from the repository root:
    python3 -m unittest discover -s tools/tests -t .
"""
import contextlib
import hashlib
import io
import json
import re
import tempfile
import unittest
from pathlib import Path

from tools import manifest


def esp_image(chip_id=0, length=4096, magic=0xE9, header_at=0):
    """A synthetic ESP image: magic byte, then the chip id at bytes 12-13 (little endian)."""
    blob = bytearray(b'\xff' * length)
    blob[header_at] = magic
    blob[header_at + 12] = chip_id & 0xFF
    blob[header_at + 13] = (chip_id >> 8) & 0xFF
    return bytes(blob)


def merged_image(chip_id=0, length=68 * 1024, header_at=0x1000):
    """One blob written at offset 0 whose bootloader header sits deep inside it."""
    return esp_image(chip_id, length=length, header_at=header_at)


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

    def test_improv_lands_in_the_build_as_true(self):
        code, text = self.generate('--improv')
        self.assertEqual(code, 0, text)
        build = json.loads(self.out.read_text('utf-8'))['builds'][0]
        self.assertIs(build['improv'], True)

    def test_optional_fields_are_left_out_when_not_asked_for(self):
        self.assertEqual(self.generate()[0], 0)
        build = json.loads(self.out.read_text('utf-8'))['builds'][0]
        for key in ('boardKey', 'board', 'flashSizeMB', 'usbVendorId', 'usbProductId', 'compatibility', 'improv'):
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

    def test_a_merged_image_is_checked_at_the_bootloader_offset(self):
        merged = self.firmware / 'merged.bin'
        merged.write_bytes(merged_image(0))  # header at 0x1000, blob larger than the head sample
        code, text = self.cli(merged, '--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out)
        self.assertEqual(code, 0, text)

    def test_a_merged_image_for_another_chip_exits_1(self):
        merged = self.firmware / 'merged.bin'
        merged.write_bytes(merged_image(9))
        code, text = self.cli(merged, '--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out)
        self.assertEqual(code, 1, text)
        self.assertIn('ESP32-S3', text)

    def test_a_deep_climb_asks_for_a_path_prefix(self):
        deep = self.root / 'a' / 'b' / 'c' / 'd'
        deep.mkdir(parents=True)
        code, text = self.cli(f'{self.bin}@0x1000', '--chip', 'ESP32', '--name', 'D', '--version', '1',
                              '--out', deep / 'demo.json')
        self.assertEqual(code, 2, text)
        self.assertIn('--path-prefix', text)
        self.assertFalse((deep / 'demo.json').exists())

    def test_two_levels_up_is_still_written_without_a_prefix(self):
        deep = self.root / 'a' / 'b'
        deep.mkdir(parents=True)
        out = deep / 'demo.json'
        code, text = self.cli(f'{self.bin}@0x1000', '--chip', 'ESP32', '--name', 'D', '--version', '1',
                              '--out', out)
        self.assertEqual(code, 0, text)
        self.assertEqual(json.loads(out.read_text('utf-8'))['builds'][0]['parts'][0]['path'],
                         '../../firmware/demo.bin')

    def test_a_deep_climb_is_fine_once_a_prefix_says_how_the_site_serves_it(self):
        deep = self.root / 'a' / 'b' / 'c' / 'd'
        deep.mkdir(parents=True)
        code, text = self.cli(f'{self.bin}@0x1000', '--chip', 'ESP32', '--name', 'D', '--version', '1',
                              '--path-prefix', '../../os/', '--out', deep / 'demo.json')
        self.assertEqual(code, 0, text)

    # --- usage errors ---------------------------------------------------

    def test_the_esptool_spelling_of_a_chip_family_is_accepted(self):
        """A publisher arrives with `esp32s3` from their build log, not with `ESP32-S3`."""
        boot = self.firmware / 'boot-s3.bin'
        boot.write_bytes(esp_image(9))
        code, text = self.cli(boot, '--chip', 'esp32s3', '--name', 'D', '--version', '2', '--out', self.out)
        self.assertEqual(code, 0, text)
        self.assertEqual(json.loads(self.out.read_text())['builds'][0]['chipFamily'], 'ESP32-S3')

    def test_unknown_chip_family_is_a_usage_error(self):
        code, _ = self.cli(self.bin, '--chip', 'ESP42', '--name', 'D', '--version', '1', '--out', self.out)
        self.assertEqual(code, 2)

    def test_preserve_without_a_region_is_a_usage_error(self):
        code, text = self.generate('--profile', 'preserve')
        self.assertEqual(code, 2, text)
        self.assertIn('preserve', text.lower())

    def test_a_bad_board_key_is_a_usage_error(self):
        self.assertEqual(self.generate('--board-key', 'no spaces')[0], 2)

    def test_a_board_key_with_a_trailing_newline_is_a_usage_error(self):
        self.assertEqual(self.generate('--board-key', 'core2\n')[0], 2)

    def test_a_malformed_usb_id_is_a_usage_error(self):
        self.assertEqual(self.generate('--usb', '1a86')[0], 2)

    def test_a_malformed_region_is_a_usage_error(self):
        self.assertEqual(self.generate('--profile', 'preserve', '--compat-region', '0x0')[0], 2)

    def test_a_region_without_a_checksum_is_a_usage_error(self):
        for flag in ('--compat-region', '--first-region'):
            with self.subTest(flag=flag):
                code, text = self.generate('--profile', 'preserve', flag, '0x0:0x8000', '--update-table', '0x1000')
                self.assertEqual(code, 2, text)
                self.assertIn('SHA256', text)
                self.assertFalse(self.out.exists())

    def test_the_importable_api_refuses_a_preserve_region_without_a_checksum(self):
        with self.assertRaises(manifest.UsageError) as caught:
            manifest.build_manifest(
                [manifest.Part(self.bin, 0x1000)],
                manifest.Options(chip='ESP32', name='D', version='1', out=self.out, profile='preserve',
                                 compat_regions=[manifest.Region(0, 0x8000)], update_table=0x1000))
        self.assertIn('checksum', str(caught.exception))

    def test_preserve_without_an_update_table_is_a_usage_error(self):
        code, text = self.generate('--profile', 'preserve', '--compat-region', '0x0:0x8000:' + 'a' * 64)
        self.assertEqual(code, 2, text)
        self.assertIn('--update-table', text)
        self.assertFalse(self.out.exists())

    def test_an_update_table_with_no_part_at_that_offset_is_a_usage_error(self):
        code, text = self.generate('--profile', 'preserve', '--compat-region', '0x0:0x8000:' + 'a' * 64,
                                   '--update-table', '0x8000')  # the only part sits at 0x1000
        self.assertEqual(code, 2, text)
        self.assertIn('0x8000', text)
        self.assertFalse(self.out.exists())

    def test_an_application_for_another_chip_is_refused_in_the_preserve_profile(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(esp_image(9, length=2048))  # an ESP32-S3 application, nowhere near the bootloader offset
        table = self.firmware / 'table.bin'
        table.write_bytes(b'\x00' * 3072)
        code, text = self.cli(f'{app}@0x10000', f'{table}@0x8000', '--chip', 'ESP32', '--name', 'D',
                              '--version', '1', '--profile', 'preserve', '--update-table', '0x8000',
                              '--compat-region', '0x0:0x8000:' + 'a' * 64, '--out', self.out)
        self.assertEqual(code, 1, text)
        self.assertIn('ESP32-S3', text)
        self.assertIn('0x10000', text)
        self.assertFalse(self.out.exists())

    def test_an_application_for_another_chip_is_refused_in_the_factory_profile_too(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(esp_image(9, length=2048))
        code, text = self.cli(f'{self.bin}@0x1000', f'{app}@0x10000', '--chip', 'ESP32', '--name', 'D',
                              '--version', '1', '--out', self.out)
        self.assertEqual(code, 1, text)
        self.assertIn('ESP32-S3', text)

    def test_a_data_part_that_does_not_start_like_an_image_is_not_judged(self):
        data = self.firmware / 'data.bin'
        data.write_bytes(b'\x00' * 4096)
        code, text = self.cli(f'{self.bin}@0x1000', f'{data}@0x10000', '--chip', 'ESP32', '--name', 'D',
                              '--version', '1', '--out', self.out)
        self.assertEqual(code, 0, text)

    def test_an_esp8266_image_carries_no_chip_id_and_is_not_judged(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(esp_image(9, length=2048))
        code, text = self.cli(f'{app}@0x10000', '--chip', 'ESP8266', '--name', 'D', '--version', '1',
                              '--out', self.out)
        self.assertEqual(code, 0, text)

    def test_image_part_problem_mirrors_the_page(self):
        self.assertIsNone(manifest.image_part_problem('ESP32', esp_image(0), 4096))
        self.assertIn('ESP32-S3', manifest.image_part_problem('ESP32', esp_image(9), 4096))
        self.assertIsNone(manifest.image_part_problem('ESP32', esp_image(9), 23), 'shorter than a header')
        self.assertIsNone(manifest.image_part_problem('ESP32', esp_image(9, magic=0x00), 4096), 'no magic')
        self.assertIsNone(manifest.image_part_problem('ESP8266', esp_image(9), 4096))
        self.assertIsNotNone(manifest.image_part_problem('ESP32', esp_image(9), 24), '24 bytes is a header')

    # --- preserve profile ------------------------------------------------

    def test_preserve_emits_compatibility_in_the_shape_the_page_accepts(self):
        digest = 'a' * 64
        table = self.firmware / 'table.bin'
        table.write_bytes(b'\x00' * 3072)
        code, text = self.cli(
            f'{self.bin}@0x10000', f'{table}@0x8000', '--chip', 'ESP32', '--name', 'Demo firmware',
            '--version', '1.0.0', '--out', self.out,
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
        self.assertEqual([p['offset'] for p in data['builds'][0]['parts']], [0x10000, 0x8000])

    def test_preserve_refuses_a_table_binary_that_is_not_given_last(self):
        table = self.firmware / 'table.bin'
        table.write_bytes(b'\x00' * 3072)
        common = ['--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out, '--profile', 'preserve',
                  '--compat-region', '0x0:0x8000:' + 'a' * 64, '--update-table', '0x8000']
        code, text = self.cli(f'{table}@0x8000', f'{self.bin}@0x10000', *common)
        self.assertEqual(code, 2, text)
        self.assertIn('last', text)
        self.assertIn('application first', text)
        self.assertFalse(self.out.exists())
        code, text = self.cli(f'{self.bin}@0x10000', f'{table}@0x8000', *common)
        self.assertEqual(code, 0, text)
        self.assertEqual([p['offset'] for p in json.loads(self.out.read_text('utf-8'))['builds'][0]['parts']],
                         [0x10000, 0x8000], 'nothing is reordered')

    def test_preserve_refuses_a_part_that_does_not_start_on_a_sector_boundary(self):
        table = self.firmware / 'table.bin'
        table.write_bytes(b'\x00' * 3072)
        common = ['--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out, '--profile', 'preserve',
                  '--compat-region', '0x0:0x8000:' + 'a' * 64, '--update-table', '0x8000']
        code, text = self.cli(f'{self.bin}@0x10800', f'{table}@0x8000', *common)
        self.assertEqual(code, 2, text)
        self.assertIn('boundary', text)
        self.assertIn('0x10800', text)
        self.assertFalse(self.out.exists(), 'nothing is written when a part is misaligned')
        # The table itself is held to the same rule.
        code, text = self.cli(f'{self.bin}@0x10000', f'{table}@0x8800',
                              *[a if a != '0x8000' else '0x8800' for a in common])
        self.assertEqual(code, 2, text)
        self.assertFalse(self.out.exists())
        # Positive control: the same command with aligned offsets writes the manifest.
        code, text = self.cli(f'{self.bin}@0x10000', f'{table}@0x8000', *common)
        self.assertEqual(code, 0, text)
        self.assertEqual([p['offset'] for p in json.loads(self.out.read_text('utf-8'))['builds'][0]['parts']],
                         [0x10000, 0x8000])

    def test_preserve_refuses_a_part_that_is_not_a_whole_number_of_sectors(self):
        """The end of a part costs a whole sector too, and blanks what sat after it."""
        table = self.firmware / 'table.bin'
        table.write_bytes(b'\x00' * 3072)
        ragged = self.firmware / 'app.bin'
        ragged.write_bytes(esp_image(0, length=5000))
        common = ['--chip', 'ESP32', '--name', 'D', '--version', '1', '--out', self.out, '--profile', 'preserve',
                  '--compat-region', '0x0:0x8000:' + 'a' * 64, '--update-table', '0x8000']
        code, text = self.cli(f'{ragged}@0x10000', f'{table}@0x8000', *common)
        self.assertEqual(code, 2, text)
        self.assertIn('whole number', text)
        self.assertIn('5000 bytes', text)
        self.assertIn('Pad the file', text)
        self.assertFalse(self.out.exists(), 'nothing is written when a part ends mid-sector')
        # The table page is the exception, and the 4 096-byte application beside it is fine.
        code, text = self.cli(f'{self.bin}@0x10000', f'{table}@0x8000', *common)
        self.assertEqual(code, 0, text)
        self.assertEqual([p['size'] for p in json.loads(self.out.read_text('utf-8'))['builds'][0]['parts']],
                         [4096, 3072])

    def test_the_ragged_length_exception_follows_the_table_offset(self):
        """It is the part at --update-table that may end mid-sector, not any file called a table."""
        table = self.firmware / 'table.bin'
        table.write_bytes(b'\x00' * 3072)
        code, text = self.cli(f'{table}@0x10000', f'{self.bin}@0x8000', '--chip', 'ESP32', '--name', 'D',
                              '--version', '1', '--out', self.out, '--profile', 'preserve',
                              '--compat-region', '0x0:0x8000:' + 'a' * 64, '--update-table', '0x8000')
        self.assertEqual(code, 2, text)
        self.assertIn('3072 bytes', text)
        self.assertFalse(self.out.exists())

    def test_a_factory_manifest_may_be_written_at_an_unaligned_offset(self):
        """The rule belongs to preserve: factory writes a whole layout and keeps nothing."""
        code, text = self.cli(f'{self.bin}@0x10800', '--chip', 'ESP32', '--name', 'D', '--version', '1',
                              '--out', self.out)
        self.assertEqual(code, 0, text)
        self.assertEqual(json.loads(self.out.read_text('utf-8'))['builds'][0]['parts'][0]['offset'], 0x10800)

    def test_a_region_checksum_is_lower_cased(self):
        digest = 'A' * 64
        code, text = self.generate('--profile', 'preserve', '--compat-region', f'0x0:0x8000:{digest}',
                                   '--update-table', '0x1000')
        self.assertEqual(code, 0, text)
        compat = json.loads(self.out.read_text('utf-8'))['builds'][0]['compatibility']
        self.assertEqual(compat['regions'], [{'offset': 0, 'size': 0x8000, 'sha256': 'a' * 64}])

    def test_a_factory_manifest_needs_neither_regions_nor_a_table(self):
        self.assertEqual(self.generate()[0], 0)

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

    ROW = re.compile(r"'([A-Za-z0-9-]+)':\s*row\(([^)]*)\)")

    @staticmethod
    def value(token):
        token = token.strip()
        if token == 'null':
            return None
        if token.startswith("'"):
            return token.strip("'")
        return int(token, 0)

    def test_table_matches_verify_js(self):
        source = (Path(__file__).resolve().parents[2] / 'app' / 'verify.js').read_text('utf-8')
        rows = {name: [self.value(f) for f in fields.split(',')]
                for name, fields in self.ROW.findall(source)}
        self.assertTrue(rows, 'no chip rows found in app/verify.js')
        self.assertEqual(set(rows), set(manifest.CHIPS), 'the two chip tables list different families')
        for family, (offset, image_id, esptool_chip) in rows.items():
            chip = manifest.CHIPS[family]
            self.assertEqual(chip.bootloader_offset, offset, family)
            self.assertEqual(chip.image_chip_id, image_id, family)
            self.assertEqual(chip.esptool_chip, esptool_chip, family)

    def test_the_head_sample_reaches_every_bootloader_header(self):
        """Both tools keep this much of a part; it has to clear the deepest header in the table."""
        offsets = [chip.bootloader_offset for chip in manifest.CHIPS.values()
                   if chip.bootloader_offset is not None]
        self.assertGreater(manifest.HEAD_SAMPLE, max(offsets) + manifest.ESP_IMAGE_HEADER_BYTES)
        for family, chip in manifest.CHIPS.items():
            if chip.bootloader_offset is not None:
                self.assertGreaterEqual(manifest.HEAD_SAMPLE,
                                        chip.bootloader_offset + manifest.ESP_IMAGE_HEADER_BYTES, family)


if __name__ == '__main__':
    unittest.main()
