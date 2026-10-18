import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import {
  createDiagnosticAnchorHitbox,
  DIAGNOSTIC_POPOVER_GAP,
  findDiagnosticAnchorAtPoint,
  getDiagnosticPopoverVerticalPlacement,
  splitHighlightTokensAtDiagnostics,
} from '../src/editor/diagnosticRendering.ts';

test('diagnostic hover hitboxes cover the marked character and underline without reaching neighbors', () => {
  const first = createDiagnosticAnchorHitbox(
    { left: 10, right: 15, top: 0, bottom: 16 },
    3,
    40,
  );
  const second = createDiagnosticAnchorHitbox(
    { left: 16, right: 21, top: 0, bottom: 16 },
    3,
    42,
  );

  assert.equal(findDiagnosticAnchorAtPoint([first, second], 12, 8)?.offset, 40);
  assert.equal(findDiagnosticAnchorAtPoint([first, second], 18, 8)?.offset, 42);
  assert.equal(findDiagnosticAnchorAtPoint([first, second], 12, -1), null);
  assert.equal(findDiagnosticAnchorAtPoint([first, second], 12, 19)?.offset, 40);
  assert.equal(findDiagnosticAnchorAtPoint([first, second], 28, 8), null);

  const afterScroll = createDiagnosticAnchorHitbox(
    { left: 10, right: 15, top: -15, bottom: 1 },
    3,
    40,
  );
  assert.equal(findDiagnosticAnchorAtPoint([afterScroll], 12, 17), null);
  assert.equal(findDiagnosticAnchorAtPoint([afterScroll], 12, 0)?.offset, 40);
});

test('an open popover stays outside both nearby anchors on its active line', () => {
  const first = createDiagnosticAnchorHitbox(
    { left: 10, right: 15, top: 40, bottom: 60 },
    3,
    40,
  );
  const second = createDiagnosticAnchorHitbox(
    { left: 18, right: 23, top: 40, bottom: 60 },
    3,
    48,
  );
  const placement = getDiagnosticPopoverVerticalPlacement(40, 21, 220, 80);

  assert.equal(placement.side, 'below');
  assert.ok(first.bottom < placement.top);
  assert.ok(second.bottom < placement.top);
  assert.equal(findDiagnosticAnchorAtPoint([first, second], 12, 58)?.offset, 40);
  assert.equal(findDiagnosticAnchorAtPoint([first, second], 20, 58)?.offset, 48);

  const flipped = getDiagnosticPopoverVerticalPlacement(170, 21, 220, 80);
  assert.equal(flipped.side, 'above');
  assert.ok(flipped.top + 80 <= 170 - DIAGNOSTIC_POPOVER_GAP);
});

test('diagnostic anchors keep a surrogate pair together across syntax spans and escape source text', () => {
  const source = 'x😀<img>';
  const tokens = [
    { start: 0, end: 1, kind: 'plain' },
    { start: 1, end: 2, kind: 'number' },
    { start: 2, end: 3, kind: 'operator' },
    { start: 3, end: 4, kind: 'operator' },
    { start: 4, end: 7, kind: 'plain' },
    { start: 7, end: 8, kind: 'punctuation' },
  ];
  const segments = splitHighlightTokensAtDiagnostics(source, tokens, [{ start: 1, length: 2 }]);

  assert.equal(segments.map(({ start, end }) => source.slice(start, end)).join(''), source);
  assert.deepEqual(segments, [
    { start: 0, end: 1, kind: 'plain', diagnostic: false },
    { start: 1, end: 3, kind: 'number', diagnostic: true },
    { start: 3, end: 4, kind: 'operator', diagnostic: false },
    { start: 4, end: 7, kind: 'plain', diagnostic: false },
    { start: 7, end: 8, kind: 'punctuation', diagnostic: false },
  ]);

  const markup = renderToStaticMarkup(createElement('pre', null, segments.map(segment => (
    createElement('span', {
      key: segment.start,
      className: `syntax-${segment.kind}${segment.diagnostic ? ' editor-diagnostic-anchor' : ''}`,
    }, source.slice(segment.start, segment.end))
  ))));
  assert.match(markup, /class="syntax-number editor-diagnostic-anchor">😀<\/span>/);
  assert.ok(markup.includes('&lt;'));
  assert.ok(markup.includes('img'));
  assert.ok(markup.includes('&gt;'));
  assert.ok(!markup.includes('<img>'));
});

test('long overlapping diagnostic ranges produce a bounded set of line spans', () => {
  const source = 'x'.repeat(10_000);
  const tokens = [{ start: 0, end: source.length, kind: 'plain' }];
  const segments = splitHighlightTokensAtDiagnostics(source, tokens, [
    { start: 0, length: 8_000, kind: 'primary', diagnosticLine: 4 },
    { start: 100, length: 7_900, kind: 'related', diagnosticLine: 4 },
  ]);

  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(({ start, end, diagnostic, related, diagnosticLine }) => ({
    start, end, diagnostic, related, diagnosticLine,
  })), [
    { start: 0, end: 8_000, diagnostic: true, related: undefined, diagnosticLine: 4 },
    { start: 8_000, end: 10_000, diagnostic: false, related: undefined, diagnosticLine: undefined },
  ]);
});

test('related ranges keep their own decoration and diagnostic hover target', () => {
  const source = 'int total = (10 + 5;';
  const tokens = [{ start: 0, end: source.length, kind: 'plain' }];
  const segments = splitHighlightTokensAtDiagnostics(source, tokens, [
    { start: 19, length: 1, kind: 'primary', diagnosticLine: 1 },
    { start: 12, length: 7, kind: 'related', diagnosticLine: 1 },
  ]);

  assert.equal(segments.map(({ start, end }) => source.slice(start, end)).join(''), source);
  const primary = segments.find(segment => segment.diagnostic && !segment.related);
  const related = segments.find(segment => segment.diagnostic && segment.related);
  assert.deepEqual(primary, {
    start: 19,
    end: 20,
    kind: 'plain',
    diagnostic: true,
    diagnosticLine: 1,
  });
  assert.deepEqual(related, {
    start: 12,
    end: 19,
    kind: 'plain',
    diagnostic: true,
    related: true,
    diagnosticLine: 1,
  });

  const markup = renderToStaticMarkup(createElement('pre', null, segments.map(segment => (
    createElement('span', {
      key: segment.start,
      className: `syntax-${segment.kind}${segment.diagnostic
        ? segment.related
          ? ' editor-diagnostic-mark editor-diagnostic-related-anchor'
          : ' editor-diagnostic-mark editor-diagnostic-anchor'
        : ''}`,
      'data-diagnostic-line': segment.diagnosticLine,
      'data-diagnostic-offset': segment.diagnostic ? segment.start : undefined,
    }, source.slice(segment.start, segment.end))
  ))));
  assert.match(markup, /class="syntax-plain editor-diagnostic-mark editor-diagnostic-related-anchor" data-diagnostic-line="1" data-diagnostic-offset="12">\(10 \+ 5/);
});
