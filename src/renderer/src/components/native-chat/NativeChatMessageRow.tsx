import { useCallback, useMemo, useRef } from 'react'
import { ArrowUp } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import type { StreamingMarkdownFade } from '@/components/sidebar/streaming-markdown-fade'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import {
  isTextBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { splitNativeChatBlocks } from './native-chat-tool-fold'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { literalRoomTransportText } from './native-chat-room-transport'
import {
  NativeChatImageAttachments,
  type NativeChatImageLoadContext
} from './NativeChatImageAttachments'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'

function proseToMarkdown(blocks: NativeChatBlock[]): string {
  return blocks
    .map((block) => (isTextBlock(block) ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n\n')
}

function ImageAttachmentRefs({
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
    <NativeChatImageAttachments
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

function AgentControls({
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

export function NativeChatMessageRow({
  message,
  expandSignal,
  onScrollMessageToTop,
  onLinkClick,
  allowFileUriLinks = false,
  deliveryFailed = false,
  imageLoadContext,
  streamingFade
}: {
  message: NativeChatMessage
  expandSignal: boolean
  onScrollMessageToTop: (el: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryFailed?: boolean
  imageLoadContext?: NativeChatImageLoadContext
  streamingFade?: StreamingMarkdownFade
}): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const { prose, tools } = useMemo(() => splitNativeChatBlocks(message.blocks), [message.blocks])
  const markdown = proseToMarkdown(prose)
  const hasImages = prose.some((block) => block.type === 'image-ref')
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'
  const isSubagentTask = message.subagentEvent?.kind === 'task'
  const providerFrame = message.blocks.find((block) => block.type === 'text' && block.providerFrame)
  const literalTransport = literalRoomTransportText(markdown)
  const renderedText = literalTransport ?? markdown

  const scrollToTop = useCallback(() => {
    if (rowRef.current) {
      onScrollMessageToTop(rowRef.current)
    }
  }, [onScrollMessageToTop])

  if (markdown.length === 0 && !hasImages && tools.length === 0) {
    return null
  }

  if (providerFrame) {
    return (
      <div ref={rowRef}>
        <ProviderFrameRow block={providerFrame} />
      </div>
    )
  }

  if (isUser) {
    return (
      <div ref={rowRef} className="flex flex-col items-end gap-0.5">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {renderedText ? (
            <>
              <ImageAttachmentRefs blocks={prose} loadContext={imageLoadContext} />
              {literalTransport !== null ? (
                <div className="whitespace-pre-wrap break-words">{renderedText}</div>
              ) : (
                <CommentMarkdown
                  content={renderedText}
                  variant="document"
                  className="text-sm"
                  onLinkClick={onLinkClick}
                  allowFileUriLinks={allowFileUriLinks}
                />
              )}
            </>
          ) : (
            <ImageAttachmentRefs blocks={prose} loadContext={imageLoadContext} />
          )}
        </div>
        {deliveryFailed ? (
          <div className="max-w-[85%] text-[11px] text-destructive/80">
            {translate(
              'components.native-chat.launchPromptNotDelivered',
              'Not delivered — check the terminal'
            )}
          </div>
        ) : null}
      </div>
    )
  }

  if (isSubagentTask) {
    return (
      <div
        ref={rowRef}
        className="w-fit rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
      >
        {markdown}
      </div>
    )
  }

  const showControls = !isReasoning && !isSystem && renderedText.length > 0

  return (
    <div
      ref={rowRef}
      className={cn(
        'group relative max-w-full text-sm leading-relaxed text-foreground',
        isReasoning && 'border-l-2 border-border/60 pl-3 italic text-muted-foreground',
        isSystem && 'text-xs text-muted-foreground'
      )}
    >
      {showControls ? (
        <AgentControls
          markdown={renderedText}
          onScrollToTop={scrollToTop}
          className="absolute -top-8 right-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        />
      ) : null}
      <ImageAttachmentRefs blocks={prose} loadContext={imageLoadContext} />
      {renderedText ? (
        literalTransport !== null ? (
          <div className="whitespace-pre-wrap break-words">{renderedText}</div>
        ) : (
          <CommentMarkdown
            content={renderedText}
            variant="document"
            className="text-sm"
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            streamingFade={streamingFade}
          />
        )
      ) : null}
      {tools.length > 0 ? <NativeChatToolRun blocks={tools} expandSignal={expandSignal} /> : null}
    </div>
  )
}
