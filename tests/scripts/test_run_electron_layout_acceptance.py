import importlib.util
import hashlib
import pathlib
import tempfile
import unittest
from unittest import mock


SCRIPT_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / 'scripts'
    / 'run-electron-layout-acceptance.py'
)
SPEC = importlib.util.spec_from_file_location(
    'run_electron_layout_acceptance',
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f'Could not load launcher module: {SCRIPT_PATH}')
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def clean_channel() -> dict:
    return {
        'sha256': 'a' * 64,
        'utf8Bytes': 1,
        'forbiddenMarkerCount': 0,
    }


def clean_mode(mode: str) -> dict:
    return {
        'passed': True,
        'mode': mode,
        'documentOuterHTML': clean_channel(),
        'messageOuterHTML': clean_channel(),
        'attributes': clean_channel(),
        'accessibilityFullTree': clean_channel(),
        'console': {'eventCount': 0, **clean_channel()},
        'network': {
            'requestCount': 0,
            'remoteRequestCount': 0,
            'fixtureRemoteRequestCount': 0,
            'urlSet': clean_channel(),
        },
        'frames': {
            'frameNavigationCount': 1 if mode == 'normal' else 0,
            'unexpectedFrameNavigationCount': 0,
            'urlSet': clean_channel(),
        },
        'targets': {
            'newTargetCount': 0,
            'targetInfoSet': clean_channel(),
        },
        'title': clean_channel(),
        'location': clean_channel(),
        'windowPolicy': {
            'titleCaptured': True,
            'locationMatchesExpectedEntry': True,
        },
        'domPolicy': {
            'cleanLinkCount': 1,
            'unsafeHrefCount': 0,
            'imgCount': 0,
            'srcCount': 0,
            'dangerousElementCount': 0,
            'blockedLinkCount': 5,
            'blockedImageCount': 1,
        },
    }


def clean_interaction(name: str) -> dict:
    return {
        'name': name,
        'passed': True,
        'locationUnchanged': True,
        'network': {
            'remoteRequestCount': 0,
            'urlSet': clean_channel(),
        },
        'frames': {
            'frameNavigationCount': 0,
            'urlSet': clean_channel(),
        },
        'targets': {'newTargetCount': 0},
        'console': {'forbiddenMarkerCount': 0},
    }


def clean_safe_markdown_security() -> dict:
    interactions = [
        clean_interaction('middle-click'),
        clean_interaction('control-click'),
        clean_interaction('shift-click'),
    ]
    return {
        'passed': True,
        'ingress': {
            'productionPathVerified': True,
            'role': 'user',
            'modelCompletionFabricated': False,
            'rowIdPositive': True,
            'exactPersisted': True,
            'fixture': {
                'sha256': 'c' * 64,
                'utf8Bytes': 100,
                'forbiddenMarkerCount': 10,
            },
        },
        'normal': clean_mode('normal'),
        'diagnostic': clean_mode('diagnostic'),
        'interactions': {
            'passed': True,
            'normal': interactions,
            'diagnostic': [dict(item) for item in interactions],
        },
        'cleanup': {
            'sessionDeleted': True,
            'normalRestored': True,
        },
        'evidence': {
            'file': 'safe-markdown-security.json',
            'sha256': 'b' * 64,
        },
    }


def complete_report() -> dict:
    return {
        'status': 'passed',
        'scope': {
            'rendererResponsiveMatrix': True,
            'windowsNativeWindowMatrix': True,
            'safeMarkdownSecurity': True,
            'pixelRegression': False,
        },
        'environment': {'profileVerified': True},
        'windowControlRelease': {
            'released': True,
            'postReleaseRequestRejected': True,
        },
        'diagnosticBoundary': {
            'normalRestored': True,
            'normalSettingsScroll': {
                'steps': 1,
                'wheelChangedScrollPosition': True,
                'targetMatches': True,
            },
            'diagnosticSettingsScroll': {
                'steps': 1,
                'wheelChangedScrollPosition': True,
                'targetMatches': True,
            },
        },
        'nativeWindowMatrix': [
            {'passed': True},
            {'passed': True},
            {'passed': True},
        ],
        'viewports': [{}, {}, {}, {}, {}],
        'boundaryShellWidths': [{}, {}, {}, {}, {}, {}],
        'safeMarkdownSecurity': clean_safe_markdown_security(),
    }


