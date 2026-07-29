import argparse
import base64
import hashlib
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

import websocket


REVIEW_VIEWPORTS = (1440, 1300, 1100, 850, 650)
BOUNDARY_SHELL_WIDTHS = (899, 900, 901, 1199, 1200, 1201)
NATIVE_CONTENT_CASES = (
    ('minimum', 1000, 700, 'narrow'),
    ('medium', 1300, 900, 'medium'),
    ('wide', 1500, 900, 'wide'),
)
EXPECTED_ENTRY = (
    pathlib.Path(__file__).resolve().parents[1] / 'dist' / 'index.html'
).resolve()
SAFE_MARKDOWN_FIXTURE = (
    pathlib.Path(__file__).resolve().parents[1]
    / 'tests'
    / 'fixtures'
    / 'safe-markdown-hostile.md'
).resolve()
SAFE_MARKDOWN_MARKER = 'GOAL001_SAFE_MARKDOWN_FIXTURE'
SAFE_MARKDOWN_CLEAN_URL = 'https://goal001-clean.invalid/safe/path'
SAFE_MARKDOWN_REMOTE_HOSTS = (
    'goal001-tracker.invalid',
    'goal001-raw-image.invalid',
    'goal001-frame.invalid',
)
SAFE_MARKDOWN_FORBIDDEN_MARKERS = (
    'GOAL001_USERINFO_SECRET',
    'GOAL001_QUERY_SECRET',
    'GOAL001_FRAGMENT_SECRET',
    'GOAL001_ENCODED_SECRET',
    'GOAL001_BARE_SECRET',
    'GOAL001_BARE_FRAGMENT_SECRET',
    'GOAL001_ALT_SECRET',
    'GOAL001_IMAGE_SECRET',
    'GOAL001_IMAGE_FRAGMENT_SECRET',
    'GOAL001_TITLE_SECRET',
    'GOAL001_JAVASCRIPT_SECRET',
    'GOAL001_DATA_SECRET',
    'GOAL001_FILE_SECRET',
    'GOAL001_RELATIVE_SECRET',
    'GOAL001_AUTH_SECRET',
    'GOAL001_PATH_SECRET',
    'GOAL001_UNC_HOST_SECRET',
    'GOAL001_UNC_SHARE_SECRET',
    'GOAL001_POSIX_SECRET',
    'GOAL001_RAW_HREF_SECRET',
    'GOAL001_RAW_TITLE_SECRET',
    'GOAL001_RAW_ARIA_SECRET',
    'GOAL001_RAW_IMAGE_SECRET',
    'GOAL001_RAW_ALT_SECRET',
    'GOAL001_ONERROR_SECRET',
    'GOAL001_IFRAME_SECRET',
)
DIAGNOSTIC_ONLY_SELECTORS = (
    '[data-testid="diagnostic-mcp-settings"]',
    '[data-testid="diagnostic-hitl-settings"]',
    '[data-testid="diagnostic-skill-controls"]',
    '[data-testid="diagnostic-terminal-toggle"]',
    '.terminal-panel',
    '.error-boundary-details',
    '.approval-queue-technical-details',
    '.approval-modal-technical-details',
)


def canonical_file_url(value: str) -> pathlib.Path | None:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != 'file':
        return None
    path = urllib.request.url2pathname(parsed.path)
    if sys.platform == 'win32' and path.startswith('/'):
        path = path[1:]
    try:
        return pathlib.Path(path).resolve()
    except OSError:
        return None


def is_clean_expected_entry_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return bool(
        parsed.scheme == 'file'
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
        and canonical_file_url(value) == EXPECTED_ENTRY
    )


def wait_for_target(port: int, timeout: int = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                f'http://127.0.0.1:{port}/json/list',
                timeout=2,
            ) as response:
                targets = json.load(response)
            pages = [target for target in targets if target.get('type') == 'page']
            matches = [
                target for target in pages
                if canonical_file_url(str(target.get('url', ''))) == EXPECTED_ENTRY
            ]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise RuntimeError(
                    f'Multiple renderer targets point to {EXPECTED_ENTRY}: {len(matches)}'
                )
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(
        f'No unique renderer target for {EXPECTED_ENTRY} appeared on CDP port {port}'
    )


def wait_for_browser_target(port: int, timeout: int = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                f'http://127.0.0.1:{port}/json/version',
                timeout=2,
            ) as response:
                version = json.load(response)
            websocket_url = version.get('webSocketDebuggerUrl')
            if isinstance(websocket_url, str) and websocket_url:
                return {
                    'type': 'browser',
                    'title': 'browser',
                    'url': '',
                    'webSocketDebuggerUrl': websocket_url,
                }
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(
        f'No browser CDP target appeared on port {port}'
    )


