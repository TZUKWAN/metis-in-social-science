export interface RendererMainFrameContext {
  senderWindowMatches: boolean;
  senderFrameMatches: boolean;
  senderFrameUrl: string;
  expectedEntryUrl: string;
}

function normalizeDocumentUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Pure authorization policy for privileged renderer IPC. The caller must
 * derive both identity booleans from live Electron objects; URLs alone never
 * grant authority.
 */
export function isAuthorizedRendererMainFrame(
  context: RendererMainFrameContext,
): boolean {
  if (!context.senderWindowMatches || !context.senderFrameMatches) return false;
  const senderUrl = normalizeDocumentUrl(context.senderFrameUrl);
  const expectedUrl = normalizeDocumentUrl(context.expectedEntryUrl);
  return senderUrl !== null && expectedUrl !== null && senderUrl === expectedUrl;
}
