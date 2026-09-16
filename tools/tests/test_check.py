#!/usr/bin/env python3
"""Tests for tools/check.py — the site checker.

Everything runs against a directory on disk; no network is touched.
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

from tools import check, manifest
from tools.tests.test_manifest import esp_image, merged_image

REPO = Path(__file__).resolve().parents[2]

INDEX = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; object-src 'none'">
<title>esp32install</title></head><body></body></html>
"""

VENDOR_BUNDLE = b'export{ESPLoader,Transport};\n'


class SiteFixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.site = Path(tmp.name)
        (self.site / 'index.html').write_text(INDEX, encoding='utf-8')
        vendor = self.site / 'vendor' / 'esptool-js'
        vendor.mkdir(parents=True)
        (vendor / 'esptool-js-0.6.1.js').write_bytes(VENDOR_BUNDLE)
        (vendor / 'SHA256SUMS').write_text(
            '%s  esptool-js-0.6.1.js\n' % hashlib.sha256(VENDOR_BUNDLE).hexdigest(), encoding='utf-8')
        self.firmware = self.site / 'firmware'
        self.firmware.mkdir()
        self.bin = self.firmware / 'demo.bin'
        self.bin.write_bytes(esp_image(0))
        self.manifest_path = self.firmware / 'demo-1-0-0.json'
        self.write_manifest()
        self.write_catalog([{'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json',
                             'channel': 'stable'}])

    # --- fixture helpers -------------------------------------------------

    def write_manifest(self, offset=0x1000, **over):
        data = manifest.build_manifest(
            [manifest.Part(self.bin, offset)],
            {'chip': 'ESP32', 'name': 'Demo firmware', 'version': '1.0.0', 'out': self.manifest_path})
        data.update(over)
        self.manifest_path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
        return data

    def write_one_part_manifest(self, offset, family='ESP32', **over):
        """A manifest the generator would refuse to write, so the checker can be asked about it."""
        blob = self.bin.read_bytes()
        data = {'schema': 2, 'name': 'Demo firmware', 'version': '1.0.0', 'profile': 'factory',
                'new_install_prompt_erase': False,
                'builds': [{'chipFamily': family, 'parts': [
                    {'path': self.bin.name, 'offset': offset, 'size': len(blob),
                     'sha256': hashlib.sha256(blob).hexdigest()}]}]}
        data.update(over)
        self.write_raw_manifest(data)
        return data

    def write_index(self, policy):
        (self.site / 'index.html').write_text(
            '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="%s">'
            '</head><body></body></html>' % policy, encoding='utf-8')

    def write_raw_manifest(self, data):
        self.manifest_path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')

    def write_catalog(self, releases, **extra):
        data = {'site': 'test', 'systems': [{'id': 'demo', 'name': 'Demo', 'device': 'Any ESP32',
                                             'releases': releases}]}
        data.update(extra)
        (self.site / 'catalog.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')

    def preserve_compat(self, table_offset=0x1000, **over):
        """A complete compatibility block: the demo binary at 0x1000 stands in for the table part."""
        compat = {'regions': [{'offset': 0x8000, 'size': 0x1000, 'sha256': 'a' * 64}],
                  'update': {'tableOffset': table_offset}}
        compat.update(over)
        return compat

    def findings(self, base=None, *extra_origins):
        return check.check_site(str(base or self.site), list(extra_origins))

    def levels(self, findings, what):
        return [f.level for f in findings if f.what == what]

    def fails(self, findings):
        return [(f.what, f.detail) for f in findings if f.level == check.FAIL]

    def cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = check.main([str(a) for a in args])
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue() + err.getvalue()


