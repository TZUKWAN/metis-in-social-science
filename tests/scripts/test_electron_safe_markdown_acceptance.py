import importlib.util
import json
import pathlib
import unittest


SCRIPT_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / 'scripts'
    / 'electron-layout-acceptance.py'
)
SPEC = importlib.util.spec_from_file_location(
    'electron_layout_acceptance',
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f'Could not load acceptance module: {SCRIPT_PATH}')
acceptance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acceptance)


class SafeMarkdownEvidenceTests(unittest.TestCase):
    def test_fixture_is_explicitly_user_authored_and_contains_hostile_vectors(self) -> None:
        content = acceptance.SAFE_MARKDOWN_FIXTURE.read_text(encoding='utf-8')
        self.assertIn(acceptance.SAFE_MARKDOWN_MARKER, content)
        self.assertIn('not a model completion', content)
        self.assertIn('goal001-tracker.invalid', content)
        self.assertIn('GOAL001_AUTH_SECRET', content)
        self.assertIn('<iframe', content)

    def test_channel_summary_contains_only_hashes_counts_and_no_raw_marker(self) -> None:
        raw = 'Authorization: Bearer GOAL001_AUTH_SECRET'
        summary = acceptance.summarize_captured_value(raw)
        rendered = json.dumps(summary, sort_keys=True)

        self.assertEqual(summary['forbiddenMarkerCount'], 1)
        self.assertEqual(len(summary['sha256']), 64)
        self.assertNotIn('GOAL001_AUTH_SECRET', rendered)
        self.assertNotIn(raw, rendered)

    def test_network_summary_detects_remote_fixture_requests_without_echoing_url(self) -> None:
        raw_url = (
            'https://goal001-tracker.invalid/pixel.png'
            '?token=GOAL001_IMAGE_SECRET'
        )
        events = [{
            'method': 'Network.requestWillBeSent',
            'params': {'request': {'url': raw_url}},
        }]
        summary = acceptance.summarize_network_events(events)
        rendered = json.dumps(summary, sort_keys=True)

        self.assertEqual(summary['remoteRequestCount'], 1)
        self.assertEqual(summary['fixtureRemoteRequestCount'], 1)
        self.assertNotIn(raw_url, rendered)
        self.assertNotIn('GOAL001_IMAGE_SECRET', rendered)

    def test_navigation_and_target_summaries_do_not_echo_urls(self) -> None:
        navigation_url = 'https://goal001-frame.invalid/GOAL001_IFRAME_SECRET'
        page_events = [{
            'method': 'Page.frameNavigated',
            'params': {'frame': {'url': navigation_url}},
        }]
        browser_events = [{
            'method': 'Target.targetCreated',
            'params': {
                'targetInfo': {'type': 'page', 'url': navigation_url},
            },
        }]

        frames = acceptance.summarize_frame_events(page_events)
        targets = acceptance.summarize_target_events(browser_events)
        rendered = json.dumps({'frames': frames, 'targets': targets}, sort_keys=True)

        self.assertEqual(frames['unexpectedFrameNavigationCount'], 1)
        self.assertEqual(targets['newTargetCount'], 1)
        self.assertNotIn(navigation_url, rendered)
        self.assertNotIn('GOAL001_IFRAME_SECRET', rendered)


if __name__ == '__main__':
    unittest.main()