class RetryClassificationTests(unittest.TestCase):
    def test_retries_only_a_broken_cdp_timeout(self) -> None:
        report = {
            'status': 'failed',
            'error': 'TimeoutError: CDP call timed out',
            'cdpConnectionBroken': True,
            'lastCdpOperation': {'status': 'timeout'},
        }
        self.assertTrue(launcher.is_retryable_cdp_timeout(1, report))

    def test_does_not_retry_assertion_or_incomplete_timeout_evidence(self) -> None:
        self.assertFalse(launcher.is_retryable_cdp_timeout(1, {
            'status': 'failed',
            'error': 'AssertionError: layout mismatch',
            'cdpConnectionBroken': False,
            'lastCdpOperation': {'status': 'completed'},
        }))
        self.assertFalse(launcher.is_retryable_cdp_timeout(1, {
            'status': 'failed',
            'error': 'TimeoutError: wait failed',
            'cdpConnectionBroken': False,
            'lastCdpOperation': {'status': 'timeout'},
        }))
        self.assertFalse(launcher.is_retryable_cdp_timeout(1, {
            'status': 'failed',
            'error': 'TimeoutError: wait failed',
            'cdpConnectionBroken': True,
            'lastCdpOperation': {'status': 'completed'},
        }))


class CompletePassTests(unittest.TestCase):
    def test_requires_every_acceptance_gate(self) -> None:
        report = complete_report()
        self.assertTrue(launcher.is_complete_acceptance_pass(0, report))

        for mutation in (
            lambda value: value.update(status='failed'),
            lambda value: value['scope'].update(
                windowsNativeWindowMatrix=False,
            ),
            lambda value: value['scope'].update(
                safeMarkdownSecurity=False,
            ),
            lambda value: value['environment'].update(profileVerified=False),
            lambda value: value['windowControlRelease'].update(
                postReleaseRequestRejected=False,
            ),
            lambda value: value['diagnosticBoundary'][
                'normalSettingsScroll'
            ].update(wheelChangedScrollPosition=False),
            lambda value: value.update(nativeWindowMatrix=[{'passed': True}]),
            lambda value: value['safeMarkdownSecurity'][
                'normal'
            ]['accessibilityFullTree'].update(forbiddenMarkerCount=1),
            lambda value: value['safeMarkdownSecurity'][
                'diagnostic'
            ]['network'].update(remoteRequestCount=1),
            lambda value: value['safeMarkdownSecurity'][
                'interactions'
            ]['normal'][0]['targets'].update(newTargetCount=1),
            lambda value: value['safeMarkdownSecurity'][
                'cleanup'
            ].update(sessionDeleted=False),
        ):
            candidate = complete_report()
            mutation(candidate)
            self.assertFalse(
                launcher.is_complete_acceptance_pass(0, candidate),
            )

    def test_safe_markdown_gate_rejects_incomplete_evidence(self) -> None:
        security = clean_safe_markdown_security()
        self.assertTrue(launcher.is_safe_markdown_security_pass(security))

        security['ingress']['modelCompletionFabricated'] = True
        self.assertFalse(launcher.is_safe_markdown_security_pass(security))

        security = clean_safe_markdown_security()
        security['interactions']['diagnostic'].pop()
        self.assertFalse(launcher.is_safe_markdown_security_pass(security))

        security = clean_safe_markdown_security()
        security['evidence']['sha256'] = 'short'
        self.assertFalse(launcher.is_safe_markdown_security_pass(security))

    def test_zero_return_code_cannot_rescue_missing_report(self) -> None:
        self.assertFalse(launcher.is_complete_acceptance_pass(0, None))
        self.assertEqual(
            launcher.classify_acceptance_failure(0, None),
            'missing_or_invalid_report',
        )

    def test_complete_pass_verifies_the_safe_evidence_file_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            artifact_dir = pathlib.Path(directory)
            evidence_path = artifact_dir / 'safe-markdown-security.json'
            evidence_path.write_bytes(b'{"passed":true}')
            report = complete_report()
            report['safeMarkdownSecurity']['evidence']['sha256'] = hashlib.sha256(
                evidence_path.read_bytes()
            ).hexdigest()

            self.assertTrue(launcher.is_complete_acceptance_pass(
                0,
                report,
                artifact_dir,
            ))
            evidence_path.write_bytes(b'{"passed":false}')
            self.assertFalse(launcher.is_complete_acceptance_pass(
                0,
                report,
                artifact_dir,
            ))


class EnvironmentPolicyTests(unittest.TestCase):
    def test_child_environment_excludes_credential_like_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = pathlib.Path(directory) / 'profile'
            with mock.patch.dict(
                launcher.os.environ,
                {
                    'Path': 'C:\\Windows\\System32',
                    'SystemRoot': 'C:\\Windows',
                    'METIS_TEST_API_KEY': 'not-read-by-launcher',
                    'AUTHORIZATION': 'not-read-by-launcher',
                },
                clear=True,
            ):
                environment, policy = launcher.build_acceptance_environment(
                    profile,
                )

        self.assertEqual(policy['parentCredentialLikeVariableCount'], 2)
        self.assertEqual(policy['childCredentialLikeVariableCount'], 0)
        self.assertFalse(policy['credentialValuesReadByLauncher'])
        self.assertFalse(policy['normalUserEnvironmentInherited'])
        self.assertFalse(any(
            launcher.is_credential_environment_name(name)
            for name in environment
        ))
        self.assertEqual(environment['USERPROFILE'], str(profile))


if __name__ == '__main__':
    unittest.main()