class SiteTest(SiteFixture):
    # --- happy path ------------------------------------------------------

    def test_a_generated_site_passes(self):
        found = self.findings()
        self.assertEqual(self.fails(found), [])
        self.assertIn(check.OK, self.levels(found, 'sha256'))
        self.assertIn(check.OK, self.levels(found, 'csp'))
        self.assertIn(check.OK, self.levels(found, 'vendor'))

    def test_cli_prints_a_line_per_check_and_exits_0(self):
        code, text = self.cli(self.site)
        self.assertEqual(code, 0, text)
        self.assertIn('OK sha256', text)
        self.assertRegex(text, r'(?m)^SUMMARY .*0 FAIL')

    def test_cli_without_arguments_is_a_usage_error(self):
        self.assertEqual(self.cli()[0], 2)

    # --- positive controls ------------------------------------------------

    def test_positive_control_one_flipped_byte_is_a_sha256_failure(self):
        blob = bytearray(self.bin.read_bytes())
        blob[100] ^= 0xFF
        self.bin.write_bytes(bytes(blob))
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'sha256'))
        self.assertEqual(self.cli(self.site)[0], 1)

    def test_positive_control_a_missing_part_is_a_missing_failure(self):
        self.bin.unlink()
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'missing'))

    def test_positive_control_a_missing_manifest_is_a_missing_failure(self):
        self.manifest_path.unlink()
        self.assertIn(check.FAIL, self.levels(self.findings(), 'missing'))

    def test_positive_control_an_older_release_listed_first_warns(self):
        self.write_catalog([
            {'version': '0.9.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'},
            {'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'}])
        found = self.findings()
        self.assertIn(check.WARN, self.levels(found, 'order'))
        self.assertEqual(self.fails(found), [])

    def test_a_prerelease_after_the_same_stable_version_is_fine(self):
        self.write_catalog([
            {'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'},
            {'version': '1.0.0-rc1', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'pre'}])
        self.assertEqual(self.levels(self.findings(), 'order'), [])

    def test_a_prerelease_listed_before_an_older_stable_is_fine(self):
        self.write_catalog([
            {'version': '1.1.0-rc1', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'pre'},
            {'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'}])
        self.assertEqual(self.levels(self.findings(), 'order'), [])

    def test_a_stable_listed_after_its_own_prerelease_warns(self):
        self.write_catalog([
            {'version': '1.0.0-rc1', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'pre'},
            {'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'}])
        self.assertIn(check.WARN, self.levels(self.findings(), 'order'))

    def test_a_declared_size_that_does_not_match_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'][0]['size'] += 1
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'size'))

    def test_a_part_without_a_checksum_warns(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        del data['builds'][0]['parts'][0]['sha256']
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.WARN, self.levels(found, 'checksum'))
        self.assertEqual(self.fails(found), [])

    def test_overlapping_parts_fail(self):
        other = self.firmware / 'app.bin'
        other.write_bytes(b'\x00' * 4096)
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'].append({
            'path': 'app.bin', 'offset': 0x1800, 'size': 4096,
            'sha256': hashlib.sha256(other.read_bytes()).hexdigest()})
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'overlap'))

    def test_parts_out_of_order_only_warn(self):
        other = self.firmware / 'app.bin'
        other.write_bytes(b'\x00' * 16)
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'].insert(0, {
            'path': 'app.bin', 'offset': 0x100000, 'size': 16,
            'sha256': hashlib.sha256(other.read_bytes()).hexdigest()})
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.WARN, self.levels(found, 'order'))
        self.assertEqual(self.fails(found), [])

    def test_an_image_for_another_chip_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['chipFamily'] = 'ESP32-S2'  # same bootloader offset, different image id
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'chip'))
        self.assertTrue(any('ESP32' in detail for _, detail in self.fails(found)))

    def test_an_unknown_chip_family_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['chipFamily'] = 'ESP42'
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'chipFamily'))

    def test_a_chip_without_a_declared_bootloader_offset_still_has_its_image_parts_checked(self):
        self.bin.write_bytes(esp_image(20))  # 20 is ESP32-C61
        self.write_one_part_manifest(0x1000, family='ESP32-C61')
        found = self.findings()
        self.assertEqual(self.fails(found), [])
        self.assertTrue(any('no bootloader offset' in f.detail for f in found if f.what == 'chip'))
        self.assertTrue(any('is an ESP32-C61 image' in f.detail for f in found if f.what == 'chip'))
        self.bin.write_bytes(esp_image(0))  # an ESP32 image offered to a C61: the part check catches it
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'chip'))

    def test_an_application_for_another_chip_fails_wherever_it_is_written(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(esp_image(9, length=2048))  # ESP32-S3 image at 0x10000 on an ESP32 manifest
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'].append({
            'path': 'app.bin', 'offset': 0x10000, 'size': 2048,
            'sha256': hashlib.sha256(app.read_bytes()).hexdigest()})
        self.write_raw_manifest(data)
        found = self.findings()
        chip = [f for f in found if f.what == 'chip']
        self.assertEqual([f.level for f in chip], [check.OK, check.FAIL], [str(f) for f in chip])
        self.assertIn('app.bin at 0x10000', chip[1].detail)
        self.assertIn('ESP32-S3', chip[1].detail)

    def test_a_matching_application_image_is_reported_and_a_data_part_is_not_judged(self):
        app = self.firmware / 'app.bin'
        app.write_bytes(esp_image(0, length=2048))
        data_part = self.firmware / 'data.bin'
        data_part.write_bytes(b'\x00' * 512)
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'].extend([
            {'path': 'app.bin', 'offset': 0x10000, 'size': 2048,
             'sha256': hashlib.sha256(app.read_bytes()).hexdigest()},
            {'path': 'data.bin', 'offset': 0x20000, 'size': 512,
             'sha256': hashlib.sha256(data_part.read_bytes()).hexdigest()}])
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertEqual(self.fails(found), [])
        self.assertEqual(self.levels(found, 'chip'), [check.OK, check.OK])

    def test_a_missing_csp_fails(self):
        (self.site / 'index.html').write_text('<!doctype html><html><head></head><body></body></html>',
                                              encoding='utf-8')
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))

    def test_a_weak_csp_fails(self):
        (self.site / 'index.html').write_text(
            '<meta http-equiv="Content-Security-Policy" content="script-src *">', encoding='utf-8')
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))

    def test_a_tampered_vendor_bundle_fails(self):
        path = self.site / 'vendor' / 'esptool-js' / 'esptool-js-0.6.1.js'
        path.write_bytes(VENDOR_BUNDLE + b'\n')
        self.assertIn(check.FAIL, self.levels(self.findings(), 'vendor'))

    def test_a_missing_vendor_sumfile_fails(self):
        (self.site / 'vendor' / 'esptool-js' / 'SHA256SUMS').unlink()
        self.assertIn(check.FAIL, self.levels(self.findings(), 'missing'))

    def test_a_broken_catalog_fails(self):
        (self.site / 'catalog.json').write_text('{ not json', encoding='utf-8')
        self.assertIn(check.FAIL, self.levels(self.findings(), 'json'))

    def test_a_part_outside_the_site_root_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'][0]['path'] = '../../elsewhere/demo.bin'
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'path'))

    def test_a_manifest_without_builds_fails(self):
        self.write_raw_manifest({'name': 'D', 'version': '1', 'builds': []})
        self.assertIn(check.FAIL, self.levels(self.findings(), 'manifest'))



