import { useEffect, useState } from 'react'
import {
  ChevronRight,
  CircleStop,
  CircleX,
  FileText,
  Globe2,
  Pencil,
  Search,
  SquareTerminal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { RoomActivityKind, RoomAgentActivity, RoomParticipant } from '../../../../shared/rooms'
import { hasRoomActivityDetails, RoomActivityDetails } from './RoomActivityTimeline'
import { RoomAuthorAvatar } from './RoomAuthorAvatar'
import { AgentSubagentTurnLink } from '../agent-subagents/AgentSubagentContext'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { Button } from '@/components/ui/button'
import { NativeChatQuestionCard } from '@/components/native-chat/NativeChatQuestionCard'
import { visibleRoomReplyText } from '@/components/native-chat/native-chat-room-transport'
import { showRoomActionError } from './room-action-error'
import { cancelRoomStructuredTurn, respondToRoomPrompt } from './room-structured-prompt-actions'
import { formatRoomActivityDuration } from './room-activity-timeline'

export function RoomActivityCard({
  activity,
  participant,
  target,
  stack
}: {
  activity: RoomAgentActivity
  participant?: RoomParticipant
  target?: RuntimeClientTarget
  stack?: {
    open: boolean
    onOpen: () => void
    triggerRef: React.Ref<HTMLButtonElement>
    ariaLabel: string
  }
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const stackCollapsed = stack?.open === false
  const expandable = hasRoomActivityDetails(activity.messages, activity.detail)
  const steerResponse = visibleSteerResponse(activity)
  const primaryPermissionOptionIndex =
    activity.permission?.options.findIndex((option) => option.kind !== 'reject') ?? -1
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div
        className={cn(
          'rounded-lg border border-border/70 bg-muted/15 px-3 py-2',
          stack && 'transition-colors duration-200 ease motion-reduce:transition-none',
          stackCollapsed && 'bg-background shadow-xs can-hover:hover:bg-accent'
        )}
      >
        {stackCollapsed ? (
          <button
            ref={stack.triggerRef}
            type="button"
            aria-label={stack.ariaLabel}
            aria-expanded={false}
            className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={stack.onOpen}
          >
            <RoomActivitySummaryContent
              activity={activity}
              participant={participant}
              showChevron
              showSteerResponse
            />
          </button>
        ) : expandable ? (
          <CollapsibleTrigger asChild>
            <button type="button" className="w-full text-left">
              <RoomActivitySummaryContent
                activity={activity}
                participant={participant}
                expanded={expanded}
                showChevron
              />
            </button>
          </CollapsibleTrigger>
        ) : (
          <div className="cursor-default">
            <RoomActivitySummaryContent activity={activity} participant={participant} />
          </div>
        )}
        <div
          aria-hidden={stackCollapsed || undefined}
          inert={stackCollapsed || undefined}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease motion-reduce:transition-none',
            stackCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {expandable ? (
              <CollapsibleContent className="room-activity-disclosure-content">
                <RoomActivityDetails
                  messages={activity.messages}
                  fallback={{ kind: activity.kind, detail: activity.detail }}
                />
              </CollapsibleContent>
            ) : null}
            {steerResponse && !expanded ? (
              <div
                className={cn(
                  'mt-2 max-h-40 overflow-y-auto border-l border-border/70 pl-4 pr-2 scrollbar-sleek',
                  stackCollapsed && 'invisible'
                )}
              >
                <CommentMarkdown
                  content={steerResponse}
                  variant="document"
                  className="text-sm"
                  allowFileUriLinks
                />
              </div>
            ) : null}
            {activity.permission &&
            participant?.providerSession?.transport === 'machine' &&
            target ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {activity.permission.options.map((option, index) => (
                  <Button
                    key={option.id}
                    size="xs"
                    variant={
                      option.kind === 'reject'
                        ? 'outline'
                        : index === primaryPermissionOptionIndex
                          ? 'default'
                          : 'secondary'
                    }
                    onClick={() =>
                      void respondToRoomPrompt(
                        target,
                        participant.providerSession!.id,
                        'approval',
                        activity.permission!.itemId ?? activity.permission!.id,
                        activity.permission!.revision ?? 1,
                        option.id
                      ).catch(showRoomActionError)
                    }
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            ) : null}
            {activity.input && participant?.providerSession?.transport === 'machine' && target ? (
              <div className="mt-3">
                <NativeChatQuestionCard
                  key={activity.input.id}
                  prompt={{
                    questions: activity.input.questions.map((question) => ({
                      ...question,
                      multiSelect: question.multiSelect ?? false,
                      options: question.options ?? []
                    }))
                  }}
                  allowOther={activity.input.questions.some((question) => question.allowOther)}
                  onAnswer={(selections) => {
                    const answers = Object.fromEntries(
                      activity.input!.questions.map((question, index) => {
                        const selection = selections[index]
                        const picked = (selection?.indices ?? []).flatMap((optionIndex) => {
                          const label = question.options?.[optionIndex]?.label
                          return label ? [label] : []
                        })
                        const other = selection?.other?.trim()
                        return [question.id, other ? [...picked, other] : picked]
                      })
                    )
                    void respondToRoomPrompt(
                      target,
                      participant.providerSession!.id,
                      'question',
                      activity.input!.itemId ?? activity.input!.id,
                      activity.input!.revision ?? 1,
                      `answers:${JSON.stringify(answers)}`
                    ).catch(showRoomActionError)
                  }}
                  onCancel={() =>
                    void cancelRoomStructuredTurn(target, participant.providerSession!.id).catch(
                      showRoomActionError
                    )
                  }
                />
              </div>
            ) : null}
            {participant ? (
              <AgentSubagentTurnLink
                sourceKey={participant.id}
                startedAt={activity.startedAt}
                completedAt={null}
              />
            ) : null}
          </div>
        </div>
      </div>
    </Collapsible>
  )
}

function visibleSteerResponse(activity: RoomAgentActivity): string {
  const steer = activity.messages.findLastIndex((message) => message.role === 'user')
  if (steer === -1) {
    return ''
  }
  for (let index = activity.messages.length - 1; index > steer; index -= 1) {
    const message = activity.messages[index]!
    if (message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
    const visible = visibleRoomReplyText(text)
    if (visible) {
      return visible
    }
  }
  return ''
}

function RoomActivitySummaryContent({
  activity,
  participant,
  expanded = false,
  showChevron = false,
  showSteerResponse = false
}: {
  activity: RoomAgentActivity
  participant?: RoomParticipant
  expanded?: boolean
  showChevron?: boolean
  showSteerResponse?: boolean
}): React.JSX.Element {
  const label = activityLabel(activity)
  const duration = useRoomActivityDuration(activity)
  const steerResponse = showSteerResponse ? visibleSteerResponse(activity) : ''
  return (
    <span className="block min-w-0">
      <span className="flex w-full items-center gap-2 text-left text-xs">
        <RoomAuthorAvatar actorKind="agent" participant={participant} />
        <span className="shrink-0 font-semibold">@{activity.identity}</span>
        <ActivityIcon activity={activity} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-muted-foreground',
            activity.state === 'failed' && 'text-destructive'
          )}
        >
          · {label}
          {activity.detail ? ` · ${activity.detail}` : ''}
          {duration ? ` · ${duration}` : ''}
        </span>
        {showChevron ? (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
        ) : null}
      </span>
      {steerResponse ? (
        <span className="mt-1 block truncate pl-8 text-xs text-muted-foreground">
          {steerResponse}
        </span>
      ) : null}
    </span>
  )
}

function useRoomActivityDuration(activity: RoomAgentActivity): string {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (activity.state !== 'working') {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activity.startedAt, activity.state])
  return activity.state === 'working' ? formatRoomActivityDuration(activity.startedAt, now) : ''
}

function ActivityIcon({ activity }: { activity: RoomAgentActivity }): React.JSX.Element {
  if (activity.state === 'failed') {
    return <CircleX className="size-3.5 shrink-0 text-destructive" />
  }
  if (activity.state === 'interrupted') {
    return <CircleStop className="size-3.5 shrink-0 text-muted-foreground" />
  }
  const Icon = ACTIVITY_ICONS[activity.kind]
  return Icon ? (
    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <span className="flex size-3.5 shrink-0 items-center justify-center gap-0.5">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-0.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  )
}

function activityLabel(activity: RoomAgentActivity): string {
  if (activity.state === 'failed') {
    return translate('rooms.activity.failed', 'Failed')
  }
  if (activity.state === 'interrupted') {
    return translate('rooms.activity.interrupted', 'Interrupted')
  }
  return ACTIVITY_LABELS[activity.kind]()
}

const ACTIVITY_ICONS: Partial<
  Record<RoomActivityKind, React.ComponentType<{ className?: string }>>
> = {
  reading: FileText,
  searching: Search,
  editing: Pencil,
  command: SquareTerminal,
  web: Globe2
}

const ACTIVITY_LABELS: Record<RoomActivityKind, () => string> = {
  thinking: () => translate('rooms.activity.thinking', 'Thinking'),
  reading: () => translate('rooms.activity.reading', 'Reading file'),
  searching: () => translate('rooms.activity.searching', 'Searching code'),
  editing: () => translate('rooms.activity.editing', 'Editing file'),
  command: () => translate('rooms.activity.command', 'Running command'),
  web: () => translate('rooms.activity.web', 'Searching the web'),
  working: () => translate('rooms.activity.working', 'Working')
}
