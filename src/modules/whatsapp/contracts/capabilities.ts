/**
 * What a provider can actually express on the wire.
 *
 * Read this alongside `errors.ts`: a `false` here is not permission to silently
 * drop a message. Only the two courtesy signals — typing indicator and read
 * receipt — degrade to a no-op, because a missing "seen" tick costs the reader
 * nothing. Everything else a provider cannot express throws
 * `WhatsappCapabilityError` at call time, so the failure lands on the caller
 * that asked for it rather than surfacing later as a message that never arrived.
 */
export interface ProviderCapabilities {
  typingIndicator: boolean;
  readReceipts: boolean;
  interactiveButtons: boolean;
  interactiveList: boolean;
  /** Free-form message with a URL button (`interactive.type: 'cta_url'`). */
  interactiveCta: boolean;
  carousel: boolean;
  flows: boolean;
  location: boolean;
  reactions: boolean;
  /**
   * Always false, both providers. Meta enforces the 24h customer-service window
   * at the platform level, so no provider can opt out of it — the field exists
   * to make that explicit at the call site rather than implied by its absence.
   *
   * The window itself is decided proactively in
   * `WhatsAppService.isServiceWindowOpen`, from the newest INBOUND message row.
   */
  freeformOutsideWindow: false;
  /**
   * A template whose HEADER is a document supplied at SEND time.
   *
   * Twilio bakes media into the approved Content template and accepts nothing
   * at send time — `twilio.provider.sendMedia` drops `OutboundMedia.kind` and
   * `filename` outright — so there is no Twilio shape for this at all.
   *
   * Callers must ask BEFORE rendering, not after: the work here is a PDF
   * render, an object upload and a presign, all wasted on a provider that
   * cannot deliver the result.
   */
  templateDocumentHeader: boolean;
}

export type Capability = keyof ProviderCapabilities;
