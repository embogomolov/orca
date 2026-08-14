import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { nativeChatProviderFrameSummary } from '../../../../shared/native-chat-provider-frame-summary'
import {
  NativeChatImageAttachments as NativeChatImageGallery,
  type NativeChatImageLoadContext
} from './NativeChatImageAttachments'

export function NativeChatImageAttachments({
  blocks,
  loadContext
}: {
  blocks: NativeChatBlock[]
  loadContext?: NativeChatImageLoadContext
}): React.JSX.Element | null {
  const images = blocks.filter((block) => block.type === 'image-ref')
  if (images.length === 0) {
    return null
  }
  return (
    <NativeChatImageGallery
      images={images.map((image, index) => {
        const label = image.alt ?? image.path ?? image.url ?? 'Image'
        return {
          id: `${image.path ?? image.url ?? label}:${index}`,
          path: image.path,
          url: image.url,
          fileName:
            image.path && isNativeChatPastedImagePath(image.path)
              ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
              : image.path
                ? basename(image.path)
                : label
        }
      })}
      loadContext={loadContext}
    />
  )
}

export function NativeChatAgentControls({
  markdown,
  onScrollToTop,
  className
}: {
  markdown: string
  onScrollToTop: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <NativeChatCopyButton text={markdown} />
      <button
        type="button"
        onClick={onScrollToTop}
        aria-label={translate(
          'components.native-chat.scrollMessageToTop',
          'Scroll this message to top'
        )}
        title={translate('components.native-chat.scrollMessageToTop', 'Scroll this message to top')}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUp className="size-3.5" />
      </button>
    </div>
  )
}

export function ProviderFrameRow({ block }: { block: NativeChatBlock }): React.JSX.Element | null {
  if (block.type !== 'text' || !block.providerFrame) {
    return null
  }
  const frame = block.providerFrame
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="transition-transform group-open:rotate-90">›</span>
        <span className="font-medium text-foreground">{frame.provider}</span>
        <span className="truncate">{nativeChatProviderFrameSummary(block)}</span>
        {frame.payload.truncated ? (
          <span>
            ·{' '}
            {translate('components.native-chat.providerFrame.byteLength', '{{value0}} bytes', {
              value0: frame.payload.byteLength
            })}
          </span>
        ) : null}
      </summary>
      <pre className="scrollbar-sleek mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground">
        {frame.payload.head}
        {frame.payload.truncated ? '\n…' : ''}
      </pre>
    </details>
  )
}