class ShapeTest(SiteFixture):
    """Fixes asked for in review: merged images, a parsed CSP, and shapes the page refuses."""

    # --- merged images ---------------------------------------------------

    def test_a_merged_image_is_read_deep_enough_to_find_its_header(self):
        self.bin.write_bytes(merged_image(0))  # 68 KB at offset 0, ESP32 header at 0x1000
        self.write_manifest(offset=0)
        found = self.findings()
        self.assertEqual(self.fails(found), [])
        self.assertIn(check.OK, self.levels(found, 'chip'))

    def test_a_merged_image_for_another_chip_fails(self):
        self.bin.write_bytes(merged_image(9))  # 9 is ESP32-S3
        self.write_one_part_manifest(0, family='ESP32')
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'chip'))
        self.assertTrue(any('ESP32-S3' in detail for what, detail in self.fails(found) if what == 'chip'))

    def test_a_merged_image_on_a_chip_that_boots_at_0x2000_is_checked_there(self):
        self.bin.write_bytes(merged_image(18, header_at=0x2000))  # 18 is ESP32-P4
        self.write_one_part_manifest(0, family='ESP32-P4')
        self.assertEqual(self.fails(self.findings()), [])

    # --- the policy is parsed, not searched -------------------------------

    def test_a_widened_default_src_fails(self):
        self.write_index("default-src 'self' https://evil.example *; script-src 'self'")
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'csp'))
        self.assertTrue(any('evil.example' in detail for what, detail in self.fails(found) if what == 'csp'))

    def test_a_default_src_that_only_looks_right_fails(self):
        self.write_index("default-src 'self-hosted'; script-src 'self'")
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))

    @staticmethod
    def policy_with(directive, sources):
        """default-src first, unless the directive under test is default-src itself."""
        head = "default-src 'self'; " if directive != 'default-src' else ''
        return "%s%s 'self' %s" % (head, directive, sources)

    def test_no_third_party_is_allowed_in_any_directive_by_default(self):
        for directive in ('script-src', 'script-src-elem', 'connect-src', 'style-src', 'default-src'):
            with self.subTest(directive=directive):
                self.write_index(self.policy_with(directive, 'https://stats.example'))
                found = self.findings()
                self.assertIn(check.FAIL, self.levels(found, 'csp'))
                self.assertTrue(any('stats.example' in detail for what, detail in self.fails(found) if what == 'csp'))

    def test_no_counter_origin_is_special_without_the_flag(self):
        self.write_index("default-src 'self'; script-src 'self' https://counter.example")
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))
        self.assertEqual(self.levels(self.findings(None, 'https://counter.example'), 'csp'), [check.OK])

    def test_allow_origin_widens_script_and_connect_but_not_style_or_default(self):
        for directive, ok in (('script-src', True), ('script-src-elem', True), ('connect-src', True),
                              ('style-src', False), ('default-src', False)):
            with self.subTest(directive=directive):
                self.write_index(self.policy_with(directive, 'https://stats.example'))
                levels = self.levels(self.findings(None, 'https://stats.example'), 'csp')
                self.assertEqual(levels, [check.OK] if ok else [check.FAIL])

    def test_allow_origin_is_repeatable_and_exact(self):
        self.write_index("default-src 'self'; script-src 'self' https://a.example https://b.example")
        self.assertEqual(self.levels(self.findings(None, 'https://a.example', 'https://b.example'), 'csp'), [check.OK])
        self.assertIn(check.FAIL, self.levels(self.findings(None, 'https://a.example'), 'csp'))
        self.assertIn(check.FAIL, self.levels(self.findings(None, 'https://a.example', 'https://c.example'), 'csp'))

    def test_allow_origin_on_the_command_line(self):
        self.write_index("default-src 'self'; script-src 'self' https://stats.example; connect-src 'self' https://stats.example")
        self.assertEqual(self.cli(self.site)[0], 1)
        code, text = self.cli(self.site, '--allow-origin', 'https://stats.example')
        self.assertEqual(code, 0, text)
        self.assertIn("OK csp", text)

    def test_a_malformed_allow_origin_is_a_usage_error(self):
        for bad in ('stats.example', 'https://stats.example/path', 'https://stats.example/', "'self'", '*'):
            with self.subTest(origin=bad):
                code, text = self.cli(self.site, '--allow-origin', bad)
                self.assertEqual(code, 2, text)
                self.assertNotIn('FAIL', text)

    def test_catalog_allow_origins_widen_connect_src_only(self):
        self.write_catalog([{'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'}],
                           allowOrigins=['https://files.example'])
        self.write_index("default-src 'self'; connect-src 'self' https://files.example")
        found = self.findings()
        self.assertEqual(self.levels(found, 'csp'), [check.OK])
        self.assertEqual(self.fails(found), [])
        self.write_index("default-src 'self'; connect-src 'self' https://other.example")
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))
        self.write_index("default-src 'self'; script-src 'self' https://files.example; connect-src 'self' https://files.example")
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))

    def test_an_allow_origin_the_policy_does_not_name_warns(self):
        self.write_catalog([{'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'}],
                           allowOrigins=['https://files.example'])
        found = self.findings()
        self.assertEqual(self.levels(found, 'csp'), [check.OK, check.WARN])
        self.assertTrue(any('files.example' in f.detail for f in found if f.level == check.WARN))
        self.assertEqual(self.fails(found), [])

    def test_a_malformed_allow_origins_list_fails_and_widens_nothing(self):
        for bad in ('https://files.example', ['https://files.example/downloads'], ['files.example'], [42], ['*']):
            with self.subTest(allowOrigins=bad):
                self.write_catalog([{'version': '1.0.0', 'manifest': 'firmware/demo-1-0-0.json', 'channel': 'stable'}],
                                   allowOrigins=bad)
                self.write_index("default-src 'self'; connect-src 'self' https://files.example")
                found = self.findings()
                self.assertIn(check.FAIL, self.levels(found, 'catalog'))
                self.assertIn(check.FAIL, self.levels(found, 'csp'))

    def test_is_origin(self):
        for good in ('https://files.example', 'http://localhost:8731', 'https://a-b.example.org:8443'):
            self.assertTrue(check.is_origin(good), good)
        for bad in ('https://files.example/', 'files.example', 'ftp://files.example', 'https://', "'self'",
                    'https://files.example:123456', 42, None):
            self.assertFalse(check.is_origin(bad), repr(bad))

    def test_a_policy_without_default_src_fails(self):
        self.write_index("script-src 'self'")
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))

    def test_a_minimal_correct_policy_passes(self):
        self.write_index("default-src 'self'; script-src 'self'")
        found = self.findings()
        self.assertEqual(self.fails(found), [])
        self.assertIn(check.OK, self.levels(found, 'csp'))

    def test_the_quotes_inside_the_attribute_survive_parsing(self):
        self.write_index("default-src 'self'")
        tag = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
        self.assertEqual(check.meta_attributes(tag)['content'], "default-src 'self'")
        self.assertEqual(self.levels(self.findings(), 'csp'), [check.OK])

    def test_the_other_fetch_directives_are_checked_too(self):
        for policy, ok in (("default-src 'self'; connect-src 'self'", True),
                           ("default-src 'self'; connect-src 'self' https://evil.example", False),
                           ("default-src 'self'; script-src-elem 'self'", True),
                           ("default-src 'self'; script-src-elem 'self' 'unsafe-inline'", False),
                           ("default-src 'self'; style-src 'self'", True),
                           ("default-src 'self'; style-src 'self' https://fonts.example", False)):
            with self.subTest(policy=policy):
                self.write_index(policy)
                levels = self.levels(self.findings(), 'csp')
                self.assertEqual(levels, [check.OK] if ok else [check.FAIL])

    def test_only_the_first_policy_has_to_carry_default_src(self):
        head = ('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
                '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">')
        (self.site / 'index.html').write_text('<!doctype html><html><head>%s</head></html>' % head,
                                              encoding='utf-8')
        self.assertEqual(self.levels(self.findings(), 'csp'), [check.OK])

    def test_a_later_policy_that_widens_a_directive_fails(self):
        head = ('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
                '<meta http-equiv="Content-Security-Policy" content="script-src * \'self\'">')
        (self.site / 'index.html').write_text('<!doctype html><html><head>%s</head></html>' % head,
                                              encoding='utf-8')
        self.assertIn(check.FAIL, self.levels(self.findings(), 'csp'))

    # --- shapes the page refuses ------------------------------------------

    def test_a_malformed_board_key_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['boardKey'] = 'no spaces'
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('boardKey' in detail for what, detail in self.fails(found)))

    def test_two_builds_with_the_same_board_key_fail(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        build = dict(data['builds'][0], boardKey='core2')
        data['builds'] = [build, dict(build)]
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('core2' in detail for what, detail in self.fails(found)))

    def test_two_builds_with_different_keys_are_fine(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'] = [dict(data['builds'][0], boardKey='core2'),
                          dict(data['builds'][0], boardKey='tab5')]
        self.write_raw_manifest(data)
        self.assertEqual(self.fails(self.findings()), [])

    def test_preserve_without_a_compatibility_region_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('region' in detail for what, detail in self.fails(found)))

    def test_preserve_with_an_empty_region_list_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = {'regions': [], 'firstInstall': {'regions': []}}
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'manifest'))

    def test_preserve_with_a_first_install_region_is_enough(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = {
            'firstInstall': {'regions': [{'offset': 0x8000, 'size': 0x1000, 'sha256': 'a' * 64}]},
            'update': {'tableOffset': 0x1000}}
        self.write_raw_manifest(data)
        self.assertEqual(self.fails(self.findings()), [])

    def test_a_complete_preserve_manifest_passes(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = self.preserve_compat()
        self.write_raw_manifest(data)
        self.assertEqual(self.fails(self.findings()), [])

    def test_preserve_with_a_region_without_a_checksum_fails(self):
        for where in ('regions', 'first'):
            with self.subTest(where=where):
                data = json.loads(self.manifest_path.read_text('utf-8'))
                data['profile'] = 'preserve'
                region = {'offset': 0x8000, 'size': 0x1000}
                compat = (self.preserve_compat(regions=[region]) if where == 'regions'
                          else self.preserve_compat(firstInstall={'regions': [region]}))
                data['builds'][0]['compatibility'] = compat
                self.write_raw_manifest(data)
                found = self.findings()
                self.assertIn(check.FAIL, self.levels(found, 'manifest'))
                self.assertTrue(any('sha256' in detail for what, detail in self.fails(found)))

    def test_preserve_with_a_malformed_region_checksum_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = self.preserve_compat(
            regions=[{'offset': 0x8000, 'size': 0x1000, 'sha256': 'xyz'}])
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'manifest'))

    def test_preserve_without_an_update_table_offset_fails(self):
        for update in (None, {}, {'tableOffset': -1}, {'tableOffset': '0x1000'}, 'x'):
            with self.subTest(update=update):
                data = json.loads(self.manifest_path.read_text('utf-8'))
                data['profile'] = 'preserve'
                compat = self.preserve_compat()
                if update is None:
                    del compat['update']
                else:
                    compat['update'] = update
                data['builds'][0]['compatibility'] = compat
                self.write_raw_manifest(data)
                found = self.findings()
                self.assertIn(check.FAIL, self.levels(found, 'manifest'))
                self.assertTrue(any('tableOffset' in detail for what, detail in self.fails(found)))

    def test_preserve_with_a_table_offset_no_part_is_written_at_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = self.preserve_compat(table_offset=0x8000)
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('0x8000' in detail and 'no part' in detail for what, detail in self.fails(found)))

    def test_preserve_with_a_part_that_has_no_checksum_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = self.preserve_compat()
        del data['builds'][0]['parts'][0]['sha256']
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('preserve' in detail for what, detail in self.fails(found)))

    def test_a_build_profile_that_differs_from_the_manifest_fails(self):
        # factory manifest, preserve build: the page would run it through the erase path.
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['profile'] = 'preserve'
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('never change it' in detail for what, detail in self.fails(found)))
        # preserve manifest, factory build: the same finding the other way round.
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'preserve'
        data['builds'][0]['profile'] = 'factory'
        data['builds'][0]['compatibility'] = self.preserve_compat()
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertTrue(any('never change it' in detail for what, detail in self.fails(found)))

    def test_a_build_may_repeat_the_manifest_profile(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['profile'] = 'factory'
        self.write_raw_manifest(data)
        self.assertEqual(self.fails(self.findings()), [])
        data['profile'] = 'preserve'
        data['builds'][0]['profile'] = 'preserve'
        data['builds'][0]['compatibility'] = self.preserve_compat()
        self.write_raw_manifest(data)
        self.assertEqual(self.fails(self.findings()), [])

    def test_an_unknown_profile_on_a_build_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['profile'] = 'whatever'
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('whatever' in detail for what, detail in self.fails(found)))

    def test_a_board_key_with_a_trailing_newline_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['boardKey'] = 'core2\n'
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'manifest'))
        self.assertTrue(any('boardKey' in detail for what, detail in self.fails(found)))

    def test_an_unknown_profile_fails(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['profile'] = 'whatever'
        self.write_raw_manifest(data)
        self.assertIn(check.FAIL, self.levels(self.findings(), 'manifest'))

    # --- keep going with what could be read --------------------------------

    def test_an_overlap_is_still_reported_when_another_part_is_missing(self):
        gone = self.firmware / 'gone.bin'
        present = self.firmware / 'app.bin'
        present.write_bytes(b'\x00' * 4096)
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['parts'].extend([
            {'path': 'app.bin', 'offset': 0x1800, 'size': 4096,
             'sha256': hashlib.sha256(present.read_bytes()).hexdigest()},
            {'path': gone.name, 'offset': 0x40000, 'size': 16, 'sha256': 'f' * 64}])
        self.write_raw_manifest(data)
        found = self.findings()
        self.assertIn(check.FAIL, self.levels(found, 'missing'))
        self.assertIn(check.FAIL, self.levels(found, 'overlap'))

    # --- a base we cannot check at all --------------------------------------

    def test_a_directory_that_is_not_there_is_one_usage_error(self):
        code, text = self.cli(self.site / 'nowhere')
        self.assertEqual(code, 2)
        self.assertEqual(len(text.strip().splitlines()), 1, text)
        self.assertNotIn('FAIL', text)

    def test_check_site_raises_for_a_directory_that_is_not_there(self):
        with self.assertRaises(check.UsageError):
            check.check_site(str(self.site / 'nowhere'))

    def test_a_missing_catalog_is_reported_once_and_the_policy_is_still_checked(self):
        (self.site / 'catalog.json').unlink()
        found = self.findings()
        self.assertEqual(self.levels(found, 'missing'), [check.FAIL])
        self.assertEqual(self.levels(found, 'csp'), [check.OK])
        self.assertEqual(self.levels(found, 'vendor'), [check.OK])


class HelperTest(unittest.TestCase):
    """The pieces of the HTTP path that can be exercised without a socket."""

    def test_origin_ignores_the_path(self):
        self.assertEqual(check.origin('https://example.com/a/b'), check.origin('https://example.com/c'))
        self.assertNotEqual(check.origin('https://example.com/'), check.origin('http://example.com/'))
        self.assertNotEqual(check.origin('https://example.com/'), check.origin('https://other.com/'))

    def test_an_http_base_is_recognised_and_gets_a_trailing_slash(self):
        source = check.make_source('https://example.com/install')
        self.assertIsInstance(source, check.HttpSource)
        self.assertEqual(source.root(), 'https://example.com/install/')

    def test_manifest_paths_resolve_like_the_browser(self):
        source = check.make_source('https://example.com/install/')
        manifest_ref = source.join(source.root(), 'firmware/demo.json')
        self.assertEqual(manifest_ref, 'https://example.com/install/firmware/demo.json')
        self.assertEqual(source.join(manifest_ref, '../../os/demo.bin'), 'https://example.com/os/demo.bin')

    def test_a_cross_origin_redirect_is_refused(self):
        handler = check.NoCrossOriginRedirect()
        request = check.urllib.request.Request('https://example.com/a')
        with self.assertRaises(check.CrossOriginRedirect):
            handler.redirect_request(request, None, 302, 'Found', {}, 'https://evil.example/a')

    def test_unquote_drops_only_the_outer_delimiter(self):
        self.assertEqual(check.unquote('"default-src \'self\'"'), "default-src 'self'")
        self.assertEqual(check.unquote("'width=device-width'"), 'width=device-width')
        self.assertEqual(check.unquote('bare'), 'bare')
        self.assertEqual(check.unquote('"'), '"')

    def test_version_comparison(self):
        self.assertTrue(check.newer('1.0.0', '0.9.9'))
        self.assertTrue(check.newer('1.0.0', '1.0.0-rc1'))
        self.assertFalse(check.newer('1.0.0-rc1', '1.0.0'))
        self.assertFalse(check.newer('1.0.0', '1.0.0'))
        self.assertTrue(check.newer('1.1', '1.0.9'))
        self.assertFalse(check.newer('nightly', '1.0.0'))  # unparseable: no opinion


class ShippedDemoTest(unittest.TestCase):
    """The installer ships a working demo; the checker has to agree it works."""

    def test_the_repository_itself_passes(self):
        found = check.check_site(str(REPO))
        fails = [(f.what, f.detail) for f in found if f.level == check.FAIL]
        self.assertEqual(fails, [])
        self.assertIn(check.OK, [f.level for f in found if f.what == 'sha256'])

    def test_the_shipped_policy_is_accepted(self):
        """The product's own index.html, not a fixture: the parser must accept what we ship."""
        found = check.check_site(str(REPO))
        self.assertEqual([f.level for f in found if f.what == 'csp'], [check.OK])


if __name__ == '__main__':
    unittest.main()
