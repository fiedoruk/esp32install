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
from tools.tests.test_manifest import esp_image

REPO = Path(__file__).resolve().parents[2]

INDEX = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; object-src 'none'">
<title>esp32install</title></head><body></body></html>
"""

VENDOR_BUNDLE = b'export{ESPLoader,Transport};\n'


class SiteTest(unittest.TestCase):
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

    def write_manifest(self, **over):
        data = manifest.build_manifest(
            [manifest.Part(self.bin, 0x1000)],
            {'chip': 'ESP32', 'name': 'Demo firmware', 'version': '1.0.0', 'out': self.manifest_path})
        data.update(over)
        self.manifest_path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
        return data

    def write_raw_manifest(self, data):
        self.manifest_path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')

    def write_catalog(self, releases):
        (self.site / 'catalog.json').write_text(json.dumps(
            {'site': 'test', 'systems': [{'id': 'demo', 'name': 'Demo', 'device': 'Any ESP32',
                                          'releases': releases}]}, indent=2) + '\n', encoding='utf-8')

    def findings(self, base=None):
        return check.check_site(str(base or self.site))

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

    def test_a_chip_without_a_declared_bootloader_offset_is_skipped(self):
        data = json.loads(self.manifest_path.read_text('utf-8'))
        data['builds'][0]['chipFamily'] = 'ESP32-C61'
        self.write_raw_manifest(data)
        self.assertEqual(self.fails(self.findings()), [])

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


if __name__ == '__main__':
    unittest.main()
