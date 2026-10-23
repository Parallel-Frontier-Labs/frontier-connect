import { App } from '@modelcontextprotocol/ext-apps';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_CSP, FRAME_GUARD, FRAME_SANDBOX, framedHtml } from '../src/preview/frame';
import { appCapabilities, createHostBridge } from '../src/hostBridge';

describe('framedHtml', () => {
  it('puts the CSP first, after a leading doctype, and keeps the page intact', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${FRAME_GUARD}`;
    expect(framedHtml('<!doctype html><p>x')).toBe(`<!doctype html>${meta}<p>x`);
    expect(framedHtml('\uFEFF  <!DOCTYPE HTML>\n<p>x')).toBe(`\uFEFF  <!DOCTYPE HTML>${meta}\n<p>x`);
    expect(framedHtml('<html><p>x')).toBe(`${meta}<html><p>x`);
  });
  it('allows inline script and style only, with no network at all', () => {
    expect(FRAME_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:");
    expect(FRAME_SANDBOX).toBe('allow-scripts');
  });
});

describe('FRAME_GUARD', () => {
  it('removes every WebRTC constructor and pins it, which CSP cannot do', () => {
    expect(FRAME_GUARD.startsWith('<script>')).toBe(true);
    const body = FRAME_GUARD.slice('<script>'.length, FRAME_GUARD.indexOf('</script>'));
    const names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSctpTransport', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCDataChannelEvent', 'mozRTCPeerConnection'];
    const stub: Record<string, unknown> = {};
    for (const n of names) Object.defineProperty(stub, n, { value: function () {}, configurable: true, writable: true });
    new Function('window', body)(stub);
    for (const n of names) {
      expect(stub[n], n).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(stub, n)?.configurable, n).toBe(false);
    }
  });
});

describe('host channel', () => {
  it('ignores a message from any window but the parent', async () => {
    const app = new App({ name: 't', version: '0' }, appCapabilities);
    createHostBridge(app);
    const seen = vi.fn();
    app.ontoolresult = seen;
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const msg = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { probe: 1 } } };
    window.dispatchEvent(new MessageEvent('message', { data: msg, source: frame.contentWindow }));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: msg, source: window })); // jsdom: window.parent === window
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
  });
});