class CDP:
    def __init__(
        self,
        page: dict,
        port: int,
        trace_path: pathlib.Path,
        call_timeout: float = 15,
    ):
        self.socket = websocket.create_connection(
            page['webSocketDebuggerUrl'],
            origin=f'http://127.0.0.1:{port}',
            timeout=call_timeout,
        )
        self.next_id = 1
        self.call_timeout = call_timeout
        self.phase = 'startup'
        self.broken = False
        self.last_event: str | None = None
        self.last_operation: dict | None = None
        self.events: list[dict] = []
        self.trace_file = trace_path.open('w', encoding='utf-8')

    def set_phase(self, phase: str) -> None:
        self.phase = phase
        self._trace('phase', phase=phase)

    def _trace(self, kind: str, **details) -> None:
        record = {
            'unixMs': int(time.time() * 1000),
            'kind': kind,
            **details,
        }
        self.trace_file.write(json.dumps(record, ensure_ascii=False) + '\n')
        self.trace_file.flush()

    def close(self) -> None:
        try:
            self.socket.close()
        finally:
            self.trace_file.close()

    def _record_event(self, message: dict) -> None:
        self.events.append(message)
        self.last_event = message.get('method')
        self._trace(
            'event',
            phase=self.phase,
            method=self.last_event,
        )

    def clear_events(self) -> None:
        self.events.clear()

    def take_events(self, method: str | None = None) -> list[dict]:
        if method is None:
            events = self.events
            self.events = []
            return events
        matching = [event for event in self.events if event.get('method') == method]
        self.events = [event for event in self.events if event.get('method') != method]
        return matching

    def pump_events(self, duration: float = 0.5) -> None:
        if self.broken:
            raise RuntimeError(
                f'CDP connection is unusable after {self.last_operation}'
            )
        deadline = time.monotonic() + duration
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            self.socket.settimeout(remaining)
            try:
                message = json.loads(self.socket.recv())
            except websocket.WebSocketTimeoutException:
                return
            if 'id' in message:
                self.broken = True
                raise RuntimeError(
                    'CDP received an unexpected response while collecting events: '
                    f'{message.get("id")}'
                )
            self._record_event(message)

    def call(
        self,
        method: str,
        params: dict | None = None,
        timeout: float | None = None,
    ) -> dict:
        if self.broken:
            raise RuntimeError(
                f'CDP connection is unusable after {self.last_operation}'
            )

        request_id = self.next_id
        self.next_id += 1
        started = time.monotonic()
        deadline = started + (timeout or self.call_timeout)
        self.last_operation = {
            'phase': self.phase,
            'method': method,
            'requestId': request_id,
            'status': 'pending',
        }
        self._trace(
            'send',
            phase=self.phase,
            method=method,
            requestId=request_id,
        )
        try:
            self.socket.send(json.dumps({
                'id': request_id,
                'method': method,
                'params': params or {},
            }))
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise websocket.WebSocketTimeoutException()
                self.socket.settimeout(remaining)
                message = json.loads(self.socket.recv())
                if message.get('id') != request_id:
                    if 'id' in message:
                        self.broken = True
                        raise RuntimeError(
                            'CDP received an unexpected response id: '
                            f'expected={request_id}, actual={message.get("id")}'
                        )
                    self._record_event(message)
                    continue
                elapsed_ms = round((time.monotonic() - started) * 1000)
                if message.get('error'):
                    self.last_operation = {
                        **self.last_operation,
                        'status': 'error',
                        'elapsedMs': elapsed_ms,
                    }
                    self._trace(
                        'error',
                        **self.last_operation,
                    )
                    raise RuntimeError(f'{method}: {message["error"]}')
                self.last_operation = {
                    **self.last_operation,
                    'status': 'completed',
                    'elapsedMs': elapsed_ms,
                }
                self._trace('result', **self.last_operation)
                return message
        except websocket.WebSocketTimeoutException as error:
            self.broken = True
            elapsed_ms = round((time.monotonic() - started) * 1000)
            self.last_operation = {
                **self.last_operation,
                'status': 'timeout',
                'elapsedMs': elapsed_ms,
                'lastEvent': self.last_event,
            }
            self._trace('timeout', **self.last_operation)
            raise TimeoutError(
                'CDP call timed out: '
                f'phase={self.phase}, method={method}, id={request_id}, '
                f'elapsedMs={elapsed_ms}, lastEvent={self.last_event}'
            ) from error

    def evaluate(self, expression: str, await_promise: bool = False):
        response = self.call('Runtime.evaluate', {
            'expression': expression,
            'awaitPromise': await_promise,
            'returnByValue': True,
        })
        result = response.get('result', {})
        if result.get('exceptionDetails'):
            raise RuntimeError(
                result['exceptionDetails'].get('text', 'Renderer evaluation failed')
            )
        remote = result.get('result', {})
        if remote.get('subtype') == 'error':
            raise RuntimeError(remote.get('description', 'Renderer evaluation failed'))
        return remote.get('value')


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def wait_for(cdp: CDP, expression: str, timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cdp.evaluate(f'Boolean({expression})'):
            return
        time.sleep(0.1)
    raise AssertionError(f'Timed out waiting for: {expression}')


def wait_for_after_reload(cdp: CDP, expression: str, timeout: float = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if cdp.evaluate(f'Boolean({expression})'):
                return
        except RuntimeError:
            if cdp.broken:
                raise
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for renderer recovery after reload')


def wait_for_stable_layout(cdp: CDP, timeout: float = 20) -> None:
    expression = r"""
    (() => {
      const root =
        document.querySelector('.project-shell') ??
        document.querySelector('.app-layout');
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      const shell = document.querySelector('.project-shell');
      const shellWidth = shell?.clientWidth ?? 0;
      const actualBand = shell?.dataset.responsiveBand ?? '';
      const expectedBand = !shell
        ? ''
        : shellWidth <= 900
          ? 'narrow'
          : shellWidth <= 1200
            ? 'medium'
            : 'wide';
      return {
        signature: [
          window.innerWidth,
          window.innerHeight,
          document.documentElement.scrollWidth,
          document.documentElement.scrollHeight,
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          shellWidth,
          actualBand,
        ].join('|'),
        responsiveConsistent:
          !shell || actualBand === expectedBand,
        shellWidth,
        actualBand,
        expectedBand,
      };
    })()
    """
    deadline = time.time() + timeout
    previous = None
    last_observed = None
    stable_samples = 0
    while time.time() < deadline:
        current = cdp.evaluate(expression)
        last_observed = current
        if current is None or not current['responsiveConsistent']:
            previous = None
            stable_samples = 0
        elif current['signature'] == previous:
            stable_samples += 1
            if stable_samples >= 2:
                return
        else:
            previous = current['signature']
            stable_samples = 0
        time.sleep(0.05)
    raise AssertionError(
        'Layout did not stabilize before timeout; '
        f'last observation={last_observed}'
    )


def capture(cdp: CDP, output_path: pathlib.Path) -> None:
    cdp.set_phase(f'screenshot:{output_path.name}')
    response = cdp.call('Page.captureScreenshot', {
        'format': 'png',
        'captureBeyondViewport': False,
    }, timeout=30)
    output_path.write_bytes(base64.b64decode(response['result']['data']))


def physical_click(
    cdp: CDP,
    selector: str,
    text: str | None = None,
) -> dict:
    cdp.set_phase(f'click:{selector}:{text or "first"}')
    target = cdp.evaluate(f"""
    (() => {{
      const candidates = [...document.querySelectorAll({json.dumps(selector)})];
      const element = {('candidates.find((candidate) => candidate.textContent?.trim() === ' + json.dumps(text) + ')') if text is not None else 'candidates[0]'};
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {{
        x,
        y,
        width: rect.width,
        height: rect.height,
        insideViewport:
          x >= 0 && x <= window.innerWidth &&
          y >= 0 && y <= window.innerHeight,
        disabled: Boolean(element.disabled),
        pointerEvents: style.pointerEvents,
        visibility: style.visibility,
        display: style.display,
        targetMatches: hit === element || Boolean(hit && element.contains(hit)),
        hitTag: hit?.tagName || null,
        hitClass: String(hit?.className || ''),
      }};
    }})()
    """)
    require(target is not None, f'Could not find physical click target: {selector}: {text}')
    require(target['width'] > 0 and target['height'] > 0,
            f'Click target has no area: {selector}: {target}')
    require(target['insideViewport'], f'Click target is outside viewport: {selector}: {target}')
    require(not target['disabled'], f'Click target is disabled: {selector}')
    require(target['pointerEvents'] != 'none', f'Click target has pointer-events:none: {selector}')
    require(target['visibility'] != 'hidden' and target['display'] != 'none',
            f'Click target is not visible: {selector}')
    require(target['targetMatches'], f'Click target is occluded: {selector}: {target}')
    cdp.call('Input.dispatchMouseEvent', {
        'type': 'mousePressed',
        'x': target['x'],
        'y': target['y'],
        'button': 'left',
        'clickCount': 1,
    })
    cdp.call('Input.dispatchMouseEvent', {
        'type': 'mouseReleased',
        'x': target['x'],
        'y': target['y'],
        'button': 'left',
        'clickCount': 1,
    })
    return target


def physical_modified_click(
    cdp: CDP,
    selector: str,
    button: str,
    modifiers: int = 0,
) -> dict:
    cdp.set_phase(f'click:{button}:{modifiers}:{selector}')
    target = cdp.evaluate(f"""
    (() => {{
      const element = document.querySelector({json.dumps(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {{
        x,
        y,
        width: rect.width,
        height: rect.height,
        insideViewport:
          x >= 0 && x <= window.innerWidth &&
          y >= 0 && y <= window.innerHeight,
        pointerEvents: style.pointerEvents,
        visibility: style.visibility,
        display: style.display,
        targetMatches: hit === element || Boolean(hit && element.contains(hit)),
      }};
    }})()
    """)
    require(target is not None, f'Could not find modified-click target: {selector}')
    require(target['width'] > 0 and target['height'] > 0,
            f'Modified-click target has no area: {selector}: {target}')
    require(target['insideViewport'],
            f'Modified-click target is outside viewport: {selector}: {target}')
    require(target['pointerEvents'] != 'none',
            f'Modified-click target has pointer-events:none: {selector}')
    require(target['visibility'] != 'hidden' and target['display'] != 'none',
            f'Modified-click target is not visible: {selector}')
    require(target['targetMatches'],
            f'Modified-click target is occluded: {selector}: {target}')
    for event_type in ('mousePressed', 'mouseReleased'):
        cdp.call('Input.dispatchMouseEvent', {
            'type': event_type,
            'x': target['x'],
            'y': target['y'],
            'button': button,
            'modifiers': modifiers,
            'clickCount': 1,
        })
    return target


def dispatch_escape(cdp: CDP) -> None:
    cdp.set_phase('keyboard:Escape')
    cdp.call('Input.dispatchKeyEvent', {
        'type': 'keyDown',
        'key': 'Escape',
        'code': 'Escape',
        'windowsVirtualKeyCode': 27,
        'nativeVirtualKeyCode': 27,
    })
    cdp.call('Input.dispatchKeyEvent', {
        'type': 'keyUp',
        'key': 'Escape',
        'code': 'Escape',
        'windowsVirtualKeyCode': 27,
        'nativeVirtualKeyCode': 27,
    })


def physical_scroll_into_view(
    cdp: CDP,
    selector: str,
    text: str | None = None,
    max_steps: int = 20,
) -> dict:
    history = []
    for _ in range(max_steps + 1):
        state = cdp.evaluate(f"""
        (() => {{
          const candidates = [...document.querySelectorAll({json.dumps(selector)})];
          const element = {('candidates.find((candidate) => candidate.textContent?.trim() === ' + json.dumps(text) + ')') if text is not None else 'candidates[0]'};
          if (!element) return null;
          let scrollParent = element.parentElement;
          while (scrollParent) {{
            const style = getComputedStyle(scrollParent);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              scrollParent.scrollHeight > scrollParent.clientHeight
            ) break;
            scrollParent = scrollParent.parentElement;
          }}
          if (!scrollParent) scrollParent = document.scrollingElement;
          const rect = element.getBoundingClientRect();
          const scrollRect = scrollParent === document.scrollingElement
            ? {{ left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }}
            : scrollParent.getBoundingClientRect();
          const x = Math.max(1, Math.min(window.innerWidth - 1, (scrollRect.left + scrollRect.right) / 2));
          const y = Math.max(1, Math.min(window.innerHeight - 1, (scrollRect.top + scrollRect.bottom) / 2));
          const targetX = rect.left + rect.width / 2;
          const targetY = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(targetX, targetY);
          return {{
            rect: {{
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            }},
            scrollPoint: {{ x, y }},
            scrollTop: scrollParent.scrollTop,
            scrollHeight: scrollParent.scrollHeight,
            clientHeight: scrollParent.clientHeight,
            centerInsideViewport:
              targetX >= 0 && targetX <= window.innerWidth &&
              targetY >= 0 && targetY <= window.innerHeight,
            targetMatches: hit === element || Boolean(hit && element.contains(hit)),
          }};
        }})()
        """)
        require(state is not None,
                f'Could not find physical scroll target: {selector}: {text}')
        history.append(state)
        if state['centerInsideViewport'] and state['targetMatches']:
            steps = len(history) - 1
            if steps > 0:
                require(
                    state['scrollTop'] != history[0]['scrollTop'],
                    'Physical wheel input did not change the '
                    f'scroll position for {selector}: {history}',
                )
            return {
                'selector': selector,
                'steps': steps,
                'initialScrollTop': history[0]['scrollTop'],
                'finalScrollTop': state['scrollTop'],
                'finalRect': state['rect'],
                'targetMatches': True,
                'wheelChangedScrollPosition': steps > 0,
            }
        require(state['scrollHeight'] > state['clientHeight'],
                f'Target is outside the viewport but has no scrollable ancestor: {state}')
        delta = -600 if state['rect']['top'] < 0 else 600
        cdp.set_phase(
            f'scroll:{selector}:'
            f'{text or "first"}:'
            f'step-{len(history)}'
        )
        cdp.call('Input.dispatchMouseEvent', {
            'type': 'mouseWheel',
            'x': state['scrollPoint']['x'],
            'y': state['scrollPoint']['y'],
            'deltaX': 0,
            'deltaY': delta,
        })
        time.sleep(0.1)
    raise AssertionError(
        f'Physical scrolling did not expose {selector}: {history[-1] if history else None}'
    )


def set_viewport(cdp: CDP, width: int, height: int = 900) -> None:
    cdp.set_phase(f'renderer-viewport:{width}x{height}')
    actual = None
    for attempt in range(3):
        if attempt > 0:
            cdp.call('Emulation.clearDeviceMetricsOverride')
            time.sleep(0.15)
        cdp.call('Emulation.setDeviceMetricsOverride', {
            'width': width,
            'height': height,
            'deviceScaleFactor': 1,
            'mobile': False,
        })
        deadline = time.time() + 5
        while time.time() < deadline:
            actual = cdp.evaluate('({ width: window.innerWidth, height: window.innerHeight })')
            if (
                abs(actual['width'] - width) <= 1 and
                actual['height'] == height
            ):
                # Electron's CDP viewport emulation updates renderer geometry but
                # does not reliably emit a window resize notification. Dispatch
                # the standard event so the app's resize fallback observes this
                # synthetic viewport change. Native BrowserWindow cases below
                # still validate real operating-system resize events separately.
                cdp.evaluate(
                    "window.dispatchEvent(new Event('resize')); true"
                )
                wait_for_stable_layout(cdp)
                return
            time.sleep(0.1)
    raise AssertionError(
        f'Renderer viewport did not reach {width}x{height} after 3 attempts; actual={actual}'
    )


def layout_snapshot(cdp: CDP) -> dict:
    expression = r"""
    (() => {
      const shell = document.querySelector('.project-shell');
      if (!shell) return null;
      const left = shell.querySelector(':scope > .shell-left');
      const center = shell.querySelector(':scope > .shell-center');
      const right = shell.querySelector(':scope > .shell-right');
      if (!left || !center || !right) return null;
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return {
          left: value.left,
          right: value.right,
          top: value.top,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      };
      const shellRect = rect(shell);
      const childRects = [left, center, right].map(rect);
      const withinShell = childRects.every((child) =>
        child.left >= shellRect.left - 1 &&
        child.right <= shellRect.right + 1 &&
        child.top >= shellRect.top - 1 &&
        child.bottom <= shellRect.bottom + 1
      );
      const visible = (element) => {
        if (!element) return false;
        const value = rect(element);
        const style = getComputedStyle(element);
        return Boolean(
          element.getClientRects().length &&
          value.width > 0 && value.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 &&
          style.pointerEvents !== 'none' &&
          value.right > 0 && value.left < window.innerWidth &&
          value.bottom > 0 && value.top < window.innerHeight
        );
      };
      const describe = (target) => target ? {
        tag: target.tagName,
        className: String(target.className || ''),
        text: target.textContent?.trim().slice(0, 80) || '',
      } : null;
      const panelDetails = (side, element, contentSelector) => {
        const elementRect = rect(element);
        const content = element.querySelector(contentSelector);
        const contentRect = content ? rect(content) : null;
        const sampleXs = side === 'left'
          ? [elementRect.left + elementRect.width * 0.35, elementRect.right - 12]
          : [elementRect.left + 12, elementRect.left + elementRect.width * 0.65];
        const sampleYs = [
          Math.min(elementRect.bottom - 12, elementRect.top + 80),
          elementRect.top + elementRect.height * 0.5,
        ];
        const samples = sampleXs.flatMap((x) => sampleYs.map((y) => {
          const target = document.elementFromPoint(x, y);
          return {
            x,
            y,
            hit: describe(target),
            insideContent: Boolean(content && target && content.contains(target)),
          };
        }));
        const intersection = contentRect ? {
          width: Math.max(0, Math.min(elementRect.right, contentRect.right) - Math.max(elementRect.left, contentRect.left)),
          height: Math.max(0, Math.min(elementRect.bottom, contentRect.bottom) - Math.max(elementRect.top, contentRect.top)),
        } : { width: 0, height: 0 };
        return {
          rect: elementRect,
          contentRect,
          contentMounted: Boolean(content),
          contentVisible: visible(content),
          contentPointerEvents: content ? getComputedStyle(content).pointerEvents : null,
          contentOpacity: content ? getComputedStyle(content).opacity : null,
          contentText: content?.innerText?.trim().slice(0, 240) || '',
          samples,
          intersection,
        };
      };
      const buttons = [...shell.querySelectorAll('.shell-collapse-btn')].map((button) => {
        const value = rect(button);
        return {
          side: button.classList.contains('shell-collapse-left') ? 'left' : 'right',
          label: button.getAttribute('aria-label'),
          expanded: button.getAttribute('aria-expanded'),
          controls: button.getAttribute('aria-controls'),
          visible: visible(button),
          rect: value,
          insideShell:
            value.left >= shellRect.left - 1 && value.right <= shellRect.right + 1 &&
            value.top >= shellRect.top - 1 && value.bottom <= shellRect.bottom + 1,
        };
      });
      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        shell: {
          ...shellRect,
          clientWidth: shell.clientWidth,
          scrollWidth: shell.scrollWidth,
          classes: [...shell.classList],
          band: shell.dataset.responsiveBand,
          gridTemplateColumns: getComputedStyle(shell).gridTemplateColumns,
          directChildren: [...shell.children].map((child) => child.className),
        },
        columns: {
          left: childRects[0],
          center: childRects[1],
          right: childRects[2],
        },
        geometry: {
          leftCenterGap: childRects[1].left - childRects[0].right,
          centerRightGap: childRects[2].left - childRects[1].right,
          widthDelta:
            childRects[0].width + childRects[1].width + childRects[2].width - shell.clientWidth,
          topDeltas: childRects.map((child) => child.top - shellRect.top),
          bottomDeltas: childRects.map((child) => child.bottom - shellRect.bottom),
        },
        panels: {
          left: panelDetails('left', left, '.shell-left-content'),
          right: panelDetails('right', right, '.shell-right-content'),
        },
        counts: {
          shell: document.querySelectorAll('.project-shell').length,
          chatSidebar: document.querySelectorAll('.chat-sidebar').length,
          chatMain: document.querySelectorAll('.chat-main').length,
          rightPanel: document.querySelectorAll('.right-panel').length,
          legacyChatContainer: document.querySelectorAll('.chat-page-container').length,
          mainLandmarks: document.querySelectorAll('main').length,
        },
        overflow: {
          document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          body: document.body.scrollWidth > document.body.clientWidth,
          shell: shell.scrollWidth > shell.clientWidth,
          childrenOutsideShell: !withinShell,
        },
        buttons,
        uiMode: document.querySelector('.app-layout')?.getAttribute('data-ui-mode'),
      };
    })()
    """
    snapshot = cdp.evaluate(expression)
    require(snapshot is not None, 'Project shell or one of its three direct columns is missing')
    return snapshot


def expected_band(responsive_width: float) -> str:
    if responsive_width <= 900:
        return 'narrow'
    if responsive_width <= 1200:
        return 'medium'
    return 'wide'


def assert_geometry(snapshot: dict, context: str) -> None:
    geometry = snapshot['geometry']
    columns = snapshot['columns']
    require(abs(geometry['leftCenterGap']) <= 1,
            f'Left and center columns are not adjacent at {context}: {geometry}')
    require(abs(geometry['centerRightGap']) <= 1,
            f'Center and right columns are not adjacent at {context}: {geometry}')
    require(abs(geometry['widthDelta']) <= 1,
            f'Column widths do not fill the shell at {context}: {geometry}')
    require(all(abs(value) <= 1 for value in geometry['topDeltas']),
            f'A column does not align with the shell top at {context}: {geometry}')
    require(all(abs(value) <= 1 for value in geometry['bottomDeltas']),
            f'A column does not align with the shell bottom at {context}: {geometry}')
    require(columns['center']['width'] > 0,
            f'Center workspace has no usable width at {context}')


def assert_snapshot(snapshot: dict, width: int | None, context: str) -> None:
    shell = snapshot['shell']
    counts = snapshot['counts']
    overflow = snapshot['overflow']
    band = expected_band(shell['clientWidth'])

    if width is not None:
        require(abs(snapshot['viewport']['width'] - width) <= 1,
                f'Viewport width mismatch at {context}: requested={width}, actual={snapshot["viewport"]["width"]}')
    require(shell['band'] == band,
            f'Responsive band mismatch at {context}: {shell["width"]} -> {shell["band"]}')
    require(counts['shell'] == 1, f'Expected one project shell at {context}')
    expected_left_content = 0 if band == 'narrow' else 1
    expected_right_content = 0 if band != 'wide' else 1
    require(counts['chatSidebar'] == expected_left_content,
            f'Unexpected chat sidebar count at {context}: {counts["chatSidebar"]}')
    require(counts['chatMain'] == 1, f'Expected one chat workspace at {context}')
    require(counts['rightPanel'] == expected_right_content,
            f'Unexpected right panel count at {context}: {counts["rightPanel"]}')
    require(counts['legacyChatContainer'] == 0,
            f'Legacy chat shell returned at {context}')
    require(counts['mainLandmarks'] == 1,
            f'Expected one main landmark at {context}')
    require(shell['directChildren'] == ['shell-left', 'shell-center', 'shell-right'],
            f'Project shell direct children changed at {context}: {shell["directChildren"]}')
    require(not any(overflow.values()), f'Layout overflow at {context}: {overflow}')
    require(len(snapshot['buttons']) == 2,
            f'Expected exactly two collapse buttons at {context}')
    require({button['side'] for button in snapshot['buttons']} == {'left', 'right'},
            f'Collapse button sides are invalid at {context}: {snapshot["buttons"]}')
    require(all(button['visible'] and button['insideShell'] and button['controls']
                for button in snapshot['buttons']),
            f'A collapse button is clipped or unassociated at {context}')
    assert_geometry(snapshot, context)

    classes = set(shell['classes'])
    if band == 'wide':
        require('left-collapsed' not in classes,
                f'Left panel unexpectedly collapsed at {context}')
        require('right-collapsed' not in classes,
                f'Right panel unexpectedly collapsed at {context}')
        require(abs(snapshot['columns']['left']['width'] - 240) <= 1,
                f'Left panel is not 240px at {context}')
        require(abs(snapshot['columns']['right']['width'] - 260) <= 1,
                f'Right panel is not 260px at {context}')
    elif band == 'medium':
        require('left-collapsed' not in classes,
                f'Left panel unexpectedly collapsed at {context}')
        require('right-collapsed' in classes,
                f'Right rail missing at {context}')
        require(abs(snapshot['columns']['left']['width'] - 240) <= 1,
                f'Left panel is not 240px at {context}')
        require(abs(snapshot['columns']['right']['width'] - 32) <= 1,
                f'Right rail is not 32px at {context}')
    else:
        require('left-collapsed' in classes,
                f'Left rail missing at {context}')
        require('right-collapsed' in classes,
                f'Right rail missing at {context}')
        require(abs(snapshot['columns']['left']['width'] - 32) <= 1,
                f'Left rail is not 32px at {context}')
        require(abs(snapshot['columns']['right']['width'] - 32) <= 1,
                f'Right rail is not 32px at {context}')


def assert_diagnostic_controls_absent(cdp: CDP, context: str) -> None:
    selectors = json.dumps(DIAGNOSTIC_ONLY_SELECTORS)
    result = cdp.evaluate(f"""
    (() => {selectors}.map((selector) => ({{
      selector,
      count: document.querySelectorAll(selector).length,
    }})))()
    """)
    leaked = [item for item in result if item['count'] > 0]
    require(not leaked, f'Normal mode exposes diagnostic controls at {context}: {leaked}')
    require(cdp.evaluate("document.querySelector('.app-layout')?.dataset.uiMode") == 'normal',
            f'Application is not in normal mode at {context}')


def assert_modes(cdp: CDP) -> list[dict]:
    results = []
    for label, mode in (
        ('阅读', 'read'),
        ('分析', 'analyze'),
        ('写作', 'write'),
        ('对话', 'converse'),
    ):
        physical_click(cdp, '.shell-mode-btn', label)
        wait_for(cdp, f"document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim() === {json.dumps(label)}")
        wait_for_stable_layout(cdp)
        result = cdp.evaluate(f"""
        (() => {{
          const selected = document.querySelector('.shell-mode-btn[aria-selected="true"]');
          const panel = document.querySelector('[role="tabpanel"][aria-labelledby="' + selected?.id + '"]');
          return {{
            shells: document.querySelectorAll('.project-shell').length,
            selected: selected?.textContent?.trim(),
            controlsPanel: selected?.getAttribute('aria-controls'),
            panelId: panel?.id || null,
            panelLabel: panel?.getAttribute('aria-label') || null,
            legacyChatContainer: document.querySelectorAll('.chat-page-container').length,
          }};
        }})()
        """)
        require(result['shells'] == 1, f'Mode {label} mounted multiple shells')
        require(result['selected'] == label, f'Mode {label} was not selected')
        require(result['panelId'] == result['controlsPanel'],
                f'Mode {label} tab/panel relationship is broken: {result}')
        require(result['panelLabel'] == f'{label}工作区',
                f'Mode {label} panel label is wrong: {result}')
        require(result['legacyChatContainer'] == 0,
                f'Mode {label} mounted the legacy chat shell')
        assert_diagnostic_controls_absent(cdp, f'{mode} workspace')
        results.append({'mode': label, **result})
    return results


def assert_manual_collapse(cdp: CDP, side: str) -> dict:
    expanded_width = 240 if side == 'left' else 260
    before = layout_snapshot(cdp)
    require(before['shell']['band'] == 'wide',
            f'{side} manual collapse requires wide band')
    before_center = before['columns']['center']['width']
    collapse = physical_click(cdp, f'.shell-collapse-{side}')
    wait_for(cdp, f"document.querySelector('.project-shell')?.classList.contains('{side}-collapsed')")
    wait_for_stable_layout(cdp)
    collapsed = layout_snapshot(cdp)
    assert_geometry(collapsed, f'wide {side} manual collapse')
    require(abs(collapsed['columns'][side]['width'] - 32) <= 1,
            f'{side} manual collapse did not produce a 32px rail')
    require(abs(collapsed['columns']['center']['width'] - (before_center + expanded_width - 32)) <= 1,
            f'{side} manual collapse did not transfer width to center')
    button = next(item for item in collapsed['buttons'] if item['side'] == side)
    require(button['expanded'] == 'false' and button['label'] == (
        '展开资料栏' if side == 'left' else '展开检查器'
    ), f'{side} manual collapse button state is wrong: {button}')

    physical_click(cdp, '.shell-mode-btn', '阅读')
    wait_for(cdp, "document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim() === '阅读'")
    wait_for_stable_layout(cdp)
    preserved = layout_snapshot(cdp)
    require(f'{side}-collapsed' in set(preserved['shell']['classes']),
            f'{side} user collapse preference did not survive a mode switch')
    require(abs(preserved['columns'][side]['width'] - 32) <= 1,
            f'{side} collapse geometry did not survive a mode switch')

    physical_click(cdp, '.shell-mode-btn', '对话')
    wait_for(cdp, "document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim() === '对话'")
    restore = physical_click(cdp, f'.shell-collapse-{side}')
    wait_for(cdp, f"!document.querySelector('.project-shell')?.classList.contains('{side}-collapsed')")
    wait_for_stable_layout(cdp)
    restored = layout_snapshot(cdp)
    assert_geometry(restored, f'wide {side} manual restore')
    require(abs(restored['columns'][side]['width'] - expanded_width) <= 1,
            f'{side} panel did not restore to {expanded_width}px')
    require(abs(restored['columns']['center']['width'] - before_center) <= 1,
            f'{side} center width did not restore')
    return {
        'side': side,
        'collapseClick': collapse,
        'restoreClick': restore,
        'centerBefore': before_center,
        'centerCollapsed': collapsed['columns']['center']['width'],
        'centerRestored': restored['columns']['center']['width'],
        'preservedAcrossMode': True,
    }


def assert_overlay(
    cdp: CDP,
    side: str,
    output_path: pathlib.Path,
    expected_width: float,
    close_with_escape: bool,
) -> dict:
    selector = f'.shell-collapse-{side}'
    content_count_key = 'chatSidebar' if side == 'left' else 'rightPanel'
    before = layout_snapshot(cdp)
    before_center_width = before['columns']['center']['width']
    before_grid = before['shell']['gridTemplateColumns']
    before_panel = before['panels'][side]
    require(not before_panel['contentMounted'],
            f'{side} content was mounted before overlay opened')

    open_click = physical_click(cdp, selector)
    wait_for(cdp, f"document.querySelector('.project-shell.{side}-overlay-open')")
    wait_for_stable_layout(cdp)
    after = layout_snapshot(cdp)
    classes = set(after['shell']['classes'])
    panel = after['panels'][side]
    require(f'{side}-overlay-open' in classes, f'{side} overlay did not open')
    require(f'{side}-collapsed' in classes, f'{side} grid rail expanded unexpectedly')
    require(abs(after['columns']['center']['width'] - before_center_width) <= 1,
            f'{side} overlay squeezed the center workspace')
    require(after['shell']['gridTemplateColumns'] == before_grid,
            f'{side} overlay changed grid tracks')
    require(abs(panel['rect']['width'] - expected_width) <= 1,
            f'{side} overlay width mismatch: {panel["rect"]["width"]} != {expected_width}')
    require(panel['contentMounted'] and panel['contentVisible'],
            f'{side} overlay content is not mounted and visible')
    require(panel['contentRect'] and panel['contentRect']['width'] > 0 and panel['contentRect']['height'] > 0,
            f'{side} overlay content has no usable area')
    require(panel['intersection']['width'] > 100 and panel['intersection']['height'] > 100,
            f'{side} overlay content is clipped: {panel["intersection"]}')
    require(panel['contentPointerEvents'] != 'none' and float(panel['contentOpacity']) > 0,
            f'{side} overlay content is not interactive')
    require(bool(panel['contentText']), f'{side} overlay content is empty')
    require(after['counts'][content_count_key] == 1,
            f'{side} overlay did not mount expected workspace content')
    require(sum(1 for sample in panel['samples'] if sample['insideContent']) >= 3,
            f'{side} overlay content failed sampled hit-tests: {panel["samples"]}')
    if side == 'left':
        require(panel['rect']['right'] > after['columns']['center']['left'] + 100,
                'Left overlay did not geometrically cover the center workspace')
        interaction = physical_click(cdp, '.chat-sidebar-filter', '归档')
        wait_for(cdp, "document.querySelector('.chat-sidebar-filter.active')?.textContent?.trim() === '归档'")
        physical_click(cdp, '.chat-sidebar-filter', '进行中')
        wait_for(cdp, "document.querySelector('.chat-sidebar-filter.active')?.textContent?.trim() === '进行中'")
    else:
        require(panel['rect']['left'] < after['columns']['center']['right'] - 100,
                'Right overlay did not geometrically cover the center workspace')
        interaction = physical_click(cdp, '.right-panel-tab', '生成物')
        wait_for(cdp, "document.querySelector('.right-panel-tab[aria-selected=\"true\"]')?.textContent?.trim() === '生成物'")
        physical_click(cdp, '.right-panel-tab', '任务')
        wait_for(cdp, "document.querySelector('.right-panel-tab[aria-selected=\"true\"]')?.textContent?.trim() === '任务'")
    require(panel['rect']['top'] >= after['shell']['top'] - 1,
            f'{side} overlay crosses the shell top boundary')
    require(panel['rect']['bottom'] <= after['shell']['bottom'] + 1,
            f'{side} overlay crosses the shell bottom boundary')
    require(not any(after['overflow'].values()), f'{side} overlay overflowed the shell')
    capture(cdp, output_path)

    if close_with_escape:
        dispatch_escape(cdp)
        close_action = {'type': 'Escape'}
    else:
        close_action = {'type': 'physicalClick', **physical_click(cdp, selector)}
    wait_for(cdp, f"!document.querySelector('.project-shell.{side}-overlay-open')")
    wait_for_stable_layout(cdp)
    restored = layout_snapshot(cdp)
    require(f'{side}-overlay-open' not in set(restored['shell']['classes']),
            f'{side} overlay class remained after closing')
    require(f'{side}-collapsed' in set(restored['shell']['classes']),
            f'{side} responsive rail disappeared after closing')
    require(not restored['panels'][side]['contentMounted'],
            f'{side} overlay content remained mounted after closing')
    require(restored['counts'][content_count_key] == 0,
            f'{side} workspace content remained after closing')
    require(abs(restored['columns'][side]['width'] - 32) <= 1,
            f'{side} rail did not restore to 32px')
    require(abs(restored['columns']['center']['width'] - before_center_width) <= 1,
            f'{side} center width changed after closing')
    require(restored['shell']['gridTemplateColumns'] == before_grid,
            f'{side} grid did not restore after closing')
    require(not any(restored['overflow'].values()),
            f'{side} close state overflowed the shell')
    assert_geometry(restored, f'{side} overlay close')
    button = next(item for item in restored['buttons'] if item['side'] == side)
    require(button['expanded'] == 'false' and button['label'] == (
        '展开资料栏' if side == 'left' else '展开检查器'
    ), f'{side} close button state did not restore: {button}')
    require(cdp.evaluate(f"document.activeElement?.matches('.shell-collapse-{side}')"),
            f'{side} overlay close did not return focus to its rail button')

    center_probe = cdp.evaluate(f"""
    (() => {{
      const center = document.querySelector('.shell-center');
      const rect = center.getBoundingClientRect();
      const x = {('rect.left + 80') if side == 'left' else 'rect.right - 80'};
      const y = rect.top + Math.max(80, rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {{
        x,
        y,
        inCenter: Boolean(hit && center.contains(hit)),
        tag: hit?.tagName || null,
        className: String(hit?.className || ''),
      }};
    }})()
    """)
    require(center_probe['inCenter'],
            f'{side} overlay still intercepts center after close: {center_probe}')
    physical_click(cdp, '.shell-mode-btn', '阅读')
    wait_for(cdp, "document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim() === '阅读'")
    physical_click(cdp, '.shell-mode-btn', '对话')
    wait_for(cdp, "document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim() === '对话'")

    return {
        'side': side,
        'openClick': open_click,
        'contentInteraction': interaction,
        'closeAction': close_action,
        'centerProbeAfterClose': center_probe,
        'centerWidthBefore': before_center_width,
        'centerWidthOpen': after['columns']['center']['width'],
        'centerWidthRestored': restored['columns']['center']['width'],
        'overlayWidth': panel['rect']['width'],
        'sampleHitTests': panel['samples'],
        'gridBefore': before_grid,
        'gridOpen': after['shell']['gridTemplateColumns'],
        'gridRestored': restored['shell']['gridTemplateColumns'],
    }


def navigate(cdp: CDP, nav_id: str) -> None:
    physical_click(cdp, f'[data-nav-id="{nav_id}"]')
    wait_for(cdp, f"document.querySelector('[data-nav-id=\"{nav_id}\"]')?.getAttribute('aria-current') === 'page'")
    wait_for_stable_layout(cdp)


def assert_diagnostic_boundary(cdp: CDP) -> dict:
    toggle_selector = '[data-testid="diagnostic-mode-toggle"]'
    navigate(cdp, 'settings')
    wait_for(cdp, f"document.querySelector({json.dumps(toggle_selector)})")
    require(not cdp.evaluate(f"document.querySelector({json.dumps(toggle_selector)})?.checked"),
            'Diagnostic toggle was checked before the boundary test')
    assert_diagnostic_controls_absent(cdp, 'normal settings')

    normal_scroll = physical_scroll_into_view(cdp, toggle_selector)
    physical_click(cdp, toggle_selector)
    wait_for(cdp, "document.querySelector('.app-layout')?.dataset.uiMode === 'diagnostic'")
    wait_for(cdp, "document.querySelector('[data-testid=\"diagnostic-mcp-settings\"]') && document.querySelector('[data-testid=\"diagnostic-hitl-settings\"]')")
    require(cdp.evaluate(f"document.querySelector({json.dumps(toggle_selector)})?.checked"),
            'Diagnostic toggle did not become checked')

    navigate(cdp, 'projects')
    wait_for(cdp, "document.querySelector('[data-testid=\"diagnostic-terminal-toggle\"]')")
    require(cdp.evaluate("document.querySelector('.app-layout')?.dataset.uiMode") == 'diagnostic',
            'Diagnostic project mode was not active')

    navigate(cdp, 'settings')
    diagnostic_scroll = physical_scroll_into_view(cdp, toggle_selector)
    physical_click(cdp, toggle_selector)
    wait_for(cdp, "document.querySelector('.app-layout')?.dataset.uiMode === 'normal'")
    wait_for(cdp, "!document.querySelector('[data-testid=\"diagnostic-mcp-settings\"]') && !document.querySelector('[data-testid=\"diagnostic-hitl-settings\"]')")
    navigate(cdp, 'library')
    assert_diagnostic_controls_absent(cdp, 'normal library')
    navigate(cdp, 'projects')
    assert_diagnostic_controls_absent(cdp, 'normal projects restored')
    return {
        'normalSettingsIsolated': True,
        'normalSettingsScroll': normal_scroll,
        'diagnosticSettingsVisible': True,
        'diagnosticSettingsScroll': diagnostic_scroll,
        'diagnosticProjectVisible': True,
        'normalLibraryIsolated': True,
        'normalRestored': True,
    }


def clear_shell_width_fixture(cdp: CDP) -> None:
    cdp.evaluate("document.documentElement.style.removeProperty('--sidebar-width')")
    wait_for_stable_layout(cdp)


def find_viewport_for_shell_width(cdp: CDP, target: int) -> tuple[int, dict, float]:
    clear_shell_width_fixture(cdp)
    current = layout_snapshot(cdp)
    estimate = max(
        320,
        round(current['viewport']['width'] + target - current['shell']['clientWidth']),
    )
    if estimate % 2:
        estimate += 1
    set_viewport(cdp, estimate)
    snapshot = layout_snapshot(cdp)
    shell_delta = snapshot['shell']['clientWidth'] - target
    sidebar_width = float(cdp.evaluate(
        "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'))"
    ))
    fixture_sidebar_width = sidebar_width + shell_delta
    cdp.evaluate(
        f"document.documentElement.style.setProperty('--sidebar-width', {json.dumps(f'{fixture_sidebar_width}px')})"
    )
    wait_for_stable_layout(cdp)
    snapshot = layout_snapshot(cdp)
    require(snapshot['shell']['clientWidth'] == target,
            f'Could not produce exact shell width {target}: {snapshot["shell"]}')
    return estimate, snapshot, fixture_sidebar_width


def assert_native_window_matrix(
    cdp: CDP,
    output_dir: pathlib.Path,
    results: list[dict],
) -> None:
    require(
        cdp.evaluate("typeof window.metis?.acceptanceSetWindowSize === 'function'"),
        'Preload did not expose the acceptance-only native window control',
    )
    cdp.call('Emulation.clearDeviceMetricsOverride')
    wait_for_stable_layout(cdp)

    for name, content_width, content_height, expected in NATIVE_CONTENT_CASES:
        cdp.set_phase(
            f'native-window:{name}:{content_width}x{content_height}'
        )
        response = cdp.evaluate(f"""
        window.metis.acceptanceSetWindowSize({{
          mode: 'content',
          width: {content_width},
          height: {content_height},
        }}).then(async (response) => {{
          await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(resolve)
          ));
          return response;
        }})
        """, await_promise=True)
        require(response is not None, f'Native window sizing returned no result for {name}')
        wait_for(
            cdp,
            f"Math.abs(window.innerWidth - {response['contentBounds']['width']}) <= 1 && "
            f"Math.abs(window.innerHeight - {response['contentBounds']['height']}) <= 1",
        )
        wait_for_stable_layout(cdp)
        snapshot = layout_snapshot(cdp)
        renderer_window = cdp.evaluate(r"""
        ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio,
          screen: {
            width: window.screen.width,
            height: window.screen.height,
            availWidth: window.screen.availWidth,
            availHeight: window.screen.availHeight,
          },
        })
        """)
        observation = {
            'name': name,
            'passed': False,
            'requestedContentSize': {
                'width': content_width,
                'height': content_height,
            },
            'mainProcessOuterBounds': response['outerBounds'],
            'mainProcessContentBounds': response['contentBounds'],
            'zoomFactor': response['zoomFactor'],
            'display': response['display'],
            'rendererWindow': renderer_window,
            'shellResponsiveWidth': snapshot['shell']['clientWidth'],
            'shellBoundingWidth': snapshot['shell']['width'],
            'expectedBand': expected,
            'actualBand': snapshot['shell']['band'],
            'gridTemplateColumns': snapshot['shell']['gridTemplateColumns'],
            'geometry': snapshot['geometry'],
            'overflow': snapshot['overflow'],
        }
        results.append(observation)
        require(response['mode'] == 'content',
                f'Native window request mode changed for {name}: {response}')
        require(not response['maximized'] and not response['fullScreen'],
                f'Native matrix case {name} remained maximized or full screen')
        require(abs(response['contentBounds']['width'] - content_width) <= 1,
                f'Native content width missed its target for {name}: {response}')
        require(abs(response['contentBounds']['height'] - content_height) <= 1,
                f'Native content height missed its target for {name}: {response}')
        require(abs(renderer_window['innerWidth'] - content_width) <= 1,
                f'Renderer inner width missed native content target for {name}')
        require(abs(renderer_window['innerHeight'] - content_height) <= 1,
                f'Renderer inner height missed native content target for {name}')
        require(abs(renderer_window['innerWidth'] - response['contentBounds']['width']) <= 1,
                f'Renderer inner width does not match native content width for {name}')
        require(abs(renderer_window['innerHeight'] - response['contentBounds']['height']) <= 1,
                f'Renderer inner height does not match native content height for {name}')
        require(abs(response['zoomFactor'] - 1) <= 0.001,
                f'Renderer zoom factor is not 1 for {name}: {response["zoomFactor"]}')
        require(response['display']['scaleFactor'] > 0,
                f'Main process display scale factor is invalid for {name}: {response}')
        require(abs(renderer_window['devicePixelRatio'] - response['display']['scaleFactor']) <= 0.01,
                f'Renderer DPR and display scale factor disagree for {name}: '
                f'{renderer_window["devicePixelRatio"]} vs {response["display"]["scaleFactor"]}')
        require(snapshot['viewport']['width'] == renderer_window['innerWidth'],
                f'Layout snapshot did not use native renderer width for {name}')
        require(snapshot['viewport']['height'] == renderer_window['innerHeight'],
                f'Layout snapshot did not use native renderer height for {name}')
        require(snapshot['shell']['band'] == expected,
                f'Native window case {name} entered {snapshot["shell"]["band"]}, expected {expected}')
        require(snapshot['shell']['band'] == expected_band(snapshot['shell']['clientWidth']),
                f'Native shell width and responsive band disagree for {name}')
        assert_snapshot(snapshot, None, f'{name} native BrowserWindow')
        assert_diagnostic_controls_absent(cdp, f'{name} native BrowserWindow')
        capture(cdp, output_dir / f'native-window-{name}.png')
        observation['passed'] = True


def verify_acceptance_environment(cdp: CDP, expected_profile: pathlib.Path) -> dict:
    expected_profile = expected_profile.resolve()
    expected_marker = (expected_profile / 'metis-layout-acceptance-profile.json').resolve()
    require(expected_marker.is_file(),
            f'Isolated profile marker is missing: {expected_marker}')
    marker = json.loads(expected_marker.read_text(encoding='utf-8'))
    require(marker.get('purpose') == 'metis-electron-layout-acceptance',
            f'Invalid isolated profile marker: {marker}')
    require(canonical_file_url(cdp.evaluate('location.href')) == EXPECTED_ENTRY,
            f'Renderer is not using the current dist entry: {cdp.evaluate("location.href")}')
    require(
        cdp.evaluate("typeof window.metis?.acceptanceEnvironment === 'function'"),
        'Preload did not expose window.metis.acceptanceEnvironment',
    )
    environment = cdp.evaluate(
        'window.metis.acceptanceEnvironment()',
        await_promise=True,
    )
    require(environment is not None and environment.get('enabled'),
            f'Main process did not authorize layout acceptance: {environment}')
    require(set(environment) == {
                'enabled', 'userDataPath', 'entryPath', 'tokenSha256',
            }, f'Unexpected acceptance metadata shape: {environment}')
    require('token' not in environment,
            'Main process exposed the raw layout acceptance token')
    require(
        len(environment['tokenSha256']) == 64 and
        all(character in '0123456789abcdef' for character in environment['tokenSha256']),
        'Acceptance token identity is not a lowercase SHA-256 digest',
    )
    require(pathlib.Path(environment['userDataPath']).resolve() == expected_profile,
            f'Electron userData does not match isolated profile: {environment}')
    require(pathlib.Path(environment['entryPath']).resolve() == EXPECTED_ENTRY,
            f'Main process entry does not match current dist: {environment}')
    expected_token_hash = hashlib.sha256(
        str(marker['token']).encode('utf-8')
    ).hexdigest()
    require(environment.get('tokenSha256') == expected_token_hash,
            'Main process acceptance token does not match the isolated launcher marker')
    require(cdp.evaluate("document.querySelector('.app-layout')?.dataset.uiMode") == 'normal',
            'Application did not start in normal mode')
    require(not cdp.evaluate("Boolean(document.querySelector('[data-testid=\"diagnostic-terminal-toggle\"]'))"),
            'Diagnostic controls were visible at startup')
    return {
        'profileVerified': True,
        'marker': {
            'purpose': marker['purpose'],
            'tokenSha256': expected_token_hash,
            'expectedEntry': marker.get('expectedEntry'),
            'createdAtUnixMs': marker.get('createdAtUnixMs'),
        },
        'entry': str(EXPECTED_ENTRY),
        'mainProcess': {
            'enabled': environment['enabled'],
            'userDataMatchesExpectedProfile': True,
            'entryPath': environment['entryPath'],
            'tokenSha256': environment['tokenSha256'],
        },
        'uiMode': 'normal',
    }


def release_acceptance_window_control(cdp: CDP) -> dict:
    cdp.set_phase('window-control:release')
    release = cdp.evaluate(
        'window.metis.acceptanceReleaseWindowControl()',
        await_promise=True,
    )
    require(
        release == {'released': True},
        f'Acceptance window control did not release cleanly: {release}',
    )
    release_probe = cdp.evaluate(r"""
    window.metis.acceptanceSetWindowSize({
      mode: 'content',
      width: 1000,
      height: 700,
    }).then(
      () => ({ rejected: false, message: null }),
      (error) => ({ rejected: true, message: String(error?.message || error) }),
    )
    """, await_promise=True)
    require(
        release_probe['rejected'],
        'Acceptance window control remained usable after release: '
        f'{release_probe}',
    )
    return {
        'attempted': True,
        'released': True,
        'postReleaseRequestRejected': True,
        'postReleaseError': release_probe['message'],
    }


def stable_json(value) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    )


def forbidden_marker_count(value) -> int:
    text = value if isinstance(value, str) else stable_json(value)
    lowered = text.casefold()
    return sum(
        1
        for marker in SAFE_MARKDOWN_FORBIDDEN_MARKERS
        if marker.casefold() in lowered
    )


def summarize_captured_value(value) -> dict:
    text = value if isinstance(value, str) else stable_json(value)
    encoded = text.encode('utf-8')
    return {
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'utf8Bytes': len(encoded),
        'forbiddenMarkerCount': forbidden_marker_count(text),
    }


def event_params(events: list[dict], method: str) -> list[dict]:
    return [
        event.get('params', {})
        for event in events
        if event.get('method') == method
    ]


def summarize_network_events(events: list[dict]) -> dict:
    urls = []
    remote_urls = []
    fixture_remote_urls = []
    for params in event_params(events, 'Network.requestWillBeSent'):
        request = params.get('request', {})
        url = str(request.get('url', ''))
        if not url:
            continue
        urls.append(url)
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme in {'http', 'https', 'ws', 'wss'}:
            remote_urls.append(url)
        if (parsed.hostname or '').casefold() in SAFE_MARKDOWN_REMOTE_HOSTS:
            fixture_remote_urls.append(url)
    return {
        'requestCount': len(urls),
        'remoteRequestCount': len(remote_urls),
        'fixtureRemoteRequestCount': len(fixture_remote_urls),
        'urlSet': summarize_captured_value(sorted(set(urls))),
    }


def summarize_frame_events(events: list[dict]) -> dict:
    urls = []
    for params in event_params(events, 'Page.frameNavigated'):
        frame = params.get('frame', {})
        url = str(frame.get('url', ''))
        if url:
            urls.append(url)
    for params in event_params(events, 'Page.navigatedWithinDocument'):
        url = str(params.get('url', ''))
        if url:
            urls.append(url)
    unexpected = [
        url for url in urls
        if not is_clean_expected_entry_url(url)
    ]
    return {
        'frameNavigationCount': len(urls),
        'unexpectedFrameNavigationCount': len(unexpected),
        'urlSet': summarize_captured_value(sorted(set(urls))),
    }


def summarize_target_events(events: list[dict]) -> dict:
    target_infos = []
    for params in event_params(events, 'Target.targetCreated'):
        info = params.get('targetInfo', {})
        target_infos.append({
            'type': str(info.get('type', '')),
            'url': str(info.get('url', '')),
        })
    return {
        'newTargetCount': len(target_infos),
        'targetInfoSet': summarize_captured_value(target_infos),
    }


def summarize_console_events(events: list[dict]) -> dict:
    console_events = [
        event
        for event in events
        if event.get('method') in {
            'Runtime.consoleAPICalled',
            'Runtime.exceptionThrown',
            'Log.entryAdded',
        }
    ]
    summary = summarize_captured_value(console_events)
    return {
        'eventCount': len(console_events),
        **summary,
    }


def clear_security_events(cdp: CDP, browser_cdp: CDP) -> None:
    cdp.pump_events(0.2)
    browser_cdp.pump_events(0.2)
    cdp.clear_events()
    browser_cdp.clear_events()


def wait_for_safe_markdown_fixture(cdp: CDP) -> None:
    marker = json.dumps(SAFE_MARKDOWN_MARKER)
    wait_for(cdp, f"""
      [...document.querySelectorAll('.chat-message.user')].some(
        (element) => element.textContent?.includes({marker})
      )
    """)


def seed_safe_markdown_fixture(cdp: CDP) -> dict:
    require(SAFE_MARKDOWN_FIXTURE.is_file(),
            f'SafeMarkdown fixture is missing: {SAFE_MARKDOWN_FIXTURE}')
    content = SAFE_MARKDOWN_FIXTURE.read_text(encoding='utf-8')
    session_id = f'goal001_safe_markdown_{int(time.time() * 1000)}'
    result = cdp.evaluate(f"""
    (async () => {{
      const api = window.metis;
      if (
        typeof api?.createSession !== 'function' ||
        typeof api?.updateSession !== 'function' ||
        typeof api?.appendMessage !== 'function' ||
        typeof api?.getMessages !== 'function'
      ) {{
        throw new Error('Production history APIs are unavailable');
      }}
      const sessionId = {json.dumps(session_id)};
      const content = {json.dumps(content)};
      await api.createSession(sessionId);
      await api.updateSession(sessionId, {{
        metadata: {{ title: 'GOAL-001 SafeMarkdown acceptance' }},
        lastActivity: Date.now(),
      }});
      const rowId = await api.appendMessage(sessionId, 'user', content);
      const persisted = await api.getMessages(sessionId);
      const exactPersisted = Array.isArray(persisted) && persisted.some(
        (item) => item?.kind === 'message' &&
          item.role === 'user' && item.content === content
      );
      return {{ rowId, exactPersisted }};
    }})()
    """, await_promise=True)
    require(isinstance(result, dict) and int(result.get('rowId', -1)) > 0,
            'SafeMarkdown fixture was not appended through production persistence')
    require(result.get('exactPersisted') is True,
            'SafeMarkdown fixture did not round-trip through production history decoding')
    return {
        'sessionId': session_id,
        'productionPathVerified': True,
        'role': 'user',
        'modelCompletionFabricated': False,
        'rowIdPositive': True,
        'exactPersisted': True,
        'fixture': summarize_captured_value(content),
    }


def safe_markdown_dom_snapshot(cdp: CDP) -> dict:
    return cdp.evaluate(f"""
    (() => {{
      const marker = {json.dumps(SAFE_MARKDOWN_MARKER)};
      const message = [...document.querySelectorAll('.chat-message.user')].find(
        (element) => element.textContent?.includes(marker)
      );
      if (!message) return null;
      const contentRoot = message.querySelector('.message-content');
      if (!contentRoot) return null;
      const elements = [contentRoot, ...contentRoot.querySelectorAll('*')];
      const attributes = elements.map((element) => ({{
        tag: element.tagName,
        attributes: [...element.attributes].map((attribute) => [
          attribute.name,
          attribute.value,
        ]),
      }}));
      const hrefs = [...contentRoot.querySelectorAll('[href]')].map(
        (element) => element.getAttribute('href')
      );
      return {{
        documentOuterHTML: document.documentElement.outerHTML,
        messageOuterHTML: message.outerHTML,
        attributes,
        title: document.title,
        location: location.href,
        cleanLinkCount: hrefs.filter(
          (href) => href === {json.dumps(SAFE_MARKDOWN_CLEAN_URL)}
        ).length,
        unsafeHrefCount: hrefs.filter(
          (href) => href !== {json.dumps(SAFE_MARKDOWN_CLEAN_URL)}
        ).length,
        imgCount: contentRoot.querySelectorAll('img').length,
        srcCount: contentRoot.querySelectorAll('[src]').length,
        dangerousElementCount: contentRoot.querySelectorAll(
          'iframe,object,embed,script,style,form,video,audio,source,svg'
        ).length,
        blockedLinkCount: contentRoot.querySelectorAll(
          '.safe-markdown-link-blocked'
        ).length,
        blockedImageCount: contentRoot.querySelectorAll(
          '.safe-markdown-image-blocked'
        ).length,
      }};
    }})()
    """)


def capture_safe_markdown_mode(
    cdp: CDP,
    browser_cdp: CDP,
    mode: str,
    expect_reload_navigation: bool,
) -> dict:
    require(cdp.evaluate("document.querySelector('.app-layout')?.dataset.uiMode") == mode,
            f'SafeMarkdown capture started in the wrong UI mode: {mode}')
    wait_for_safe_markdown_fixture(cdp)
    snapshot = safe_markdown_dom_snapshot(cdp)
    require(isinstance(snapshot, dict),
            f'SafeMarkdown fixture DOM was unavailable in {mode} mode')
    ax_response = cdp.call('Accessibility.getFullAXTree')
    ax_nodes = ax_response.get('result', {}).get('nodes', [])
    require(isinstance(ax_nodes, list) and len(ax_nodes) > 0,
            f'Accessibility.getFullAXTree returned no nodes in {mode} mode')
    cdp.pump_events(0.5)
    browser_cdp.pump_events(0.5)
    page_events = cdp.take_events()
    browser_events = browser_cdp.take_events()

    document_dom = summarize_captured_value(snapshot['documentOuterHTML'])
    message_dom = summarize_captured_value(snapshot['messageOuterHTML'])
    attributes = summarize_captured_value(snapshot['attributes'])
    accessibility = summarize_captured_value(ax_nodes)
    console = summarize_console_events(page_events)
    network = summarize_network_events(page_events)
    frames = summarize_frame_events(page_events)
    targets = summarize_target_events(browser_events)
    title = summarize_captured_value(snapshot['title'])
    location = summarize_captured_value(snapshot['location'])

    require(document_dom['utf8Bytes'] > 0 and message_dom['utf8Bytes'] > 0,
            f'SafeMarkdown DOM capture was empty in {mode} mode')
    require(attributes['utf8Bytes'] > 0 and accessibility['utf8Bytes'] > 0,
            f'SafeMarkdown attribute/AX capture was empty in {mode} mode')

    for name, channel in (
        ('document DOM', document_dom),
        ('message DOM', message_dom),
        ('attributes', attributes),
        ('accessibility tree', accessibility),
        ('console', console),
        ('window title', title),
        ('location', location),
    ):
        require(channel['forbiddenMarkerCount'] == 0,
                f'SafeMarkdown {name} leaked forbidden markers in {mode} mode')
    require(snapshot['cleanLinkCount'] == 1,
            f'SafeMarkdown clean link was not canonical in {mode} mode')
    require(snapshot['unsafeHrefCount'] == 0,
            f'SafeMarkdown exposed an unsafe href in {mode} mode')
    require(snapshot['imgCount'] == 0 and snapshot['srcCount'] == 0,
            f'SafeMarkdown created an image/resource attribute in {mode} mode')
    require(snapshot['dangerousElementCount'] == 0,
            f'SafeMarkdown rendered a dangerous raw HTML element in {mode} mode')
    require(snapshot['blockedLinkCount'] > 0 and snapshot['blockedImageCount'] > 0,
            f'SafeMarkdown did not render blocked-link/image affordances in {mode} mode')
    require(network['remoteRequestCount'] == 0,
            f'SafeMarkdown caused a remote request in {mode} mode')
    require(network['fixtureRemoteRequestCount'] == 0,
            f'SafeMarkdown requested a hostile fixture host in {mode} mode')
    require(network['urlSet']['forbiddenMarkerCount'] == 0,
            f'SafeMarkdown leaked a forbidden marker into a request in {mode} mode')
    require(frames['unexpectedFrameNavigationCount'] == 0,
            f'SafeMarkdown caused external frame navigation in {mode} mode')
    require(frames['urlSet']['forbiddenMarkerCount'] == 0,
            f'SafeMarkdown leaked a forbidden marker into frame navigation in {mode} mode')
    if expect_reload_navigation:
        require(frames['frameNavigationCount'] >= 1,
                'SafeMarkdown reload capture did not observe the expected clean frame navigation')
    else:
        require(frames['frameNavigationCount'] == 0,
                f'SafeMarkdown mode switch unexpectedly navigated a frame in {mode} mode')
    require(targets['newTargetCount'] == 0,
            f'SafeMarkdown created a new browser target in {mode} mode')
    require(is_clean_expected_entry_url(snapshot['location']),
            f'SafeMarkdown changed the renderer location in {mode} mode')
    require(isinstance(snapshot['title'], str) and bool(snapshot['title']),
            f'SafeMarkdown did not expose a capturable window title in {mode} mode')

    return {
        'passed': True,
        'mode': mode,
        'documentOuterHTML': document_dom,
        'messageOuterHTML': message_dom,
        'attributes': attributes,
        'accessibilityFullTree': accessibility,
        'console': console,
        'network': network,
        'frames': frames,
        'targets': targets,
        'title': title,
        'location': location,
        'windowPolicy': {
            'titleCaptured': True,
            'locationMatchesExpectedEntry': True,
        },
        'domPolicy': {
            'cleanLinkCount': snapshot['cleanLinkCount'],
            'unsafeHrefCount': snapshot['unsafeHrefCount'],
            'imgCount': snapshot['imgCount'],
            'srcCount': snapshot['srcCount'],
            'dangerousElementCount': snapshot['dangerousElementCount'],
            'blockedLinkCount': snapshot['blockedLinkCount'],
            'blockedImageCount': snapshot['blockedImageCount'],
        },
    }


def capture_safe_markdown_interaction(
    cdp: CDP,
    browser_cdp: CDP,
    name: str,
    button: str,
    modifiers: int,
) -> dict:
    selector = (
        '.chat-message.user .message-content '
        f'a[href={json.dumps(SAFE_MARKDOWN_CLEAN_URL)}]'
    )
    physical_scroll_into_view(cdp, selector)
    clear_security_events(cdp, browser_cdp)
    before_location = cdp.evaluate('location.href')
    physical_modified_click(cdp, selector, button, modifiers)
    cdp.pump_events(0.5)
    browser_cdp.pump_events(0.5)
    page_events = cdp.take_events()
    browser_events = browser_cdp.take_events()
    after_location = cdp.evaluate('location.href')

    network = summarize_network_events(page_events)
    frames = summarize_frame_events(page_events)
    targets = summarize_target_events(browser_events)
    console = summarize_console_events(page_events)
    require(before_location == after_location,
            f'SafeMarkdown {name} interaction changed renderer location')
    require(network['remoteRequestCount'] == 0,
            f'SafeMarkdown {name} interaction caused a remote request')
    require(network['urlSet']['forbiddenMarkerCount'] == 0,
            f'SafeMarkdown {name} interaction leaked a marker into a request')
    require(frames['frameNavigationCount'] == 0,
            f'SafeMarkdown {name} interaction navigated a frame')
    require(frames['urlSet']['forbiddenMarkerCount'] == 0,
            f'SafeMarkdown {name} interaction leaked a marker into navigation')
    require(targets['newTargetCount'] == 0,
            f'SafeMarkdown {name} interaction created a new target')
    require(console['forbiddenMarkerCount'] == 0,
            f'SafeMarkdown {name} interaction leaked a marker to console')
    return {
        'name': name,
        'passed': True,
        'button': button,
        'modifiers': modifiers,
        'locationUnchanged': True,
        'network': network,
        'frames': frames,
        'targets': targets,
        'console': console,
    }


def set_safe_markdown_ui_mode(cdp: CDP, mode: str) -> None:
    require(mode in {'normal', 'diagnostic'}, f'Invalid SafeMarkdown mode: {mode}')
    current = cdp.evaluate("document.querySelector('.app-layout')?.dataset.uiMode")
    if current == mode:
        return
    toggle_selector = '[data-testid="diagnostic-mode-toggle"]'
    navigate(cdp, 'settings')
    wait_for(cdp, f'document.querySelector({json.dumps(toggle_selector)})')
    physical_scroll_into_view(cdp, toggle_selector)
    checked = bool(cdp.evaluate(
        f'document.querySelector({json.dumps(toggle_selector)})?.checked'
    ))
    expected_checked = mode == 'diagnostic'
    if checked != expected_checked:
        physical_click(cdp, toggle_selector)
    wait_for(cdp, f"document.querySelector('.app-layout')?.dataset.uiMode === {json.dumps(mode)}")
    navigate(cdp, 'projects')
    selected_mode = cdp.evaluate(
        "document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim()"
    )
    if selected_mode != '对话':
        physical_click(cdp, '.shell-mode-btn', '对话')
        wait_for(cdp, "document.querySelector('.shell-mode-btn[aria-selected=\"true\"]')?.textContent?.trim() === '对话'")
    wait_for_safe_markdown_fixture(cdp)


def delete_safe_markdown_fixture(cdp: CDP, session_id: str) -> dict:
    result = cdp.evaluate(f"""
    (async () => {{
      await window.metis.deleteSession({json.dumps(session_id)});
      const payload = await window.metis.listSessions();
      if (!payload || payload.success !== true || !Array.isArray(payload.sessions)) {{
        throw new Error('Structured session list was unavailable during fixture cleanup');
      }}
      return !payload.sessions.some(
        (session) => session.id === {json.dumps(session_id)}
      );
    }})()
    """, await_promise=True)
    require(result is True, 'SafeMarkdown fixture session was not deleted')
    return {'sessionDeleted': True}


def assert_safe_markdown_security(
    cdp: CDP,
    browser_cdp: CDP,
    output_dir: pathlib.Path,
) -> dict:
    cdp.set_phase('safe-markdown:setup')
    cdp.call('Network.enable')
    cdp.call('Log.enable')
    cdp.call('Accessibility.enable')
    browser_cdp.call('Target.setDiscoverTargets', {'discover': True})
    clear_security_events(cdp, browser_cdp)

    ingress = seed_safe_markdown_fixture(cdp)
    session_id = ingress['sessionId']
    clear_security_events(cdp, browser_cdp)
    cdp.set_phase('safe-markdown:normal:reload')
    cdp.call('Page.reload', {'ignoreCache': True})
    wait_for_after_reload(
        cdp,
        "document.querySelector('.app-layout')?.dataset.uiMode === 'normal'",
    )
    wait_for_after_reload(cdp, f"""
      [...document.querySelectorAll('.chat-message.user')].some(
        (element) => element.textContent?.includes({json.dumps(SAFE_MARKDOWN_MARKER)})
      )
    """)
    normal = capture_safe_markdown_mode(
        cdp,
        browser_cdp,
        'normal',
        expect_reload_navigation=True,
    )
    normal_interactions = [
        capture_safe_markdown_interaction(
            cdp, browser_cdp, 'middle-click', 'middle', 0,
        ),
        capture_safe_markdown_interaction(
            cdp, browser_cdp, 'control-click', 'left', 2,
        ),
        capture_safe_markdown_interaction(
            cdp, browser_cdp, 'shift-click', 'left', 8,
        ),
    ]

    clear_security_events(cdp, browser_cdp)
    set_safe_markdown_ui_mode(cdp, 'diagnostic')
    diagnostic = capture_safe_markdown_mode(
        cdp,
        browser_cdp,
        'diagnostic',
        expect_reload_navigation=False,
    )
    diagnostic_interactions = [
        capture_safe_markdown_interaction(
            cdp, browser_cdp, 'diagnostic-middle-click', 'middle', 0,
        ),
        capture_safe_markdown_interaction(
            cdp, browser_cdp, 'diagnostic-control-click', 'left', 2,
        ),
        capture_safe_markdown_interaction(
            cdp, browser_cdp, 'diagnostic-shift-click', 'left', 8,
        ),
    ]

    set_safe_markdown_ui_mode(cdp, 'normal')
    cleanup = delete_safe_markdown_fixture(cdp, session_id)
    result = {
        'passed': True,
        'ingress': {
            key: value
            for key, value in ingress.items()
            if key != 'sessionId'
        },
        'normal': normal,
        'diagnostic': diagnostic,
        'interactions': {
            'passed': True,
            'normal': normal_interactions,
            'diagnostic': diagnostic_interactions,
        },
        'cleanup': {
            **cleanup,
            'normalRestored': True,
        },
    }
    evidence_path = output_dir / 'safe-markdown-security.json'
    evidence_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    result['evidence'] = {
        'file': evidence_path.name,
        'sha256': hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--output-dir', type=pathlib.Path, required=True)
    parser.add_argument('--expected-profile', type=pathlib.Path, required=True)
    parser.add_argument('--force-failure-after-handshake', action='store_true')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    page = wait_for_target(args.port)
    cdp = CDP(
        page,
        args.port,
        args.output_dir / 'cdp-trace.ndjson',
    )
    browser_cdp: CDP | None = None
    report = {
        'scope': {
            'rendererResponsiveMatrix': True,
            'windowsNativeWindowMatrix': False,
            'safeMarkdownSecurity': False,
            'pixelRegression': False,
            'screenshots': 'manual review evidence only',
        },
        'page': {'title': page.get('title'), 'url': page.get('url')},
        'viewports': [],
        'boundaryShellWidths': [],
        'windowControlRelease': {
            'attempted': False,
            'released': False,
            'postReleaseRequestRejected': False,
        },
    }
    control_released = False
    try:
        cdp.call('Runtime.enable')
        cdp.call('Page.enable')
        version = cdp.call('Browser.getVersion').get('result', {})
        report['browser'] = version
        require(canonical_file_url(str(page.get('url', ''))) == EXPECTED_ENTRY,
                f'Unexpected page URL: {page.get("url")}')
        wait_for(cdp, "document.title === 'metis-workbench'")
        wait_for(cdp, "document.querySelector('.project-shell')")
        wait_for(cdp, "document.querySelector('.app-layout')?.dataset.uiMode === 'normal'")
        report['page']['runtimeTitle'] = cdp.evaluate('document.title')
        report['environment'] = verify_acceptance_environment(cdp, args.expected_profile)
        browser_target = wait_for_browser_target(args.port)
        browser_cdp = CDP(
            browser_target,
            args.port,
            args.output_dir / 'browser-cdp-trace.ndjson',
        )
        if args.force_failure_after_handshake:
            report['failureInjection'] = {
                'requested': True,
                'phase': 'after-environment-handshake',
            }
            raise AssertionError(
                'Intentional acceptance failure after environment handshake'
            )

        for width in REVIEW_VIEWPORTS:
            set_viewport(cdp, width)
            snapshot = layout_snapshot(cdp)
            assert_snapshot(snapshot, width, f'{width}px renderer viewport')
            assert_diagnostic_controls_absent(cdp, f'{width}px normal project')
            capture(cdp, args.output_dir / f'layout-{width}x900.png')
            report['viewports'].append({
                'requestedViewportWidth': width,
                'measuredViewportWidth': snapshot['viewport']['width'],
                'shellWidth': snapshot['shell']['width'],
                'band': snapshot['shell']['band'],
                'gridTemplateColumns': snapshot['shell']['gridTemplateColumns'],
                'geometry': snapshot['geometry'],
                'overflow': snapshot['overflow'],
                'classes': snapshot['shell']['classes'],
                'collapseButtons': snapshot['buttons'],
            })

        for target_width in BOUNDARY_SHELL_WIDTHS:
            viewport_width, snapshot, fixture_sidebar_width = find_viewport_for_shell_width(
                cdp,
                target_width,
            )
            assert_snapshot(snapshot, viewport_width,
                            f'{target_width}px shell boundary')
            expected = expected_band(snapshot['shell']['clientWidth'])
            require(snapshot['shell']['band'] == expected,
                    f'Boundary shell band mismatch at {target_width}')
            report['boundaryShellWidths'].append({
                'targetShellWidth': target_width,
                'measuredBoundingShellWidth': snapshot['shell']['width'],
                'measuredResponsiveShellWidth': snapshot['shell']['clientWidth'],
                'requestedViewportWidth': viewport_width,
                'measuredViewportWidth': snapshot['viewport']['width'],
                'boundaryFixtureSidebarWidth': fixture_sidebar_width,
                'expectedBand': expected,
                'actualBand': snapshot['shell']['band'],
                'gridTemplateColumns': snapshot['shell']['gridTemplateColumns'],
                'geometry': snapshot['geometry'],
            })
        clear_shell_width_fixture(cdp)

        set_viewport(cdp, 1300)
        medium = layout_snapshot(cdp)
        require(medium['shell']['band'] == 'medium',
                '1300px renderer viewport did not enter medium band')
        report['overlays'] = [
            assert_overlay(
                cdp,
                'right',
                args.output_dir / 'overlay-right-medium-1300x900.png',
                260,
                close_with_escape=True,
            ),
        ]

        set_viewport(cdp, 650)
        narrow = layout_snapshot(cdp)
        require(narrow['shell']['band'] == 'narrow',
                '650px renderer viewport did not enter narrow band')
        report['overlays'].extend([
            assert_overlay(
                cdp,
                'left',
                args.output_dir / 'overlay-left-narrow-650x900.png',
                min(240, narrow['shell']['width'] - 64),
                close_with_escape=False,
            ),
            assert_overlay(
                cdp,
                'right',
                args.output_dir / 'overlay-right-narrow-650x900.png',
                min(260, narrow['shell']['width'] - 64),
                close_with_escape=True,
            ),
        ])

        set_viewport(cdp, 1440)
        report['modes'] = assert_modes(cdp)
        report['manualCollapse'] = [
            assert_manual_collapse(cdp, 'left'),
            assert_manual_collapse(cdp, 'right'),
        ]

        cdp.set_phase('renderer-viewport:clear-before-wheel')
        cdp.call('Emulation.clearDeviceMetricsOverride')
        wait_for_stable_layout(cdp)
        native_renderer_size = cdp.evaluate(
            '({ width: window.innerWidth, height: window.innerHeight })'
        )
        require(
            native_renderer_size['width'] > 0 and
            native_renderer_size['height'] > 0,
            'Renderer did not restore native geometry before wheel input: '
            f'{native_renderer_size}',
        )
        report['nativeRendererBeforeDiagnosticWheel'] = (
            native_renderer_size
        )

        report['diagnosticBoundary'] = assert_diagnostic_boundary(cdp)
        capture(cdp, args.output_dir / 'layout-final-normal.png')

        report['nativeWindowMatrix'] = []
        assert_native_window_matrix(
            cdp,
            args.output_dir,
            report['nativeWindowMatrix'],
        )
        report['scope']['windowsNativeWindowMatrix'] = True
        report['safeMarkdownSecurity'] = assert_safe_markdown_security(
            cdp,
            browser_cdp,
            args.output_dir,
        )
        report['scope']['safeMarkdownSecurity'] = True
        report['windowControlRelease'] = (
            release_acceptance_window_control(cdp)
        )
        control_released = True

        report['status'] = 'passed'
        report_path = args.output_dir / 'electron-layout-acceptance.json'
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = f'{type(error).__name__}: {error}'
        failed_cdp = (
            browser_cdp
            if browser_cdp is not None and browser_cdp.broken
            else cdp
        )
        report['lastCdpOperation'] = failed_cdp.last_operation
        report['lastCdpEvent'] = failed_cdp.last_event
        report['cdpConnectionBroken'] = bool(
            cdp.broken or (browser_cdp is not None and browser_cdp.broken)
        )
        report['failedCdpChannel'] = (
            'browser' if failed_cdp is browser_cdp else 'renderer'
        )
        report_path = args.output_dir / 'electron-layout-acceptance.json'
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    finally:
        if not cdp.broken:
            if not control_released:
                try:
                    report['windowControlRelease'] = (
                        release_acceptance_window_control(cdp)
                    )
                    control_released = True
                except Exception as release_error:
                    report['windowControlRelease'] = {
                        'attempted': True,
                        'released': False,
                        'postReleaseRequestRejected': False,
                        'error': (
                            f'{type(release_error).__name__}: '
                            f'{release_error}'
                        ),
                    }
            try:
                cdp.set_phase('cleanup')
                if cdp.evaluate("document.querySelector('.app-layout')?.dataset.uiMode") == 'diagnostic':
                    cdp.evaluate("localStorage.setItem('metis-diagnostic-mode', 'normal')")
            except Exception:
                pass
            report_path = args.output_dir / 'electron-layout-acceptance.json'
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2),
                encoding='utf-8',
            )
        try:
            if browser_cdp is not None:
                browser_cdp.close()
        finally:
            cdp.close()


if __name__ == '__main__':
    raise SystemExit(main())
