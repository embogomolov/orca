/* @vitest-environment happy-dom */

import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QueuedMessageCard } from './QueuedMessageCard'
import { RoomQueuedMessageCard } from '../rooms/RoomQueuedMessageCard'
import { RoomQueueSquareOverlay } from '../rooms/RoomQueueSquare'
import type { RoomData } from '../rooms/use-room-data'
import type { RoomParticipant } from '../../../../shared/rooms'

const mocks = vi.hoisted(() => ({
  readRoomAttachmentPreview: vi.fn(),
  useSortable: vi.fn((_options: unknown) => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    transition: undefined,
    isDragging: false
  }))
}))

vi.mock('../rooms/room-attachment-transfer', () => ({
  readRoomAttachmentPreview: (...args: unknown[]) => mocks.readRoomAttachmentPreview(...args)
}))

vi.mock('@dnd-kit/sortable', async (importOriginal) => ({
  ...(await importOriginal()),
  useSortable: (options: unknown) => mocks.useSortable(options)
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('QueuedMessageCard', () => {
  it('renders short and long formatted previews on one clamped line', () => {
    const { rerender } = render(<QueuedMessageCard item={{ id: 'a', text: 'ping A' }} />)
    expect(screen.getByText('ping A')).toBeTruthy()

    rerender(<QueuedMessageCard item={{ id: 'b', text: `ping B ${'long '.repeat(80)}` }} />)
    const preview = screen.getByText(/ping B/).closest('.truncate')
    expect(preview?.classList.contains('h-4')).toBe(true)
  })

  it('keeps the grip silent and exposes the exact Steer tooltip', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <QueuedMessageCard item={{ id: 'a', text: 'ping A' }} canSteer onSteer={vi.fn()} />
      </TooltipProvider>
    )

    expect(screen.getByLabelText('Reorder queued message')).toBeTruthy()
    expect(screen.queryByText('Reorder queued message')).toBeNull()
    expect(screen.getByText('Submit without interrupting the model')).toBeTruthy()
  })

  it('exposes loaded room image previews to the drag overlay', async () => {
    mocks.readRoomAttachmentPreview.mockResolvedValue({
      mimeType: 'image/png',
      contentBase64: 'aW1hZ2U='
    })
    render(
      <RoomQueuedMessageCard
        data={{ target: { kind: 'local' } } as RoomData}
        message={
          {
            roomId: 'room',
            attachments: [
              { id: 'image-1', fileName: 'image.png', mimeType: 'image/png', byteSize: 5 }
            ]
          } as never
        }
        item={{ id: 'room-message', text: 'with image' }}
      />
    )

    expect(await screen.findByRole('img')).toBeTruthy()
    expect(mocks.useSortable.mock.calls.at(-1)?.[0]).toMatchObject({
      data: {
        item: {
          id: 'room-message',
          images: [{ id: 'image-1', fileName: 'image.png', url: 'data:image/png;base64,aW1hZ2U=' }]
        }
      }
    })
    expect(mocks.readRoomAttachmentPreview).toHaveBeenCalledWith({ kind: 'local' }, 'room', {
      id: 'image-1'
    })
    expect(mocks.readRoomAttachmentPreview).toHaveBeenCalledOnce()
  })

  it('keeps portaled Edit inside an individual queue', async () => {
    render(
      <DndContext>
        <RoomQueueSquareOverlay
          participant={{ id: 'agent', identity: 'agent', displayName: 'Agent' } as RoomParticipant}
          items={[{ id: 'queued', text: 'queued' }]}
          rows={(item) => <QueuedMessageCard item={item} onEdit={vi.fn()} />}
          closing={false}
          onClose={vi.fn()}
          refCallback={() => {}}
        />
      </DndContext>
    )

    fireEvent.pointerDown(screen.getByLabelText('More actions'))
    fireEvent.click(await screen.findByText('Edit'))

    expect(screen.getByRole('textbox')).toBeTruthy()
  })
})
