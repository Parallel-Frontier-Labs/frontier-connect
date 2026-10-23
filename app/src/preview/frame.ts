/** An HTML deliverable runs in <iframe sandbox="allow-scripts" srcdoc> under this CSP, which blocks
 * all network access except WebRTC (ICE/STUN and DNS), so FRAME_GUARD removes WebRTC before page scripts run.
 * In Chromium, child frames the page creates are cross-origin to it (verified), so they cannot hand the
 * constructor back. Other engines were not verified: there WebRTC is reduced, not proven eliminated.
 * This CSP does not govern navigation: the page could still leave with location.href, a meta refresh or
 * a clicked link, carrying data in the URL. The card's own index.html sets `frame-src 'none'`, which
 * blocks every navigation of this frame (a srcdoc frame still loads and runs); the card has no other frame.
 * Never widen the sandbox or the CSP, and never drop the card's frame-src. */
export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
export const FRAME_GUARD = "<script>for(const k of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceTransport','RTCSctpTransport','RTCIceCandidate','RTCSessionDescription','RTCRtpSender','RTCRtpReceiver','RTCRtpTransceiver','RTCDtlsTransport','RTCDataChannelEvent','mozRTCPeerConnection'])try{delete window[k];Object.defineProperty(window,k,{value:undefined,configurable:false,writable:false})}catch(e){}</script>";
export const FRAME_SANDBOX = 'allow-scripts';
const DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

export function framedHtml(text: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${FRAME_GUARD}`;
  const m = DOCTYPE.exec(text);
  return m ? m[0] + meta + text.slice(m[0].length) : meta + text;
}
